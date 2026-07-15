'use strict';

const { loadSasSession } = require('./sas-session');
const { PROJECT_ID } = require('./constants');
const { decodeD8Note } = require('./d8-note-decoder');
const { calcPeriodMileage } = require('./period-mileage');
const { homeMatrix, storeMatrix } = require('./day-mileage');

const DELTA_THRESHOLD_MILES = 2.0;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Read-only SAS client helpers. Injectable for tests.
 */
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
    const detail =
      body && typeof body === 'object'
        ? body.error_message || body.detail || body.message || JSON.stringify(body).slice(0, 200)
        : String(body || '').slice(0, 200);
    throw new Error(`SAS ${res.status} ${path}: ${detail}`);
  }
  return body;
}

function asRows(body) {
  return Array.isArray(body) ? body : body?.results || [];
}

function statusIsDeleted(status) {
  return String(status || '').toLowerCase() === 'deleted';
}

function isCompletedVisit(status) {
  return String(status || '').toLowerCase() === 'completed';
}

function hasPunch(emp) {
  return Boolean(emp?.actual_start_time);
}

function travelType(record) {
  const start = String(record?.start_location_type || '').toUpperCase();
  const end = String(record?.end_location_type || '').toUpperCase();
  if (start === 'H' && end === 'S') return 'H-S';
  if (start === 'S' && end === 'S') return 'S-S';
  if (start === 'S' && end === 'H') return 'S-H';
  return `${start}-${end}`;
}

function matrixMilesForLeg(eid, leg) {
  if (!leg || leg.miles == null) return null;
  if (leg.from === 'home' || leg.to === 'home') {
    const store = leg.from === 'home' ? leg.to : leg.from;
    const rep = homeMatrix.reps[eid];
    if (!rep) return null;
    return Object.prototype.hasOwnProperty.call(rep.miles, String(store))
      ? rep.miles[String(store)]
      : null;
  }
  const key = `${leg.from}-${leg.to}`;
  return Object.prototype.hasOwnProperty.call(storeMatrix.matrix, key)
    ? storeMatrix.matrix[key]
    : null;
}

function expectedLegType(leg) {
  if (leg.from === 'home') return 'H-S';
  if (leg.to === 'home') return 'S-H';
  return 'S-S';
}

/**
 * Compare SAS travel_records distances to matrix miles for decoded-store legs.
 * Does not overwrite either value — returns deltas only.
 *
 * Matching rules (avoid cross-visit false positives):
 *   H-S → travel on the day's first store visit (leg.to)
 *   S-H → travel on the day's last store visit (leg.from)
 *   S-S → travel on the destination visit (leg.to)
 * Skip empty/zero SAS distances (placeholder travel rows).
 */
