'use strict';

/**
 * Stage 4 — prod overlay transmitter. DRY-RUN ONLY.
 *
 * transmitVisit() ASSEMBLES the ordered write sequence prod would need for one
 * sealed visit — it never sends any of it. Every call in the output carries a
 * sourceRef citing the exact HAR entry (central pet shifts.json, visit 27000510,
 * shift 44390825, survey 115502 — see data/har-evidence-27000510.json) or the
 * relevant Cursor skill section that justifies its endpoint/method/payload shape.
 *
 * Two categories of evidence, both surfaced explicitly rather than blurred:
 *  - Directly observed: HAR response bodies that echo the request fields back
 *    (e.g. survey answers, category-reset completion, photo uploads).
 *  - Reconstructed: Chrome's HAR export never captured POST/PATCH request
 *    bodies (confirmed empty postData.params on every write call — the same
 *    gap the sas-prod-shift-management-har skill already documents). Calls
 *    whose payload shape is inferred from response echoes rather than a
 *    literal captured request are marked reconstructed: true, per T's
 *    2026-07-13 sign-off to reconstruct-and-flag rather than block entirely.
 *
 * Reads (GETs) run live and read-only during assembly, mirroring
 * punch-mileage-puller.js / visit-matcher.js — needed to resolve real ids and
 * to validate exact-string matches (reason text, survey option text) before a
 * single write is assembled. Writes are NEVER executed here; sasGet is the
 * only network side effect.
 */

const fs = require('fs');
const path = require('path');
const { loadSasSession } = require('./sas-session');
const { serviceSurvey, surveyVisibility, CATEGORY_PHOTO_TARGETS } = require('./visit-flow');
const writeReasons = require('../../data/sas-write-reasons.json');
const storeTimezones = require('../../data/store-timezones.json');
const d8ShiftReps = require('../../data/d8-shift-reps.json');

const REPO_ROOT = path.join(__dirname, '../..');
const BASE = 'https://prod.sasretail.com';
const SURVEY_NAME = 'Central Pet Service Survey';
const REDACTED_TOKEN = '{{REDACTED}}';

/* ---------- Store-local wall-clock times for shift actual_*_time fields ---------- *
 * HAR ground truth (visit 27000510, entry #137/#171): actual_start_time is
 * LOCAL STORE TIME "06:01:00" (PDT), NOT a UTC ISO slice "13:01:00".
 * travel_records.end_time stays full UTC ISO; actual_start_date is already
 * correct as YYYY-MM-DD from the sealed timestamp — do not change those. */
function resolveStoreTimezone(storeNum) {
  if (storeNum == null || storeNum === '') return null;
  return storeTimezones.stores?.[String(storeNum)] || null;
}

/**
 * Convert a sealed UTC ISO timestamp to HH:mm:ss in the store's IANA timezone.
 * Uses Intl.DateTimeFormat (no extra deps); DST-correct via the timezone map.
 */
