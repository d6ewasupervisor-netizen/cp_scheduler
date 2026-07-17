'use strict';

const { loadSasSession } = require('./sas-session');
const { PROJECT_ID } = require('./constants');
const { decodeD8Note } = require('./d8-note-decoder');
const { shiftRepByWorkdayId } = require('./d8-shift-reps');
const { getWeekSchedule } = require('./shift-day-store');
const { createVisitCache } = require('./punch-mileage-puller');

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
  if (!res.ok) {
    throw new Error(`SAS ${res.status} ${path}`);
  }
  return body;
}

function asRows(body) {
  return Array.isArray(body) ? body : body?.results || [];
}

function statusIsDeleted(status) {
  return String(status || '').toLowerCase() === 'deleted';
}

/**
 * Read-only matcher: app Shift Day shifts ↔ prod field-data visits.
 *
 * Match key: repKey (via workday_given_id) + date + decoded actualStore.
 * Ambiguity: two+ candidates → both ambiguous (never auto-pick).
 */
async function matchVisits(opts = {}) {
  const {
    startDate,
    endDate,
    supervisorId,
    weekStart = startDate,
    projectId = PROJECT_ID,
    cache: cacheSeed,
    sasGet = defaultSasGet,
    loadSession = loadSasSession,
    appShifts = null,
  } = opts;

  if (!startDate || !endDate) throw new Error('startDate and endDate required');
  if (supervisorId == null || supervisorId === '') {
    throw new Error('supervisorId is required (via opts)');
  }

  const shifts =
    appShifts ||
    (getWeekSchedule(weekStart)?.shifts || []).filter(
      (s) => s.date && s.date >= startDate && s.date <= endDate && s.repKey && s.actualStore
    );

  const { token } = await loadSession();
  const cache = createVisitCache(cacheSeed);

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
      if (statusIsDeleted(row.current_status)) continue;
      fieldVisits.push(row);
    }
    if (batch.length < DEFAULT_PAGE_SIZE) break;
    page += 1;
  }

  const prodRows = [];
  for (const row of fieldVisits) {
    const visitId = row.id;
    let cached = cache.get(visitId);
    if (!cached) {
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

      cached = {
        visitId,
        scheduledDate: row.scheduled_date,
        scheduledStore: Number(row.store_name?.number) || null,
        visitStatus: row.current_status,
        storeField,
        employees,
        fetchedAt: new Date().toISOString(),
      };

      if (String(row.current_status).toLowerCase() === 'completed' || employees.some((e) => e.actual_start_time)) {
        cache.set(visitId, cached);
      }
    }

    const notes = cached.storeField?.notes || '';
    const scheduled =
      cached.storeField?.store?.number ?? cached.scheduledStore;
    const decoded = decodeD8Note(notes, scheduled);

    for (const emp of cached.employees || []) {
      if (emp.no_show) continue;
      const rep = shiftRepByWorkdayId(emp.workday_given_id);
      if (!rep) continue;
      prodRows.push({
        visitId,
        date: emp.executed_date || cached.scheduledDate,
        scheduledStore: Number(scheduled) || null,
        actualStore: decoded.actualStore,
        redirected: decoded.redirected,
        workdayGivenId: String(emp.workday_given_id),
        repKey: rep.repKey,
        shiftId: emp.shift_id || null,
        visitStatus: cached.visitStatus,
      });
    }
  }

  const matchKey = (repKey, date, store) => `${repKey}|${date}|${store}`;

  const prodByKey = new Map();
  for (const p of prodRows) {
    if (!p.date || !p.actualStore || !p.repKey) continue;
    const k = matchKey(p.repKey, p.date, p.actualStore);
    if (!prodByKey.has(k)) prodByKey.set(k, []);
    prodByKey.get(k).push(p);
  }

  const appByKey = new Map();
  for (const s of shifts) {
    const k = matchKey(s.repKey, s.date, s.actualStore);
    if (!appByKey.has(k)) appByKey.set(k, []);
    appByKey.get(k).push(s);
  }

  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  const orphaned = [];
  const usedProd = new Set();
  const usedApp = new Set();

  for (const [k, appList] of appByKey) {
    const prodList = prodByKey.get(k) || [];
    if (prodList.length === 1 && appList.length === 1) {
      matched.push({
        status: 'matched',
        key: k,
        appShift: appList[0],
        prodVisit: prodList[0],
      });
      usedApp.add(appList[0].id);
      usedProd.add(prodList[0].visitId);
    } else if (prodList.length === 0) {
      for (const s of appList) {
        unmatched.push({
          status: 'unmatched',
          key: k,
          appShift: s,
          prodVisit: null,
        });
        usedApp.add(s.id);
      }
    } else {
      // Ambiguity: multiple prod and/or multiple app for same key — flag all, never guess
      for (const s of appList) {
        ambiguous.push({
          status: 'ambiguous',
          key: k,
          appShift: s,
          candidates: prodList,
        });
        usedApp.add(s.id);
      }
      for (const p of prodList) usedProd.add(p.visitId);
    }
  }

  for (const p of prodRows) {
    if (usedProd.has(p.visitId)) continue;
    orphaned.push({
      status: 'orphaned',
      prodVisit: p,
      appShift: null,
    });
  }

  return {
    startDate,
    endDate,
    weekStart,
    supervisorId: String(supervisorId),
    summary: {
      appShifts: shifts.length,
      prodVisits: prodRows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      orphaned: orphaned.length,
    },
    matched,
    unmatched,
    ambiguous,
    orphaned,
    cache,
  };
}

function statusForShift(matchResult, shiftId) {
  if (!matchResult) return { status: 'unknown' };
  const m = matchResult.matched.find((x) => String(x.appShift.id) === String(shiftId));
  if (m) {
    return {
      status: 'matched',
      visitId: m.prodVisit.visitId,
      scheduledStore: m.prodVisit.scheduledStore,
      actualStore: m.prodVisit.actualStore,
      visitStatus: m.prodVisit.visitStatus || m.appShift.visitStatus || null,
    };
  }
  const a = matchResult.ambiguous.find((x) => String(x.appShift.id) === String(shiftId));
  if (a) {
    return {
      status: 'ambiguous',
      candidates: a.candidates.map((c) => c.visitId),
      visitStatus: a.appShift?.visitStatus || null,
    };
  }
  const u = matchResult.unmatched.find((x) => String(x.appShift.id) === String(shiftId));
  if (u) {
    return {
      status: 'unmatched',
      visitStatus: u.appShift?.visitStatus || null,
    };
  }
  return { status: 'unknown' };
}

module.exports = {
  matchVisits,
  statusForShift,
  defaultSasGet,
};
