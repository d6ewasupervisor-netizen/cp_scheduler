'use strict';

/**
 * Push Central Pet schedule day-moves to SAS PROD team-scheduling.
 *
 * SAS ignores scheduled_date on PATCH/PUT for existing visits (verified 2026-07-16).
 * Day moves use the proven HAR pattern:
 *   create (or reuse) dest visit → copy active shifts → soft-delete source shifts
 *   → copy store-field notes (391 → real store) when present.
 *
 * Live writes require LIVE_SCHEDULE_WRITE=1. Dry-run always allowed for admins.
 */

const https = require('https');
const { loadSasSession } = require('./sas-session');
const { PROJECT_ID } = require('./constants');
const { getWeekSchedule, saveWeekSchedule } = require('./shift-day-store');
const { getWeekByStart, dayToDateInWeek, dateToDayOfWeek } = require('./fiscal-calendar');

const SAS_BASE = 'https://prod.sasretail.com';
const API = `${SAS_BASE}/api/v1`;

const TERMINAL_VISIT_STATUSES = new Set(['completed', 'deleted', 'cancelled', 'canceled']);
const BLOCKED_FIELD_STATUSES = new Set(['completed', 'deleted']);

function isLiveScheduleWriteEnabled(env = process.env) {
  const v = env.LIVE_SCHEDULE_WRITE;
  return v === '1' || v === 'true' || v === 'yes';
}

function rows(data) {
  return Array.isArray(data) ? data : data?.results || [];
}