function toStoreLocalTime(iso, storeNum) {
  if (!iso) return null;
  const timeZone = resolveStoreTimezone(storeNum);
  if (!timeZone) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  if (hour == null || minute == null || second == null) return null;
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

/**
 * 12-hour store-local clock string (e.g. "1:17 AM") for the visit-start PATCH
 * body. prod completion.har's start call sends actual_start_time in this exact
 * format. Normalizes any narrow/non-breaking space Intl may emit to a plain space.
 */
function toStoreLocalTime12h(iso, storeNum) {
  if (!iso) return null;
  const timeZone = resolveStoreTimezone(storeNum);
  if (!timeZone) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(date)
    .replace(/\s/g, ' ');
}

/* ---------- Injectable read-only GET (same shape as existing libs) ---------- */

async function defaultSasGet(token, urlPath, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  // /api/... as-is; /v2/... → /api/v2/...; else → /api/v1/...
  let p;
  if (urlPath.startsWith('/api/')) p = urlPath;
  else if (urlPath.startsWith('/v2/')) p = `/api${urlPath}`;
  else p = `/api/v1${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`;
  const url = `${BASE}${p}${qs.toString() ? `?${qs}` : ''}`;
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
  if (!res.ok) throw new Error(`SAS ${res.status} ${p}`);
  return body;
}

function asRows(body) {
  return Array.isArray(body) ? body : body?.results || [];
}

function authHeaders() {
  return {
    Accept: 'application/json',
    Authorization: `Token ${REDACTED_TOKEN}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

/* ---------- Default photo loader (base64 + metadata, matches category-reset PATCH shape) ---------- */

function defaultReadPhotoBase64(photoRecord) {
  if (!photoRecord?.path) return null;
  const abs = path.join(REPO_ROOT, photoRecord.path);
  if (!fs.existsSync(abs)) return null;
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).replace(/^\./, '').toLowerCase() || 'jpg';
  const filetype = ext === 'png' ? 'image/png' : 'image/jpeg';
  return {
    filetype,
    filename: path.basename(abs),
    filesize: buf.length,
    base64: buf.toString('base64'),
  };
}

/* ---------- Which sealed-record photo bucket feeds which survey question's image ---------- *
 * Mapping is 1:1 with CATEGORY_PHOTO_TARGETS ids in visit-flow.js and the
 * question text itself (q5 clip strips -> clipstrips bucket, q7 cat litter ->
 * cat-litter-pan-liners bucket, q9 butcher block -> butcher-block-rack bucket).
 * Q1/Q12 use the dedicated before/after arrays. Q3 (stock the section) has no
 * dedicated Stage 3 bucket, so it falls back to the generic per-section bucket.
 * There is no invented photo here — if the bucket is empty, assembly aborts
 * for that visit rather than reusing an unrelated photo. */
const SURVEY_PHOTO_SOURCE = {
  q1: (sealed) => sealed.beforePhotos?.[0] || null,
  q3: (sealed) => (sealed.categoryPhotos?.['cp-serviced-section'] || [])[0] || null,
  q5: (sealed) => (sealed.categoryPhotos?.clipstrips || [])[0] || null,
  q7: (sealed) => (sealed.categoryPhotos?.['cat-litter-pan-liners'] || [])[0] || null,
  q9: (sealed) => (sealed.categoryPhotos?.['butcher-block-rack'] || [])[0] || null,
  q12: (sealed) => sealed.afterPhotos?.[0] || null,
};

function isImageRequiredForAnswer(prodQuestion, answerText) {
  const choice = (prodQuestion.choices || []).find((c) => c.text === answerText);
  if (choice) return !!choice.is_image_required;
  return !!prodQuestion.answer_image_required;
}

/* ---------- Mileage leg -> travel_records fragment ---------- */

const LEG_LOCATION_CODE = { home: 'H' };
function locationCode(token) {
  const t = token == null ? '' : String(token).toLowerCase();
  if (t === 'home' || t === 'h') return 'H';
  return 'S';
}

/**
 * Drive hours from matrix miles (James FM53: 3.4 mi → 0.0833h ≈ 5 min ≈ 41 mph).
 * Min 5 minutes so short legs still have non-zero duration (prod rejects null duration).
 */
function estimateDriveHours(miles, opts = {}) {
  if (opts.driveHours != null && Number.isFinite(Number(opts.driveHours))) {
    return Number(opts.driveHours);
  }
  const m = Number(miles);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.max(5 / 60, m / 40);
}

/**
 * Matrix leg snapshot for dry-run audit / sealed-record mileage.
 * Prefer buildTravelChangeRecord() for live shift PATCH travel_records.
 */
function buildTravelRecordFragment(leg, visitStartIso, opts = {}) {
  if (!leg || leg.miles == null || leg.source === 'same-store') return null;
  const driveHours = estimateDriveHours(leg.miles, opts);
  const endMs = new Date(visitStartIso).getTime();
  const startIso = new Date(endMs - Math.round(driveHours * 3600 * 1000)).toISOString();
  return {
    start_location_type: locationCode(leg.from),
    end_location_type: locationCode(leg.to),
    start_time: startIso,
    end_time: visitStartIso,
    duration: driveHours.toFixed(4),
    distance: Number(leg.miles).toFixed(2),
    record_type: 'CHANGE',
    is_system_generated: false,
    _auditOnly: true,
    _auditNote:
      'Matrix leg audit. For live send use buildTravelChangeRecord (includes shift_id + change_reason).',
  };
}

/**
 * Live travel CHANGE row for PATCH …/shifts/{id}/ (prod completion.har 2026-07-15).
 *
 * After to_store/to_home, system may invent ~32 mi. UI corrects with:
 *   record_type: "CHANGE", change_reason, change_comment, full times, distance, duration.
 * First create may omit id; later edits include travel_records[].id.
 *
 * @param {object} leg - sealed mileage.leg { from, to, miles, source }
 * @param {object} opts
 * @param {number} opts.shiftId
 * @param {string} opts.visitStartIso - UTC ISO
 * @param {string} opts.visitStopIso - UTC ISO
 * @param {number} opts.changeReasonId - same catalog as time_change_reason (id 5 etc.)
 * @param {string} opts.changeComment
 * @param {number} [opts.existingTravelId]
 * @param {number} [opts.driveHours]
 */
function buildTravelChangeRecord(leg, opts = {}) {
  if (!leg || leg.miles == null || leg.source === 'same-store') return null;
  const shiftId = opts.shiftId;
  if (shiftId == null) return null;

  const from = locationCode(leg.from);
  const to = locationCode(leg.to);
  const driveHours = estimateDriveHours(leg.miles, opts);
  const durationMs = Math.round(driveHours * 3600 * 1000);

  let startIso;
  let endIso;
  // Inbound to store: ends at visit start. Outbound from store: starts at visit stop.
  // Always normalize via Date#toISOString (prod completion.har uses .000Z millis).
  if (to === 'S' && from === 'H') {
    endIso = new Date(opts.visitStartIso).toISOString();
    startIso = new Date(new Date(endIso).getTime() - durationMs).toISOString();
  } else if (from === 'S' && to === 'H') {
    startIso = new Date(opts.visitStopIso || opts.visitStartIso).toISOString();
    endIso = new Date(new Date(startIso).getTime() + durationMs).toISOString();
  } else if (from === 'S' && to === 'S') {
    // Store-to-store: arrive at next store at visit start
    endIso = new Date(opts.visitStartIso).toISOString();
    startIso = new Date(new Date(endIso).getTime() - durationMs).toISOString();
  } else {
    endIso = new Date(opts.visitStartIso).toISOString();
    startIso = new Date(new Date(endIso).getTime() - durationMs).toISOString();
  }

  const row = {
    shift_id: Number(shiftId),
    start_time: startIso,
    end_time: endIso,
    distance: Number(leg.miles).toFixed(2),
    duration: driveHours.toFixed(4),
    start_location_type: from,
    end_location_type: to,
    is_system_generated: false,
    is_truncated: false,
    user_accepted_overlap: null,
    record_type: 'CHANGE',
    change_reason: opts.changeReasonId,
    change_comment: opts.changeComment,
  };
  if (opts.existingTravelId != null) row.id = Number(opts.existingTravelId);
  return row;
}

/**
 * Shift T&E PATCH body.
 * - Time change: always time_change_reason + time_change_comment (James + prod completion).
 * - Mileage change: optional travel_records[] CHANGE rows with change_reason/comment
 *   (prod completion.har 01:30:57 — distance 3.50 edit).
 * Incomplete travel rows must never be sent (500 TravelRecord has no shift).
 */
function shiftPatchPayload({
  actualStartDate,
  actualStartTime,
  actualEndDate,
  actualEndTime,
  timeChangeReasonId,
  timeChangeComment,
  flags = {},
  travelRecords = null,
  includeEmptyTravelRecords = false,
}) {
  const body = {
    actual_start_date: actualStartDate,
    actual_start_time: actualStartTime,
    actual_end_date: actualEndDate,
    actual_end_time: actualEndTime,
    no_show: false,
    time_change_reason: timeChangeReasonId,
    time_change_comment: timeChangeComment,
    home_to_store: flags.home_to_store ?? true,
    store_to_store: flags.store_to_store ?? true,
    store_to_home: flags.store_to_home ?? true,
    calculate_mileage: flags.calculate_mileage ?? true,
    shift_breaks: [],
  };
  if (Array.isArray(travelRecords) && travelRecords.length) {
    body.travel_records = travelRecords;
  } else if (includeEmptyTravelRecords) {
    body.travel_records = [];
  }
  return body;
}

/** True if a travel row is safe to send on shift PATCH (prod completion.har shape). */
function isCompleteTravelChangeRecord(tr) {
  if (!tr || typeof tr !== 'object') return false;
  if (tr._auditOnly) return false;
  if (tr.shift_id == null) return false;
  if (!tr.start_time || !tr.end_time) return false;
  if (tr.distance == null || tr.distance === '') return false;
  if (tr.duration == null || tr.duration === '') return false;
  if (!tr.start_location_type || !tr.end_location_type) return false;
  if (tr.change_reason == null) return false;
  return true;
}

/** Step-advance / complete pings need shift_id on live completed & in-progress paths. */
function shiftCompletePingPayload(shiftId) {
  return { shift_id: Number(shiftId) };
}

/**
 * Prefer the visit's rep responder (email/name), never "first row = session owner".
 * Live admin transmits use supervisor token; completed_by may still be the session
 * user — responder identity for answers must stay the rep.
 */
function pickVisitRepResponder(existingResponders, { repKey, repName, workdayGivenId } = {}) {
  const rows = Array.isArray(existingResponders) ? existingResponders : [];
  if (!rows.length) return null;

  const repMeta = (d8ShiftReps.reps || []).find((r) => r.repKey === repKey) || null;
  const emails = new Set((repMeta?.emails || []).map((e) => String(e).toLowerCase()));
  for (const e of [...emails]) {
    const local = String(e).split('@')[0];
    if (local) emails.add(`${local}@sasretailservices.com`);
  }
  // Common SAS form: first.last@sasretailservices.com from display name
  const name = repName || repMeta?.name || '';
  if (name) {
    const parts = name
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length >= 2) {
      emails.add(`${parts[0]}.${parts[parts.length - 1]}@sasretailservices.com`);
    }
  }

  const byEmail = rows.find((r) => emails.has(String(r.name || '').toLowerCase()));
  if (byEmail) return { responder: byEmail, matchedBy: 'email' };

  const nameBits = String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter((b) => b.length > 2);
  if (nameBits.length) {
    const byName = rows.find((r) => {
      const n = String(r.name || '').toLowerCase();
      return nameBits.every((b) => n.includes(b));
    });
    if (byName) return { responder: byName, matchedBy: 'name' };
  }

  // Prefer sasretailservices rep mailboxes over supervisor session identities
  const sasRep = rows.find((r) => /@sasretailservices\.com$/i.test(String(r.name || '')));
  if (sasRep) return { responder: sasRep, matchedBy: 'sasretailservices_fallback' };

  return { responder: rows[0], matchedBy: 'first_available' };
}

function totalWorkTimeLabel(startIso, stopIso) {
  const ms = new Date(stopIso).getTime() - new Date(startIso).getTime();
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** work_time field on team_data (prod completion.har: "0:24:00"). */
function workTimeColonLabel(startIso, stopIso) {
  const totalMinutes = totalWorkMinutes(startIso, stopIso);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}:00`;
}

/**
 * Minimal spent_time_reason object (prod completion.har validate-spent-time-reason).
 * UI sends Restangular noise; API only needs id + text.
 */
function spentTimeReasonRef(reason) {
  if (!reason) return null;
  return { id: reason.id, text: reason.text };
}

/** Work duration in minutes (for duration ≤ work-time rules). */
function totalWorkMinutes(startIso, stopIso) {
  const ms = new Date(stopIso).getTime() - new Date(startIso).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

/**
 * Category spent_time must never exceed total work time (prod 400:
 * "Actual duration should not be greater than total work time").
 * For single-category CP visits the whole shift maps to the one reset row,
 * so spent_time === work label. Always pair with spent_time_reason when
 * spent share of work is > 5% (always true when spent === work on one category).
 */
function categorySpentTimeLabel(startIso, stopIso) {
  return totalWorkTimeLabel(startIso, stopIso);
}

/** True when a single category claiming this spent_time will trip the 5% rule. */
function needsSpentTimeReason(startIso, stopIso, spentMinutes = null) {
  const work = totalWorkMinutes(startIso, stopIso);
  if (work <= 0) return true;
  const spent = spentMinutes == null ? work : spentMinutes;
  return spent / work > 0.05;
}

/* ---------- Assembler ---------- */

function abort(result, reason) {
  result.status = 'aborted';
  result.abortReason = reason;
  return result;
}

/**
 * @param {Object} opts
 * @param {Object} opts.sealedRecord - visit-draft-store draft with status 'ready_for_prod'
 * @param {Object} opts.matchedVisit - visit-matcher.js matched entry ({status:'matched', appShift, prodVisit})
 * @param {Object} [opts.opts]
 * @param {Function} [opts.opts.sasGet] injectable read-only GET (default: live prod)
 * @param {Function} [opts.opts.loadSession] injectable session loader (default: loadSasSession)
 * @param {Function} [opts.opts.readPhotoBase64] injectable photo loader
 * @param {string} opts.opts.timeChangeComment REQUIRED — never defaults to the HAR's placeholder "k"
 * @param {string} [opts.opts.categorySpentTimeReasonText] default: data/sas-write-reasons.json selection
 * @param {string} [opts.opts.timeChangeReasonText] default: data/sas-write-reasons.json selection
 * @param {Function} [opts.opts.isAlreadyTransmitted] (visitId) => boolean, local bookkeeping guard
 */
/**
 * Compose the human-visible T&E comment written to the PROD shift record so the
 * REAL store a shift ran for — and any rep-logged outcome/variance — is durable
 * and recallable later. SAS schedules everything under a placeholder store
 * (usually 391); this makes "which real store was this 391 shift?" answerable
 * from PROD itself. Truncated to a conservative length for the field.
 *
 * @returns {string} e.g. "base | Actual store 215 (scheduled placeholder 391) | Did: Worked load and wrote order | Variances: Huge load"
 */
function buildAttributionComment({ baseComment, actualStore, scheduledStore, shiftLog } = {}, maxLen = 255) {
  const parts = [];
  const base = (baseComment == null ? '' : String(baseComment)).trim();
  if (base) parts.push(base);

  if (actualStore != null) {
    const redirected = scheduledStore != null && Number(scheduledStore) !== Number(actualStore);
    parts.push(
      redirected
        ? `Actual store ${actualStore} (scheduled placeholder ${scheduledStore})`
        : `Store ${actualStore}`
    );
  }

  const outcomes = (shiftLog?.outcomes || []).filter((o) => o && (o.label || o.optionId));
  const did = outcomes.filter((o) => o.kind !== 'variance').map((o) => o.label || o.optionId);
  const variances = outcomes.filter((o) => o.kind === 'variance').map((o) => o.label || o.optionId);
  if (did.length) parts.push(`Did: ${did.join(', ')}`);
  if (variances.length) parts.push(`Variances: ${variances.join(', ')}`);

  let out = parts.join(' | ');
  if (out.length > maxLen) out = out.slice(0, maxLen - 1).trimEnd() + '…';
  return out;
}

async function transmitVisit({ sealedRecord, matchedVisit, opts = {} } = {}) {
  const {
    sasGet = defaultSasGet,
    loadSession = loadSasSession,
    readPhotoBase64 = defaultReadPhotoBase64,
    timeChangeComment,
    categorySpentTimeReasonText = writeReasons.categorySpentTimeReason.selected.text,
    timeChangeReasonText = writeReasons.shiftTimeChangeReason.selected.text,
    isAlreadyTransmitted = () => false,
  } = opts;

  const result = {
    status: 'ok',
    repKey: sealedRecord?.repKey || null,
    date: sealedRecord?.date || null,
    scheduledStore: matchedVisit?.prodVisit?.scheduledStore ?? sealedRecord?.scheduledStore ?? null,
    actualStore: matchedVisit?.prodVisit?.actualStore ?? sealedRecord?.actualStore ?? null,
    visitId: matchedVisit?.prodVisit?.visitId ?? null,
    abortReason: null,
    calls: [],
    photoCounts: {},
  };

  /* ---- Part C guards ---- */
  if (!sealedRecord) return abort(result, 'missing_sealed_record');
  if (sealedRecord.status !== 'ready_for_prod') return abort(result, 'not_sealed');
  if (!matchedVisit || matchedVisit.status !== 'matched') return abort(result, 'not_matched_or_ambiguous');

  const visitId = matchedVisit.prodVisit?.visitId;
  const shiftId = matchedVisit.prodVisit?.shiftId;
  if (!visitId || !shiftId) return abort(result, 'missing_visit_or_shift_id');
  if (isAlreadyTransmitted(visitId)) return abort(result, 'already_transmitted');
  if (!timeChangeComment) return abort(result, 'missing_time_change_comment');

  // Store-attribution + outcome/variance summary, appended to the durable,
  // human-visible T&E comment on every shift PATCH (and the category-reset row).
  const attributionComment = buildAttributionComment({
    baseComment: timeChangeComment,
    actualStore: result.actualStore,
    scheduledStore: result.scheduledStore,
    shiftLog: sealedRecord.shiftLog,
  });
  result.attributionComment = attributionComment;

  const leg = sealedRecord.mileage?.leg;
  if (!leg || (leg.miles == null && leg.source !== 'same-store')) return abort(result, 'mileage_leg_not_resolved');

  const visitStartIso = sealedRecord.visitStart?.actual;
  const visitStopIso = sealedRecord.visitStop?.actual;
  if (!visitStartIso) return abort(result, 'missing_visit_start_time');
  if (!visitStopIso) return abort(result, 'missing_visit_stop_time');

  let seq = 0;
  function pushCall({ method, url, payload = null, dependsOn = [], sourceRef, reconstructed = false }) {
    seq += 1;
    result.calls.push({ seq, method, url, headers: authHeaders(), payload, dependsOn, sourceRef, reconstructed });
    return seq;
  }

  const { token } = await loadSession();

  /* ---- Idempotency + dependency resolution (all live reads) ---- */

  const shiftComplete = await sasGet(token, `/field-app/visits/${visitId}/shift-complete/`);
  pushCall({
    method: 'GET',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    sourceRef: 'HAR entry #81 — idempotency/state check (current_status, employees[].actual_start_time)',
  });
  if (String(shiftComplete?.current_status || '').toLowerCase() === 'completed') {
    return abort(result, 'already_completed_in_prod');
  }
  const shiftEmployee = (shiftComplete?.employees || []).find((e) => String(e.shift_id) === String(shiftId));
  if (!shiftEmployee) return abort(result, 'shift_employee_not_found_on_visit');
  // Cohesive path: rep may have opened/punched the shift in SAS PROD field app first.
  // Still assemble completion writes (times, photos, survey, mileage fix, close).
  // Do NOT abort — skip first-time-only start steps below when already punched.
  const alreadyStartedInProd = Boolean(shiftEmployee.actual_start_time);
  result.alreadyStartedInProd = alreadyStartedInProd;
  if (alreadyStartedInProd) {
    result.prodCohesion = {
      mode: 'complete_prod_started',
      message:
        'Shift already has actual_start_time in PROD — assembling overlay to finish via app (skip visit-start; travel skipped if records exist)',
      prodActualStartTime: shiftEmployee.actual_start_time,
    };
  }

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v2/field-app/shifts/${shiftId}/`,
    sourceRef: 'HAR entry #128 — pre-state (home_to_store/store_to_store/store_to_home/calculate_mileage flags)',
  });
  const shiftPreState = await sasGet(token, `/v2/field-app/shifts/${shiftId}/`);
  const existingTravelRecords = Array.isArray(shiftPreState?.travel_records)
    ? shiftPreState.travel_records
    : [];
  const hasExistingTravel = existingTravelRecords.length > 0;
  result.prodTravelPreState = {
    travelRecordCount: existingTravelRecords.length,
    hasExistingTravel,
  };

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/`,
    sourceRef: 'HAR entry #158 — resolve category-reset row id(s)/planogram for photo + completion targeting',
  });
  const categoryResetsBody = await sasGet(token, `/field-app/visits/${visitId}/category-resets/`);
  const categoryResets = categoryResetsBody?.category_resets || [];
  if (!categoryResets.length) return abort(result, 'no_category_reset_rows_on_visit');

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v2/field-app/survey-visits/?visit=${visitId}`,
    sourceRef: 'HAR entry #194 — resolve survey id + name for this visit',
  });
  const surveyVisitsBody = await sasGet(token, `/v2/field-app/survey-visits/`, { visit: visitId });
  const surveyMeta = asRows(surveyVisitsBody)[0]?.survey;
  if (!surveyMeta || surveyMeta.name !== SURVEY_NAME) {
    return abort(result, `survey_not_resolved_or_name_mismatch:${surveyMeta?.name || 'none'}`);
  }
  const surveyId = surveyMeta.id;

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v1/surveys/questions/?survey=${surveyId}`,
    sourceRef: 'HAR entry #198 — resolve numeric question ids + exact choice text for validation',
  });
  const prodQuestions = asRows(await sasGet(token, `/surveys/questions/`, { survey: surveyId }));

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v1/field-app/spent-time-reasons/`,
    sourceRef: 'HAR entry #142 — resolve category spent-time-reason id by exact text',
  });
  const spentTimeReasons = asRows(await sasGet(token, `/field-app/spent-time-reasons/`));
  const categoryReason = spentTimeReasons.find((r) => r.text === categorySpentTimeReasonText);
  if (!categoryReason) return abort(result, `category_spent_time_reason_not_found:${categorySpentTimeReasonText}`);

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v1/operations/time-change-reason/?is_admin=true`,
    sourceRef: 'HAR entry #108 — resolve shift time-change-reason id by exact text',
  });
  const timeChangeReasons = asRows(await sasGet(token, `/operations/time-change-reason/`, { is_admin: true }));
  const shiftReason = timeChangeReasons.find((r) => r.text === timeChangeReasonText);
  if (!shiftReason) return abort(result, `shift_time_change_reason_not_found:${timeChangeReasonText}`);

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v1/surveys/responders/?visit_id=${visitId}`,
    sourceRef: 'HAR entry #193 — check for an existing responder before deciding create-vs-reuse',
  });
  const existingResponders = asRows(await sasGet(token, `/surveys/responders/`, { visit_id: visitId }));
  const repKey = sealedRecord.repKey || matchedVisit?.appShift?.repKey || matchedVisit?.prodVisit?.repKey;
  const repMeta = (d8ShiftReps.reps || []).find((r) => r.repKey === repKey);
  const picked = pickVisitRepResponder(existingResponders, {
    repKey,
    repName: repMeta?.name || null,
    workdayGivenId: matchedVisit?.prodVisit?.workdayGivenId || repMeta?.workdayGivenId,
  });
  let responderId = picked?.responder?.id || null;
  result.responderResolved = picked
    ? {
        id: picked.responder.id,
        name: picked.responder.name || null,
        matchedBy: picked.matchedBy,
        repKey: repKey || null,
      }
    : { id: null, name: null, matchedBy: 'none', repKey: repKey || null };

  /* ---- Validate every sealed survey answer against the live prod question set BEFORE assembling any write ---- */
  const visibility = surveyVisibility(sealedRecord.survey || {});
  const answeredQuestions = serviceSurvey.questions.filter((q) => {
    const vis = visibility.find((v) => v.id === q.id);
    return vis?.visible && sealedRecord.survey?.[q.id] != null;
  });

  const resolvedAnswers = [];
  for (const q of answeredQuestions) {
    const prodQuestion = prodQuestions.find((pq) => pq.text === q.text);
    if (!prodQuestion) return abort(result, `survey_question_not_found_in_prod:${q.id}`);

    const answerText = String(sealedRecord.survey[q.id]);
    if (Array.isArray(prodQuestion.choices) && prodQuestion.choices.length) {
      const choice = prodQuestion.choices.find((c) => c.text === answerText);
      if (!choice) return abort(result, `survey_answer_mismatch:${q.id}:${answerText}`);
    }

    let photoRecord = null;
    if (isImageRequiredForAnswer(prodQuestion, answerText)) {
      photoRecord = SURVEY_PHOTO_SOURCE[q.id]?.(sealedRecord) || null;
      if (!photoRecord) return abort(result, `survey_answer_image_required_but_unavailable:${q.id}`);
    }

    resolvedAnswers.push({ q, prodQuestion, answerText, photoRecord });
  }

  /* ---- Resolve before/after/category photos against category-reset rows ---- *
   * This real visit has exactly one row ("PET CARE SUPPLIES") so every photo
   * targets it. A multi-category full-scope visit would need >1 row; if a
   * category-tagged photo can't be matched to a specific row, abort rather
   * than guess (never split evidence across the wrong reset row). */
  function resolveResetRowForCategory() {
    if (categoryResets.length === 1) return categoryResets[0];
    return null;
  }
  const primaryResetRow = resolveResetRowForCategory();
  if (!primaryResetRow) return abort(result, 'category_reset_row_not_resolved_for_multi_category_visit');

  /* ================= Begin assembled write sequence (mirrors HAR order) =================
   * Send contract: docs/sas-payload-contract.md
   * Re-baselined James FM53 first-time complete HAR 2026-07-15 (visit 27000977). */

  // Matrix leg audit + live CHANGE builder (prod completion.har travel edit)
  const travelAudit = buildTravelRecordFragment(leg, visitStartIso);
  result.mileageAudit = travelAudit;

  const storeForTimezone = result.actualStore ?? result.scheduledStore;
  const localStartTime = toStoreLocalTime(visitStartIso, storeForTimezone);
  const localStopTime = toStoreLocalTime(visitStopIso, storeForTimezone);
  if (!localStartTime || !localStopTime) {
    return abort(result, `store_timezone_unresolved:${storeForTimezone ?? 'null'}`);
  }
  // 12-hour local + UTC datetime for the visit-start PATCH body (prod completion.har shape).
  const localStartTime12h = toStoreLocalTime12h(visitStartIso, storeForTimezone);
  const startDatetimeUtc = new Date(visitStartIso).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const shiftFlags = {
    home_to_store: shiftPreState?.home_to_store ?? true,
    store_to_store: shiftPreState?.store_to_store ?? true,
    store_to_home: shiftPreState?.store_to_home ?? true,
    calculate_mileage: shiftPreState?.calculate_mileage ?? true,
  };

  // Work minutes must be known before category completion so spent_time ≤ work time.
  const workMinutes = totalWorkMinutes(visitStartIso, visitStopIso);
  if (workMinutes <= 0) {
    return abort(result, 'visit_duration_zero_or_negative');
  }
  result.workTime = {
    minutes: workMinutes,
    label: totalWorkTimeLabel(visitStartIso, visitStopIso),
    needsSpentTimeReason: needsSpentTimeReason(visitStartIso, visitStopIso),
  };

  const legFrom = locationCode(leg.from);
  const legTo = locationCode(leg.to);
  const isHomeToStoreLeg = legFrom === 'H' && legTo === 'S';
  const isStoreToHomeLeg = legFrom === 'S' && legTo === 'H';
  const isStoreToStoreLeg = legFrom === 'S' && legTo === 'S';

  // 0. Start schedule — PATCH visit → "Schedule started successfully" (before travel / T&E).
  //    prod completion.har: body carries visit_id + actual_start_time (12h local) +
  //    actual_start_datetime (UTC) + geo/admin flags. An EMPTY body 400s (was the
  //    2026-07-15/17 partial failure at this seq). Skip when the rep already started
  //    the visit in PROD (already has actual_start_time).
  if (!alreadyStartedInProd) {
    pushCall({
      method: 'PATCH',
      url: `${BASE}/api/v1/field-app/visits/${visitId}/`,
      payload: {
        visit_id: Number(visitId),
        actual_start_time: localStartTime12h,
        actual_start_datetime: startDatetimeUtc,
        start_location: [-1, -1],
        validate_geo: true,
        is_web: true,
        isMerchandiserStartingVisit: true,
        from_state: 'admin',
        no_show_admin: true,
      },
      sourceRef:
        'prod completion.har — PATCH /api/v1/field-app/visits/{visitId}/ start: visit_id + actual_start_time (12h local) + actual_start_datetime (UTC) + start_location/validate_geo/is_web/isMerchandiserStartingVisit/from_state/no_show_admin. Empty body 400s.',
      reconstructed: true,
    });
  } else {
    result.skippedVisitStart = true;
  }

  // 1. Travel H→S — POST { start_time (UTC, = arrival/visit-start), user_accepted_ss_replace: null }.
  //    An empty {} body 500s (was the 2026-07-17 seq-10 failure) — prod completio7n.har visit 26940175.
  //    System may invent ~32 mi; corrected later via shift PATCH travel CHANGE when leg is H→S.
  //    Skip when PROD already has travel_records (rep started/traveled in field app first).
  if (!hasExistingTravel) {
    pushCall({
      method: 'POST',
      url: `${BASE}/api/v2/field-app/travel/${shiftId}/to_store/`,
      payload: {
        start_time: new Date(visitStartIso).toISOString(),
        user_accepted_ss_replace: null,
      },
      sourceRef:
        'prod completio7n.har (visit 26940175) — POST …/to_store/ body { start_time (UTC), user_accepted_ss_replace: null }. Empty {} 500s. Skip at execute if shift already has travel_records.',
    });
  } else {
    result.skippedToStore = true;
  }

  // 2. Full punch times EARLY with time_change_reason + comment (required for T&E edit).
  //    travel_records: [] on pure time edit (prod completion supervisor patches).
  //    Full start+stop before category work so duration ≤ total work time.
  const timeOnlyShiftPayload = shiftPatchPayload({
    actualStartDate: visitStartIso.slice(0, 10),
    actualStartTime: localStartTime,
    actualEndDate: visitStopIso.slice(0, 10),
    actualEndTime: localStopTime,
    timeChangeReasonId: shiftReason.id,
    timeChangeComment: attributionComment,
    flags: shiftFlags,
    includeEmptyTravelRecords: true,
  });
  const startShiftSeq = pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v2/field-app/shifts/${shiftId}/`,
    payload: timeOnlyShiftPayload,
    sourceRef:
      'James FM53 + prod completion.har — actual_*_time + time_change_reason/comment; travel_records [] on time-only edit. Full start+stop before category spent_time.',
    reconstructed: true,
  });

  // 2b. If leg is home→store (or store→store inbound), correct system H→S/S→S mileage now.
  let homeToStoreMileageSeq = null;
  if ((isHomeToStoreLeg || isStoreToStoreLeg) && leg.miles != null) {
    const inboundChange = buildTravelChangeRecord(leg, {
      shiftId,
      visitStartIso,
      visitStopIso,
      changeReasonId: shiftReason.id,
      changeComment: timeChangeComment,
    });
    if (inboundChange && isCompleteTravelChangeRecord(inboundChange)) {
      homeToStoreMileageSeq = pushCall({
        method: 'PATCH',
        url: `${BASE}/api/v2/field-app/shifts/${shiftId}/`,
        payload: shiftPatchPayload({
          actualStartDate: visitStartIso.slice(0, 10),
          actualStartTime: localStartTime,
          actualEndDate: visitStopIso.slice(0, 10),
          actualEndTime: localStopTime,
          timeChangeReasonId: shiftReason.id,
          timeChangeComment: attributionComment,
          flags: shiftFlags,
          travelRecords: [inboundChange],
        }),
        dependsOn: [startShiftSeq],
        sourceRef:
          'prod completion.har 2026-07-16T01:30:57 — travel_records CHANGE with change_reason/comment + distance/duration/shift_id. Corrects system ~32mi after to_store.',
        reconstructed: true,
      });
      result.mileageCorrection = { direction: `${legFrom}-${legTo}`, distance: inboundChange.distance, phase: 'after_to_store' };
    }
  }

  // 3. Shift-complete step-advance — live needs { shift_id } (empty {} → 406)
  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    payload: shiftCompletePingPayload(shiftId),
    sourceRef: 'HAR entry #141 step-advance; live contract requires { shift_id } (empty body 406)',
  });

  // 4. Category Reset — before photo(s)
  const beforePhotoSeqs = [];
  for (const photo of sealedRecord.beforePhotos || []) {
    const image = readPhotoBase64(photo);
    if (!image) return abort(result, `photo_unreadable:before:${photo.path}`);
    beforePhotoSeqs.push(
      pushCall({
        method: 'PATCH',
        url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/${primaryResetRow.id}/`,
        payload: { before: { image }, compress_image: true },
        sourceRef: 'HAR entry #167 — before-photo slot PATCH, request shape matches sas-upload-category-after-photos skill exactly',
      })
    );
  }

  // 5. Category Reset — after photo(s)
  const afterPhotoSeqs = [];
  for (const photo of sealedRecord.afterPhotos || []) {
    const image = readPhotoBase64(photo);
    if (!image) return abort(result, `photo_unreadable:after:${photo.path}`);
    afterPhotoSeqs.push(
      pushCall({
        method: 'PATCH',
        url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/${primaryResetRow.id}/`,
        payload: { after: { image }, compress_image: true },
        sourceRef: 'HAR entry #173 — after-photo slot PATCH, same shape as before',
      })
    );
  }

  // 6. Category photos (endcaps/wings/clipstrips/cat-litter/butcher-block/section)
  //    -> same PATCH endpoint, folded into the after slot (this is additional
  //    photographic evidence of the completed reset, not a separate reset row).
  const categoryPhotoCounts = {};
  for (const target of CATEGORY_PHOTO_TARGETS) {
    const photos = sealedRecord.categoryPhotos?.[target.id] || [];
    categoryPhotoCounts[target.id] = photos.length;
    for (const photo of photos) {
      const image = readPhotoBase64(photo);
      if (!image) return abort(result, `photo_unreadable:${target.id}:${photo.path}`);
      pushCall({
        method: 'PATCH',
        url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/${primaryResetRow.id}/`,
        payload: { after: { image }, compress_image: true },
        sourceRef: `HAR entry #173 pattern — category photo (${target.label}) folded into the single reset row's after slot; no HAR evidence of a per-category-target sub-endpoint`,
      });
    }
  }
  result.photoCounts = {
    before: (sealedRecord.beforePhotos || []).length,
    after: (sealedRecord.afterPhotos || []).length,
    ...categoryPhotoCounts,
  };

  // 7a. Validate spent-time reason BEFORE completion (prod completion.har).
  //    Endpoint: PATCH …/category-resets/{id}/validate-spent-time-reason/
  //    Fail path: spent_time_reason null → success:false is_spent_time (5% rule).
  //    Pass path: spent_time_reason {id,text} → "Validated Successfully".
  const spentLabel = categorySpentTimeLabel(visitStartIso, visitStopIso);
  const spentReasonObj = spentTimeReasonRef(categoryReason);
  const teamDataRow = {
    id: shiftEmployee.id,
    shift_id: Number(shiftId),
    spent_time: spentLabel,
    spent_time_reason: spentReasonObj,
    work_time: workTimeColonLabel(visitStartIso, visitStopIso),
    is_duration_required: true,
  };
  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/${primaryResetRow.id}/validate-spent-time-reason/`,
    payload: {
      id: primaryResetRow.id,
      shift_id: Number(shiftId),
      spent_time: spentLabel,
      spent_time_reason: spentReasonObj,
      team_data: [teamDataRow],
    },
    sourceRef:
      'prod completion.har 2026-07-16 — PATCH …/validate-spent-time-reason/ with spent_time + spent_time_reason {id,text} + team_data. Always send reason when category share > 5% (single-category CP).',
    reconstructed: true,
  });

  // 7b. Category Reset — completion_status + team spent_time/reason id.
  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/${primaryResetRow.id}/`,
    payload: {
      completion_status: true,
      comment: attributionComment,
      exception_id: null,
      team: [
        {
          id: shiftEmployee.id,
          spent_time: spentLabel,
          spent_time_reason: categoryReason.id,
        },
      ],
    },
    sourceRef:
      'James FM53 + HAR #186/#414 — completion_status + team[].spent_time (= work time) + spent_time_reason id. Catalog GET /field-app/spent-time-reasons/.',
    reconstructed: true,
  });

  /* ---- Survey ---- */

  let responderCreateSeq = null;
  if (!responderId) {
    responderCreateSeq = pushCall({
      method: 'POST',
      url: `${BASE}/api/v1/surveys/responders/`,
      payload: { visit_id: visitId },
      sourceRef:
        'HAR entry #305 — response echoes {id,name,visit_id} with id/name server-derived from the auth session; only visit_id is a plausible client field. Placed BEFORE answers here (unlike the HAR, where a responder already existed) because every answer POST requires a responder id.',
      reconstructed: true,
    });
    responderId = `{{step${responderCreateSeq}.id}}`;
  }

  const runInfoSeq = pushCall({
    method: 'POST',
    url: `${BASE}/api/v1/surveys/run-infos/`,
    payload: { responder: responderId },
    sourceRef: 'HAR entry #207 — response echoes {id,responder,runid,created}; responder is the only plausible client-supplied field',
    reconstructed: true,
  });
  const runidPlaceholder = `{{step${runInfoSeq}.runid}}`;

  for (const { q, prodQuestion, answerText, photoRecord } of resolvedAnswers) {
    const answerSeq = pushCall({
      method: 'POST',
      url: `${BASE}/api/v1/surveys/answers/`,
      payload: {
        answer: answerText,
        question: prodQuestion.id,
        responder: responderId,
        survey: surveyId,
        runid: runidPlaceholder,
        // Prod requires run_info (run-infos row id); prod completion.har also sends is_field_web
        run_info: `{{step${runInfoSeq}.id}}`,
        is_field_web: true,
        delete: false,
      },
      dependsOn: [runInfoSeq, ...(responderCreateSeq ? [responderCreateSeq] : [])],
      sourceRef: `HAR #220 + prod completion.har (${q.id}) — answer + question + responder + run_info + is_field_web`,
    });

    if (photoRecord) {
      const image = readPhotoBase64(photoRecord);
      if (!image) return abort(result, `photo_unreadable:${q.id}:${photoRecord.path}`);
      pushCall({
        method: 'POST',
        url: `${BASE}/api/v1/surveys/answer-images/`,
        payload: {
          answer: `{{step${answerSeq}.id}}`,
          image,
          // Executor converts to multipart/form-data (JSON image → 400 "not a file")
          _executorEncoding: 'multipart-answer-image',
        },
        dependsOn: [answerSeq],
        sourceRef:
          'HAR entry #221 pattern + live 26822165 — POST answer-images requires multipart file (not JSON base64). Assembler carries base64; live-executor encodes multipart. Do not change to category-reset image shape.',
        reconstructed: true,
      });
    }
  }

  if (!responderCreateSeq) {
    // Claim/refresh the *rep* responder row (not session owner) before complete.
    pushCall({
      method: 'POST',
      url: `${BASE}/api/v1/surveys/responders/`,
      payload: { visit_id: visitId },
      sourceRef:
        'HAR entry #305 — claim responder for this visit. Prefer pre-resolved rep responder id for answers; claim still uses visit_id only. Note: completed_by may still be the API session user on admin-driven complete.',
      reconstructed: true,
    });
  }

  pushCall({
    method: 'POST',
    url: `${BASE}/api/v1/surveys/surveys/${surveyId}/complete/`,
    payload: {
      responder: responderId,
      run_info: `{{step${runInfoSeq}.id}}`,
    },
    dependsOn: [runInfoSeq, ...(responderCreateSeq ? [responderCreateSeq] : [])],
    sourceRef:
      'HAR entry #308 + live 26822165 — complete requires responder + run_info (run-infos id); empty body 400s. Responder must be the visit rep row when available.',
  });

  /* ---- Last-stop travel home + time reaffirm + mileage CHANGE + first-time complete ---- */

  // Store→home when last stop OR sealed leg is S→H (James FM53 isLastStop + 3.4 mi home).
  // If PROD already has an S→H travel row, skip (rep may have ended travel in field app).
  const isLastStop = sealedRecord.isLastStopOfDay === true;
  const hasStoreToHomeTravel = existingTravelRecords.some(
    (tr) =>
      String(tr?.start_location_type || '').toUpperCase() === 'S' &&
      String(tr?.end_location_type || '').toUpperCase() === 'H'
  );
  const needsToHome =
    shiftFlags.store_to_home !== false &&
    (isLastStop || isStoreToHomeLeg) &&
    !hasStoreToHomeTravel;
  if (needsToHome) {
    pushCall({
      method: 'POST',
      url: `${BASE}/api/v2/field-app/travel/${shiftId}/to_home/`,
      payload: {},
      sourceRef:
        'James FM53 HAR — POST /api/v2/field-app/travel/{shiftId}/to_home/ body {}. System may invent ~32mi S-H; corrected next via travel CHANGE. Skipped when S→H travel already on shift.',
      reconstructed: true,
    });
    result.toHomeAssembled = true;
  } else {
    result.toHomeAssembled = false;
    if (hasStoreToHomeTravel) result.skippedToHome = true;
  }

  // Final shift PATCH: reaffirm times (time_change_reason) AND/OR mileage CHANGE.
  // prod completion.har: travel_records[{ record_type:CHANGE, change_reason, change_comment,
  //   distance, duration, shift_id, start/end times, S→H }].
  const finalTravelRecords = [];
  if (isStoreToHomeLeg && leg.miles != null) {
    const outboundChange = buildTravelChangeRecord(leg, {
      shiftId,
      visitStartIso,
      visitStopIso,
      changeReasonId: shiftReason.id,
      changeComment: timeChangeComment,
    });
    if (outboundChange && isCompleteTravelChangeRecord(outboundChange)) {
      finalTravelRecords.push(outboundChange);
      result.mileageCorrection = {
        ...(result.mileageCorrection || {}),
        direction: 'S-H',
        distance: outboundChange.distance,
        phase: needsToHome ? 'after_to_home' : 'final',
        duration: outboundChange.duration,
      };
    }
  }

  const finalShiftPayload = shiftPatchPayload({
    actualStartDate: visitStartIso.slice(0, 10),
    actualStartTime: localStartTime,
    actualEndDate: visitStopIso.slice(0, 10),
    actualEndTime: localStopTime,
    timeChangeReasonId: shiftReason.id,
    timeChangeComment: attributionComment,
    flags: shiftFlags,
    travelRecords: finalTravelRecords.length ? finalTravelRecords : null,
    includeEmptyTravelRecords: finalTravelRecords.length === 0,
  });
  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v2/field-app/shifts/${shiftId}/`,
    payload: finalShiftPayload,
    dependsOn: [startShiftSeq, ...(homeToStoreMileageSeq ? [homeToStoreMileageSeq] : [])],
    sourceRef:
      finalTravelRecords.length
        ? 'prod completion.har mileage edit + James FM53 — times + time_change_reason/comment + travel_records CHANGE (change_reason/comment, distance, duration, shift_id). Corrects system S-H ~32mi to matrix miles.'
        : 'James FM53 final shift PATCH — reaffirm actual times + time_change_reason/comment after survey; travel_records [].',
    reconstructed: true,
  });

  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    payload: shiftCompletePingPayload(shiftId),
    sourceRef: 'HAR entry #372 / James FM53 step-advance with { shift_id }',
  });

  pushCall({
    method: 'PUT',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    payload: shiftCompletePingPayload(shiftId),
    sourceRef:
      'James FM53 + HAR #435 first-time complete — PUT …/shift-complete/ → "Visit completed successfully." Requires { shift_id }. Distinct from testMode POST …/recomplete/.',
  });

  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    payload: shiftCompletePingPayload(shiftId),
    sourceRef: 'HAR entry #439 / James FM53 final step-advance with { shift_id }',
  });

  // testMode / already-completed re-close payload (prod completion.har recomplete).
  // Empty {} often soft-fails; UI posts category-reset + complete_shift_final.
  result.recompletePayload = {
    'category-reset': [
      {
        id: primaryResetRow.id,
        completed: true,
        category_completion: true,
        category_id: primaryResetRow.category_id ?? null,
        name: primaryResetRow.name || null,
        comment: '',
        exception: { text: null, id: null },
        team: [
          {
            id: shiftEmployee.id,
            shift_id: Number(shiftId),
            spent_time: spentLabel,
            spent_time_reason: spentReasonObj,
            work_time: workTimeColonLabel(visitStartIso, visitStopIso),
            is_duration_required: true,
          },
        ],
      },
    ],
    complete_shift_final: {
      team_lead_feedback: null,
      allowed_truncation: false,
      allowed_overlap: false,
      allowed_missing_ques: false,
    },
  };

  result.callCount = result.calls.length;
  result.shiftId = shiftId;
  result.reasonIds = {
    timeChangeReason: shiftReason.id,
    timeChangeReasonText: shiftReason.text,
    spentTimeReason: categoryReason.id,
    spentTimeReasonText: categoryReason.text,
    travelChangeReason: shiftReason.id,
  };
  return result;
}

module.exports = {
  transmitVisit,
  buildAttributionComment,
  defaultSasGet,
  pickVisitRepResponder,
  shiftPatchPayload,
  shiftCompletePingPayload,
  defaultReadPhotoBase64,
  buildTravelRecordFragment,
  buildTravelChangeRecord,
  estimateDriveHours,
  isCompleteTravelChangeRecord,
  totalWorkTimeLabel,
  totalWorkMinutes,
  workTimeColonLabel,
  spentTimeReasonRef,
  categorySpentTimeLabel,
  needsSpentTimeReason,
  isImageRequiredForAnswer,
  resolveStoreTimezone,
  toStoreLocalTime,
  SURVEY_PHOTO_SOURCE,
  SURVEY_NAME,
  BASE,
};