function reconcileTravelRecords(eid, dayResult, dayVisits = []) {
  const deltas = [];
  if (!dayResult?.legs?.length) return deltas;

  const byStore = new Map();
  for (const v of dayVisits) {
    const key = String(v.store_number);
    if (!byStore.has(key)) byStore.set(key, []);
    byStore.get(key).push(v);
  }

  const seen = new Set();
  for (const leg of dayResult.legs) {
    const type = expectedLegType(leg);
    const matrixMiles = matrixMilesForLeg(eid, leg);
    if (matrixMiles == null) continue;

    const anchorStore =
      type === 'H-S' ? String(leg.to) : type === 'S-H' ? String(leg.from) : String(leg.to);
    const candidates = byStore.get(anchorStore) || [];

    for (const v of candidates) {
      for (const tr of v.travel_records || []) {
        if (travelType(tr) !== type) continue;
        const sasMiles = Number(tr.distance);
        if (!Number.isFinite(sasMiles) || sasMiles <= 0) continue;
        const key = `${type}|${leg.from}|${leg.to}|${v.visit_id}|${tr.shift_id || ''}|${sasMiles}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const delta = Math.round(Math.abs(sasMiles - matrixMiles) * 10) / 10;
        if (delta > DELTA_THRESHOLD_MILES) {
          deltas.push({
            type,
            from: leg.from,
            to: leg.to,
            matrixMiles,
            sasMiles,
            delta,
            visitId: v.visit_id || null,
            shiftId: tr.shift_id || v.shift_id || null,
            decodedStore: v.store_number,
            scheduledStore: v.scheduled_store_number,
          });
        }
      }
    }
  }
  return deltas;
}

/**
 * Build normalized punch rows for calcPeriodMileage from enriched visit payloads.
 */
function toMileageVisits(enriched) {
  const out = [];
  for (const visit of enriched) {
    const decoded = visit.decoded;
    const storeNum = decoded?.actualStore;
    for (const emp of visit.employees || []) {
      if (emp.no_show) continue;
      if (!emp.workday_given_id) continue;
      if (!hasPunch(emp) && !isCompletedVisit(visit.visitStatus)) continue;

      out.push({
        visit_id: visit.visitId,
        shift_id: emp.shift_id,
        workday_given_id: String(emp.workday_given_id),
        store_number: storeNum,
        scheduled_store_number: visit.scheduledStore,
        redirected: Boolean(decoded?.redirected),
        actual_start_time: emp.actual_start_time,
        executed_date: emp.executed_date || null,
        scheduled_date: visit.scheduledDate,
        current_status: hasPunch(emp) || isCompletedVisit(visit.visitStatus) ? 'completed' : visit.visitStatus,
        travel_records: visit.shiftDetail?.travel_records || [],
        notes: visit.storeField?.notes || '',
        decoded,
      });
    }
  }
  return out;
}

function createVisitCache(seed) {
  if (seed && typeof seed.get === 'function' && typeof seed.set === 'function') {
    return seed;
  }
  const map = seed instanceof Map ? seed : new Map(Object.entries(seed || {}));
  return {
    get: (id) => map.get(String(id)),
    set: (id, value) => {
      map.set(String(id), value);
      return value;
    },
    has: (id) => map.has(String(id)),
    size: () => map.size,
    raw: map,
  };
}

/**
 * Pull completed punches for a date range and compute period mileage per rep.
 *
 * Read-only. Sequential SAS calls only. Caches {employees, storeField, shiftDetail}
 * by visit id once completed / punched.
 *
 * @param {Object} opts
 * @param {string} opts.startDate YYYY-MM-DD
 * @param {string} opts.endDate YYYY-MM-DD
 * @param {string|number} opts.supervisorId Workday supervisor id (required)
 * @param {string[]} [opts.eids] Workday EIDs to include (default: all home-matrix reps)
 * @param {boolean} [opts.includeTravel=true] fetch v2 shift travel for cross-check
 * @param {number} [opts.projectId=9293]
 * @param {Map|Object} [opts.cache] optional visit cache
 * @param {Function} [opts.sasGet] injectable GET
 * @param {Function} [opts.loadSession] injectable session loader
 */
async function pullPeriodMileage(opts = {}) {
  const {
    startDate,
    endDate,
    supervisorId,
    eids = Object.keys(homeMatrix.reps),
    includeTravel = true,
    projectId = PROJECT_ID,
    cache: cacheSeed,
    sasGet = defaultSasGet,
    loadSession = loadSasSession,
  } = opts;

  if (!startDate || !endDate) throw new Error('startDate and endDate are required');
  if (supervisorId == null || supervisorId === '') {
    throw new Error('supervisorId is required (pass via opts — never hard-coded)');
  }

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

  const enriched = [];
  for (const row of fieldVisits) {
    const visitId = row.id;
    const scheduledStore = Number(row.store_name?.number ?? row.store_number) || null;
    const visitStatus = row.current_status;

    let cached = cache.get(visitId);
    if (!cached) {
      const employees = asRows(await sasGet(token, `/field-app/visits/${visitId}/employees/`));
      let storeField;
      try {
        storeField = await sasGet(token, `/field-app/visits/${visitId}/store-field/`);
      } catch {
        storeField = { notes: '', store: { number: scheduledStore } };
      }

      // Fall back to shift-complete when employees is empty
      let empList = employees;
      if (!empList.length) {
        const sc = await sasGet(token, `/field-app/visits/${visitId}/shift-complete/`);
        empList = sc?.employees || [];
      }

      let shiftDetail = null;
      const shiftId = empList.find((e) => e.shift_id)?.shift_id;
      if (includeTravel && shiftId) {
        try {
          shiftDetail = await sasGet(token, `/api/v2/field-app/shifts/${shiftId}/`);
        } catch {
          shiftDetail = null;
        }
      }

      const payload = {
        visitId,
        scheduledDate: row.scheduled_date,
        scheduledStore,
        visitStatus,
        employees: empList,
        storeField,
        shiftDetail,
        fetchedAt: new Date().toISOString(),
      };

      const punched = empList.some(hasPunch);
      if (isCompletedVisit(visitStatus) || punched) {
        cache.set(visitId, payload);
      }
      cached = payload;
    }

    const notes = cached.storeField?.notes || '';
    const scheduled =
      cached.storeField?.store?.number ?? cached.scheduledStore ?? scheduledStore;
    const decoded = decodeD8Note(notes, scheduled);

    enriched.push({
      ...cached,
      scheduledStore: scheduled,
      decoded,
    });
  }

  const mileageVisits = toMileageVisits(enriched);
  const byEid = {};
  const deltas = [];

  for (const eid of eids.map(String)) {
    const period = calcPeriodMileage(eid, mileageVisits, startDate, endDate, {
      completedOnly: true,
    });

    const visitsForEid = mileageVisits.filter((v) => String(v.workday_given_id) === eid);
    for (const day of period.days) {
      const dayVisits = visitsForEid.filter((v) => {
        const d = v.executed_date || v.scheduled_date;
        return d === day.date;
      });
      const dayDeltas = reconcileTravelRecords(eid, day, dayVisits);
      if (dayDeltas.length) {
        day.travelDeltas = dayDeltas;
        deltas.push(...dayDeltas.map((d) => ({ ...d, eid, date: day.date })));
      }
    }

    byEid[eid] = {
      ...period,
      name: homeMatrix.reps[eid]?.name || null,
    };
  }

  return {
    startDate,
    endDate,
    projectId,
    supervisorId: String(supervisorId),
    visitCount: fieldVisits.length,
    cachedVisitCount: cache.size(),
    reps: byEid,
    travelDeltas: deltas,
    cache,
    // Enriched rows kept for debugging / UI — PII-free aside from names already public
    visits: mileageVisits.map((v) => ({
      visit_id: v.visit_id,
      shift_id: v.shift_id,
      workday_given_id: v.workday_given_id,
      store_number: v.store_number,
      scheduled_store_number: v.scheduled_store_number,
      redirected: v.redirected,
      executed_date: v.executed_date,
      scheduled_date: v.scheduled_date,
      actual_start_time: v.actual_start_time,
      current_status: v.current_status,
    })),
  };
}

module.exports = {
  pullPeriodMileage,
  decodeD8Note,
  toMileageVisits,
  reconcileTravelRecords,
  travelType,
  expectedLegType,
  matrixMilesForLeg,
  createVisitCache,
  DELTA_THRESHOLD_MILES,
  defaultSasGet,
};