function isLead(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function empId(shift) {
  return shift.employee?.id ?? shift.employee;
}

function empName(shift) {
  const e = shift.employee || shift;
  return e.person?.person_name || e.person_name || e.name || String(empId(shift) || '');
}

function teamSchedulingReferer(cycleId) {
  return `${SAS_BASE}/en/sasretail/activation/cycle-services/${cycleId}/team-scheduling`;
}

function addMinutesToDisplayTime(display, minutes) {
  const m = String(display || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return display;
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  let total = hour * 60 + min + Number(minutes);
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h24 = Math.floor(total / 60);
  const mm = total % 60;
  const ap2 = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${ap2}`;
}

function buildNewVisitId(sourceVisit) {
  const teamId = sourceVisit.team?.id;
  const accountStoreId = sourceVisit.store?.store?.id;
  const projectId = sourceVisit.store?.project?.id;
  const cycleId = sourceVisit.cycle;
  if (!teamId || !accountStoreId || !projectId || !cycleId) {
    throw new Error('Source visit missing team/store/project/cycle for visit_id');
  }
  return String(teamId) + String(accountStoreId) + String(projectId) + String(cycleId);
}

function buildVisitCreateBody(sourceVisit, destDate, { startOffsetMinutes = 0, notes = null } = {}) {
  const shiftStartTime = startOffsetMinutes
    ? addMinutesToDisplayTime(sourceVisit.shift_start_time, startOffsetMinutes)
    : sourceVisit.shift_start_time;
  const body = {
    cycle: sourceVisit.cycle,
    store: { id: sourceVisit.store.id },
    team: {
      id: sourceVisit.team.id,
      name: sourceVisit.team.name,
      teammates: sourceVisit.team.teammates || [],
    },
    scheduled_date: destDate,
    due_by: destDate,
    visit_id: buildNewVisitId(sourceVisit),
    shift_start_time: shiftStartTime,
    shift_end_time: sourceVisit.shift_end_time,
    scheduled_end_time: sourceVisit.scheduled_end_time,
    estimated_shift_hours: sourceVisit.estimated_shift_hours || '8.00',
    current_status: 'active',
    timezone_store: sourceVisit.timezone_store || 'PDT',
  };
  // Notes carry 391→real-store decode text. Must be set at create time —
  // later PATCH of visit.notes / store-field often no-ops (verified 2026-07-16).
  const noteText =
    notes != null && String(notes).trim()
      ? String(notes).slice(0, 1500)
      : sourceVisit.notes != null && String(sourceVisit.notes).trim()
        ? String(sourceVisit.notes).slice(0, 1500)
        : null;
  if (noteText) body.notes = noteText;
  return body;
}

function httpsRequest(urlStr, { method, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload =
      body == null
        ? null
        : typeof body === 'string' || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body);
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: { ...headers },
    };
    if (payload != null) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function buildHeaders(session, { cycleId = null, write = false, visitId = null } = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Token ${session.token}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (session.csrfToken) headers['X-CSRFToken'] = session.csrfToken;
  if (session.cookieHeader) headers.Cookie = session.cookieHeader;
  headers.Origin = SAS_BASE;
  if (cycleId) headers.Referer = teamSchedulingReferer(cycleId);
  else if (visitId) headers.Referer = `${SAS_BASE}/en/field/schedules/${visitId}/schedule/admin`;
  else headers.Referer = `${SAS_BASE}/en/field/`;
  if (write) headers['Content-Type'] = 'application/json;charset=UTF-8';
  return headers;
}

async function sasJson(session, method, apiPath, { body = null, cycleId = null, visitId = null } = {}) {
  const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const res = await httpsRequest(`${API}${apiPath}`, {
    method,
    headers: buildHeaders(session, { cycleId, write, visitId }),
    body,
  });
  if (!res.ok) {
    const detail =
      (res.body && (res.body.message || res.body.error || res.body.detail)) ||
      res.text?.slice(0, 400) ||
      res.status;
    const err = new Error(`SAS ${method} ${apiPath} → ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = res.body;
    throw err;
  }
  return res.body;
}

/**
 * Reschedule one team-scheduling visit to a new date (copy + soft-delete source).
 */
async function rescheduleVisitDay({
  visitId,
  toDate,
  dryRun = true,
  loadSession = loadSasSession,
  startOffsetMinutes = 0,
  maxOffsetAttempts = 4,
  offsetStepMinutes = 3,
  /** Force notes when source lost them (e.g. prior move without note copy). */
  notesOverride = null,
} = {}) {
  if (!visitId) throw new Error('visitId required');
  if (!toDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate))) {
    throw new Error('toDate must be YYYY-MM-DD');
  }

  const session = await loadSession();
  const sourceVisit = await sasJson(session, 'GET', `/team-scheduling/visits/${visitId}/`);
  const fromDate = String(sourceVisit.scheduled_date || '').slice(0, 10);
  const cycleId = sourceVisit.cycle;
  const projectId = sourceVisit.store?.project?.id;

  if (projectId != null && Number(projectId) !== Number(PROJECT_ID)) {
    throw new Error(
      `Visit ${visitId} is project ${projectId}, expected Central Pet ${PROJECT_ID}`
    );
  }

  const status = String(sourceVisit.current_status || '').toLowerCase();
  if (TERMINAL_VISIT_STATUSES.has(status)) {
    return {
      ok: false,
      code: 'visit_terminal',
      visitId,
      fromDate,
      toDate,
      message: `Visit status is ${sourceVisit.current_status} — cannot reschedule`,
    };
  }

  if (fromDate === String(toDate)) {
    return {
      ok: true,
      skipped: true,
      code: 'already_on_date',
      visitId,
      fromDate,
      toDate,
      message: 'Visit already on target date',
    };
  }

  const sourceShifts = rows(
    await sasJson(session, 'GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${visitId}`)
  ).filter((s) => String(s.current_status || '').toLowerCase() === 'active');

  if (!sourceShifts.length) {
    return {
      ok: false,
      code: 'no_active_shifts',
      visitId,
      fromDate,
      toDate,
      message: 'No active shifts on source visit',
    };
  }

  let notes = notesOverride || sourceVisit.notes || null;
  try {
    const sf = await sasJson(session, 'GET', `/field-app/visits/${visitId}/store-field/`, {
      visitId,
    });
    if (!notesOverride && sf?.notes) notes = sf.notes;
  } catch {
    /* keep visit.notes / override */
  }

  const plan = {
    sourceVisitId: Number(visitId),
    fromDate,
    toDate,
    cycleId,
    storeProjectId: sourceVisit.store?.id,
    storeNumber: sourceVisit.store?.store?.number,
    team: sourceVisit.team?.name,
    employees: sourceShifts.map((s) => ({
      id: empId(s),
      name: empName(s),
      lead: isLead(s.is_lead),
      shiftId: s.id,
    })),
    notesPreview: notes ? String(notes).slice(0, 120) : null,
    hasNotes: !!notes,
  };

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      code: 'would_reschedule',
      ...plan,
      message: `Would move visit ${visitId} ${fromDate} → ${toDate} (${sourceShifts.length} shift(s))`,
    };
  }

  if (!isLiveScheduleWriteEnabled()) {
    return {
      ok: false,
      code: 'live_schedule_write_disabled',
      ...plan,
      message: 'LIVE_SCHEDULE_WRITE is off — set to 1 on Railway to apply schedule changes',
    };
  }

  // Create dest visit with notes at create-time (retry start offset on team collision)
  let destVisit = null;
  let usedOffset = startOffsetMinutes;
  let lastCreateErr = null;
  for (let attempt = 0; attempt < maxOffsetAttempts; attempt += 1) {
    usedOffset = startOffsetMinutes + attempt * offsetStepMinutes;
    const body = buildVisitCreateBody(sourceVisit, toDate, {
      startOffsetMinutes: usedOffset,
      notes,
    });
    try {
      destVisit = await sasJson(session, 'POST', '/team-scheduling/visits/', {
        body,
        cycleId,
      });
      lastCreateErr = null;
      break;
    } catch (err) {
      lastCreateErr = err;
      const msg = String(err.message || '');
      if (/already have scheduled|already scheduled/i.test(msg) && attempt < maxOffsetAttempts - 1) {
        continue;
      }
      throw err;
    }
  }
  if (!destVisit?.id) {
    throw lastCreateErr || new Error('Failed to create destination visit');
  }

  const destVisitId = destVisit.id;
  destVisit = await sasJson(session, 'GET', `/team-scheduling/visits/${destVisitId}/`);

  if (String(destVisit.scheduled_date).slice(0, 10) !== String(toDate)) {
    throw new Error(
      `Dest visit ${destVisitId} scheduled_date is ${destVisit.scheduled_date}, expected ${toDate}`
    );
  }

  // Best-effort note repair if create dropped notes (some tenants only accept create-time notes)
  plan.notesOnCreate = !!(destVisit.notes && String(destVisit.notes).trim());
  if (notes && !plan.notesOnCreate) {
    try {
      await sasJson(session, 'PATCH', `/team-scheduling/visits/${destVisitId}/`, {
        body: { notes: String(notes).slice(0, 1500) },
        cycleId,
      });
      const recheck = await sasJson(session, 'GET', `/team-scheduling/visits/${destVisitId}/`);
      plan.notesOnCreate = !!(recheck.notes && String(recheck.notes).trim());
      if (!plan.notesOnCreate) plan.notesError = 'notes not retained after create/PATCH';
    } catch (err) {
      plan.notesError = err.message;
    }
  }

  const existingDestShifts = rows(
    await sasJson(session, 'GET', `/team-scheduling/shifts/?page=1&page_size=50&visit=${destVisitId}`)
  ).filter((s) => String(s.current_status || '').toLowerCase() === 'active');
  const existingEmp = new Set(existingDestShifts.map((s) => Number(empId(s))));

  const added = [];
  const skipped = [];
  const failed = [];

  const ordered = [...sourceShifts].sort(
    (a, b) => (isLead(b.is_lead) ? 1 : 0) - (isLead(a.is_lead) ? 1 : 0)
  );

  for (const s of ordered) {
    const id = Number(empId(s));
    const name = empName(s);
    if (existingEmp.has(id)) {
      skipped.push({ name, reason: 'already on dest' });
      continue;
    }
    try {
      const created = await sasJson(session, 'POST', '/team-scheduling/shifts/', {
        body: {
          home_to_store: true,
          store_to_store: true,
          store_to_home: true,
          calculate_mileage: true,
          visit: String(destVisitId),
          employee: id,
          cycle: Number(destVisit.cycle || cycleId),
          shift_start_time: destVisit.shift_start_time,
          shift_end_time: destVisit.shift_end_time,
          current_status: 'active',
          rate_type: {},
          device_reimbursement: false,
          is_lead: isLead(s.is_lead) ? 'true' : 'false',
        },
        cycleId,
      });
      added.push({ name, lead: isLead(s.is_lead), shiftId: created.id, employeeId: id });
      existingEmp.add(id);
    } catch (err) {
      failed.push({ name, employeeId: id, reason: err.message });
    }
  }

  if (!added.length && failed.length) {
    return {
      ok: false,
      code: 'roster_copy_failed',
      ...plan,
      destVisitId,
      added,
      failed,
      message: 'Could not copy any employees to dest visit',
    };
  }

  // Soft-delete source shifts so field-data no longer shows the old day
  const deletedSource = [];
  const deleteErrors = [];
  for (const s of sourceShifts) {
    try {
      await sasJson(session, 'PATCH', `/team-scheduling/shifts/${s.id}/`, {
        body: { current_status: 'deleted' },
        cycleId,
      });
      deletedSource.push(s.id);
    } catch (err) {
      deleteErrors.push({ shiftId: s.id, reason: err.message });
    }
  }

  // Best-effort: mark empty source visit deleted
  let sourceVisitDeleted = false;
  try {
    await sasJson(session, 'PATCH', `/team-scheduling/visits/${visitId}/`, {
      body: { current_status: 'deleted' },
      cycleId,
    });
    sourceVisitDeleted = true;
  } catch {
    sourceVisitDeleted = false;
  }

  return {
    ok: true,
    dryRun: false,
    code: 'rescheduled',
    ...plan,
    destVisitId,
    startOffsetMinutes: usedOffset,
    added,
    skipped,
    failed,
    deletedSourceShifts: deletedSource,
    deleteErrors,
    sourceVisitDeleted,
    message: `Moved visit ${visitId} → ${destVisitId} (${fromDate} → ${toDate})`,
  };
}

