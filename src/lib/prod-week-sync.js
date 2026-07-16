'use strict';

/**
 * Pull Central Pet week board from SAS PROD (cycle + field-data) into
 * shift-day-store. Complements xlsx ingest — does not write schedule mutations
 * back to PROD (that remains planning handoff + sas-prod-shift-management-har).
 *
 * Uses the same field-data + store-field note decode path as visit-matcher so
 * 391→actual store redirects stay consistent.
 */

const { loadSasSession } = require('./sas-session');
const { PROJECT_ID } = require('./constants');
const { decodeD8Note } = require('./d8-note-decoder');
const { shiftRepByWorkdayId } = require('./d8-shift-reps');
const { resolveCycle } = require('./prod-schedule');
const { saveWeekSchedule, getWeekSchedule } = require('./shift-day-store');
const { getWeekByStart, dateToDayOfWeek } = require('./fiscal-calendar');

const DEFAULT_PAGE_SIZE = 50;

async function defaultSasGet(token, urlPath, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  const path = urlPath.startsWith('/api/')
    ? urlPath
    : `/api/v1${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`;
  const url = `https://prod.sasretail.com${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${token}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`SAS ${res.status} ${path}`);
  return body;
}

function asRows(body) {
  return Array.isArray(body) ? body : body?.results || [];
}

/**
 * Collect prod visit/employee rows for a date range (same core as matchVisits).
 */
async function collectProdRows({
  startDate,
  endDate,
  supervisorId,
  projectId = PROJECT_ID,
  sasGet = defaultSasGet,
  loadSession = loadSasSession,
} = {}) {
  if (!startDate || !endDate) throw new Error('startDate and endDate required');
  if (supervisorId == null || supervisorId === '') throw new Error('supervisorId required');

  const { token } = await loadSession();
  const fieldVisits = [];
  let page = 1;
  for (;;) {
    const batch = asRows(
      await sasGet(token, '/operations/field-data/', {
        customer_id: 2,
        page,
        page_size: DEFAULT_PAGE_SIZE,
        program_id: 134,
        project_id: projectId,
        scheduled_dt_from: startDate,
        scheduled_dt_to: endDate,
        supervisor_id: supervisorId,
      })
    );
    for (const row of batch) {
      if (String(row.current_status || '').toLowerCase() === 'deleted') continue;
      fieldVisits.push(row);
    }
    if (batch.length < DEFAULT_PAGE_SIZE) break;
    page += 1;
  }

  const prodRows = [];
  const unmappedEmployees = [];

  for (const row of fieldVisits) {
    const visitId = row.id;
    let storeField;
    try {
      storeField = await sasGet(token, `/field-app/visits/${visitId}/store-field/`);
    } catch {
      storeField = { notes: '', store: { number: row.store_name?.number } };
    }

    let employees = [];
    try {
      employees = asRows(await sasGet(token, `/field-app/visits/${visitId}/employees/`));
    } catch {
      employees = [];
    }
    if (!employees.length) {
      try {
        const sc = await sasGet(token, `/field-app/visits/${visitId}/shift-complete/`);
        employees = sc?.employees || [];
      } catch {
        employees = [];
      }
    }
    employees = employees.filter((e) => !e.no_show);

    const notes = storeField?.notes || '';
    const scheduled = storeField?.store?.number ?? row.store_name?.number;
    const decoded = decodeD8Note(notes, scheduled);

    for (const emp of employees) {
      const rep = shiftRepByWorkdayId(emp.workday_given_id);
      if (!rep) {
        unmappedEmployees.push({
          visitId,
          workdayGivenId: emp.workday_given_id,
          name: emp.name || emp.preferred_name || null,
          date: emp.executed_date || row.scheduled_date,
        });
        continue;
      }
      prodRows.push({
        visitId,
        date: emp.executed_date || row.scheduled_date,
        scheduledStore: Number(scheduled) || null,
        actualStore: decoded.actualStore,
        redirected: !!decoded.redirected,
        writeOrder: decoded.writeOrder !== false,
        workLoad: !!decoded.workLoad,
        workdayGivenId: String(emp.workday_given_id),
        repKey: rep.repKey,
        empName: rep.name || emp.name || rep.repKey,
        shiftId: emp.shift_id || null,
        visitStatus: row.current_status,
        shiftStart: emp.shift_start_time || null,
        shiftEnd: emp.shift_end_time || null,
      });
    }
  }

  return { token, prodRows, unmappedEmployees, fieldVisitCount: fieldVisits.length };
}

function prodRowsToShifts(prodRows) {
  return prodRows
    .filter((p) => p.repKey && p.date && p.actualStore)
    .map((p, i) => ({
      id: `prod-${p.visitId}-${p.shiftId || i}`,
      repKey: p.repKey,
      empNum: p.workdayGivenId,
      empName: p.empName,
      date: p.date,
      dayOfWeek: dateToDayOfWeek(p.date),
      scheduledStore: p.scheduledStore,
      actualStore: p.actualStore,
      writeOrder: p.writeOrder !== false,
      workLoad: !!p.workLoad,
      picksDay: null,
      delivery: null,
      shiftStart: p.shiftStart,
      shiftEnd: p.shiftEnd,
      rawNote: p.redirected ? `redirected from ${p.scheduledStore}` : null,
      redirected: !!p.redirected,
      visitId: p.visitId,
      shiftId: p.shiftId,
      visitStatus: p.visitStatus,
      source: 'prod',
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.repKey).localeCompare(b.repKey));
}

/**
 * Sync one fiscal week from PROD into shift-day-store.
 * @param {object} opts
 * @param {string} opts.weekStart
 * @param {string|number} opts.supervisorId
 * @param {boolean} [opts.replace=true] — if false, only update when empty
 */
async function syncWeekFromProd(opts = {}) {
  const {
    weekStart,
    supervisorId,
    projectId = PROJECT_ID,
    replace = true,
    sasGet = defaultSasGet,
    loadSession = loadSasSession,
  } = opts;

  if (!weekStart) throw new Error('weekStart required');
  if (supervisorId == null || supervisorId === '') throw new Error('supervisorId required');

  const week = getWeekByStart(weekStart);
  if (!week) throw new Error(`Unknown fiscal week ${weekStart}`);

  const existing = getWeekSchedule(weekStart);
  if (!replace && existing?.shifts?.length) {
    return {
      ok: true,
      skipped: true,
      reason: 'week_already_has_shifts',
      week,
      shiftCount: existing.shifts.length,
    };
  }

  const { token, prodRows, unmappedEmployees, fieldVisitCount } = await collectProdRows({
    startDate: week.start,
    endDate: week.end,
    supervisorId,
    projectId,
    sasGet,
    loadSession,
  });

  let cycle = null;
  try {
    cycle = await resolveCycle(token, week.start, week.end);
  } catch {
    cycle = null;
  }

  const shifts = prodRowsToShifts(prodRows);
  const saved = saveWeekSchedule(weekStart, {
    weekEnd: week.end,
    weekLabel: week.label,
    source: 'prod-sync',
    meta: {
      syncedAt: new Date().toISOString(),
      supervisorId: String(supervisorId),
      projectId,
      fieldVisitCount,
      prodRowCount: prodRows.length,
      unmappedEmployeeCount: unmappedEmployees.length,
      cycleId: cycle?.id ?? null,
      cycleName: cycle?.name ?? null,
    },
    flags: unmappedEmployees.slice(0, 50).map((u) => ({
      type: 'unmapped_employee',
      ...u,
    })),
    shifts,
    matchStale: false,
    lastSyncedAt: new Date().toISOString(),
    lastSyncedFrom: 'prod',
  });

  return {
    ok: true,
    week,
    cycle: cycle ? { id: cycle.id, name: cycle.name } : null,
    shiftCount: shifts.length,
    fieldVisitCount,
    unmappedEmployeeCount: unmappedEmployees.length,
    unmappedEmployees: unmappedEmployees.slice(0, 20),
    updatedAt: saved.updatedAt,
    source: 'prod-sync',
  };
}

module.exports = {
  syncWeekFromProd,
  collectProdRows,
  prodRowsToShifts,
  defaultSasGet,
};