/**
 * Diff local week board vs PROD visit dates; plan or apply moves.
 * @param {object} opts
 * @param {string} opts.weekStart
 * @param {string[]} [opts.shiftIds] limit to these local shift ids
 * @param {boolean} [opts.dryRun=true]
 */
async function pushWeekDayMovesToProd({
  weekStart,
  shiftIds = null,
  dryRun = true,
  loadSession = loadSasSession,
  rescheduleFn = rescheduleVisitDay,
} = {}) {
  if (!weekStart) throw new Error('weekStart required');
  const week = getWeekByStart(weekStart);
  if (!week) throw new Error(`Unknown fiscal week ${weekStart}`);

  const stored = getWeekSchedule(weekStart);
  if (!stored?.shifts?.length) {
    throw new Error('No local shift-day schedule for week — Sync from PROD first');
  }

  let candidates = stored.shifts.filter((s) => s.visitId);
  if (shiftIds && shiftIds.length) {
    const want = new Set(shiftIds.map(String));
    candidates = candidates.filter((s) => want.has(String(s.id)));
  }

  const session = await loadSession();
  const results = [];
  const toMove = [];

  for (const shift of candidates) {
    const visitId = shift.visitId;
    const localDate = String(shift.date || '').slice(0, 10);
    if (!localDate) continue;

    let prodVisit;
    try {
      prodVisit = await sasJson(session, 'GET', `/team-scheduling/visits/${visitId}/`);
    } catch (err) {
      results.push({
        ok: false,
        code: 'visit_fetch_failed',
        shiftId: shift.id,
        visitId,
        repKey: shift.repKey,
        actualStore: shift.actualStore,
        localDate,
        message: err.message,
      });
      continue;
    }

    const prodDate = String(prodVisit.scheduled_date || '').slice(0, 10);
    const prodStatus = String(prodVisit.current_status || '').toLowerCase();
    const fieldStatus = String(shift.visitStatus || '').toLowerCase();

    if (prodDate === localDate) {
      results.push({
        ok: true,
        skipped: true,
        code: 'in_sync',
        shiftId: shift.id,
        visitId,
        repKey: shift.repKey,
        actualStore: shift.actualStore,
        localDate,
        prodDate,
        message: 'Local date already matches PROD',
      });
      continue;
    }

    // Completed / deleted: not actionable for day-move (local date may use executed_date)
    if (TERMINAL_VISIT_STATUSES.has(prodStatus) || BLOCKED_FIELD_STATUSES.has(fieldStatus)) {
      results.push({
        ok: true,
        skipped: true,
        code: 'status_not_movable',
        shiftId: shift.id,
        visitId,
        repKey: shift.repKey,
        actualStore: shift.actualStore,
        localDate,
        prodDate,
        prodStatus: prodVisit.current_status,
        fieldStatus: shift.visitStatus,
        message: `Skip — visit status ${prodVisit.current_status || shift.visitStatus} (not moved)`,
      });
      continue;
    }

    // In-progress: refuse for safety (partial day already worked)
    if (prodStatus === 'in-progress' || fieldStatus === 'in-progress') {
      results.push({
        ok: true,
        skipped: true,
        code: 'in_progress_skip',
        shiftId: shift.id,
        visitId,
        repKey: shift.repKey,
        actualStore: shift.actualStore,
        localDate,
        prodDate,
        message: 'Skip — in-progress (finish or abandon in PROD before day-move)',
      });
      continue;
    }

    toMove.push({ shift, visitId, localDate, prodDate });
  }

  for (const item of toMove) {
    try {
      // Prefer notes already on PROD; if missing, rebuild 391 decode note from board
      let notesOverride = null;
      if (
        item.shift.redirected ||
        (item.shift.actualStore != null &&
          item.shift.scheduledStore != null &&
          Number(item.shift.actualStore) !== Number(item.shift.scheduledStore))
      ) {
        notesOverride =
          item.shift.rawNote ||
          `***WRITE ORDER*** THIS IS FOR STORE ${item.shift.actualStore}***WRITE ORDER***`;
      } else if (item.shift.rawNote) {
        notesOverride = item.shift.rawNote;
      }

      const r = await rescheduleFn({
        visitId: item.visitId,
        toDate: item.localDate,
        dryRun,
        loadSession: async () => session,
        notesOverride,
      });
      results.push({
        ...r,
        shiftId: item.shift.id,
        repKey: item.shift.repKey,
        actualStore: item.shift.actualStore,
        localDate: item.localDate,
        prodDate: item.prodDate,
      });
      // Update local board visitId when live create succeeded
      if (!dryRun && r.ok && r.destVisitId) {
        const shift = stored.shifts.find((s) => String(s.id) === String(item.shift.id));
        if (shift) {
          shift.visitId = r.destVisitId;
          shift.id = `prod-${r.destVisitId}-${shift.shiftId || 'x'}`;
          shift.rawNote = `rescheduled from ${item.prodDate}`;
        }
      }
    } catch (err) {
      results.push({
        ok: false,
        code: 'reschedule_error',
        shiftId: item.shift.id,
        visitId: item.visitId,
        repKey: item.shift.repKey,
        actualStore: item.shift.actualStore,
        localDate: item.localDate,
        prodDate: item.prodDate,
        message: err.message,
      });
    }
  }

  if (!dryRun && toMove.length) {
    saveWeekSchedule(weekStart, {
      ...stored,
      lastSchedulePushAt: new Date().toISOString(),
      matchStale: true,
    });
  }

  const moved = results.filter((r) => r.code === 'rescheduled' || r.code === 'would_reschedule');
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.skipped);

  return {
    ok: failed.length === 0,
    dryRun: !!dryRun,
    liveEnabled: isLiveScheduleWriteEnabled(),
    weekStart,
    week,
    candidateCount: candidates.length,
    toMoveCount: toMove.length,
    movedCount: moved.length,
    failedCount: failed.length,
    skippedCount: skipped.length,
    results,
  };
}

/**
 * Admin helper: move one local shift day (updates board) then optional PROD push.
 */
async function moveShiftDayAndOptionallyPush({
  weekStart,
  shiftId,
  dayOfWeek,
  pushToProd = false,
  dryRun = true,
  updateLocalFn,
} = {}) {
  if (!updateLocalFn) throw new Error('updateLocalFn required');
  const local = updateLocalFn({ weekStart, shiftId, dayOfWeek });
  if (!pushToProd) {
    return { ok: true, localOnly: true, shift: local, prod: null };
  }
  const prod = await pushWeekDayMovesToProd({
    weekStart,
    shiftIds: [shiftId],
    dryRun,
  });
  return { ok: prod.ok, localOnly: false, shift: local, prod };
}

module.exports = {
  isLiveScheduleWriteEnabled,
  rescheduleVisitDay,
  pushWeekDayMovesToProd,
  moveShiftDayAndOptionallyPush,
  buildVisitCreateBody,
  buildNewVisitId,
  teamSchedulingReferer,
  addMinutesToDisplayTime,
};
