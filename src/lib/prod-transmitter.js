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

/* ---------- Injectable read-only GET (same shape as existing libs) ---------- */

async function defaultSasGet(token, urlPath, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  const p = urlPath.startsWith('/api/') ? urlPath : `/api/v1${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`;
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
  return LEG_LOCATION_CODE[token] || 'S';
}

/**
 * Matrix leg snapshot for dry-run audit / sealed-record mileage only.
 *
 * Automator-aligned send contract (docs/sas-payload-contract.md):
 *  - POST travel/.../to_store/ body is `{}` (establishes travel on first-time visits)
 *  - field-app shift PATCH does NOT include travel_records (including incomplete
 *    CHANGE rows 500s with "TravelRecord has no shift"; null start_time/duration 400s)
 *
 * This helper still returns a fully-specified audit object (filled start_time via
 * default 0.65h drive when unknown) for reporting — callers must NOT attach it
 * to shift PATCH payloads. Use `shiftPatchPayload()` which omits travel_records.
 */
function buildTravelRecordFragment(leg, visitStartIso, opts = {}) {
  if (!leg || leg.miles == null || leg.source === 'same-store') return null;
  const endMs = new Date(visitStartIso).getTime();
  const driveHours =
    opts.driveHours != null && Number.isFinite(Number(opts.driveHours))
      ? Number(opts.driveHours)
      : 0.65; // HAR H-S default when Google preview is not executed at assemble time
  const startIso = new Date(endMs - Math.round(driveHours * 3600 * 1000)).toISOString();
  return {
    start_location_type: locationCode(leg.from),
    end_location_type: locationCode(leg.to),
    start_time: startIso,
    end_time: visitStartIso,
    duration: driveHours.toFixed(4),
    distance: leg.miles.toFixed(2),
    record_type: 'CHANGE',
    is_system_generated: true,
    // Audit-only — never copy onto a live shift PATCH (see shiftPatchPayload)
    _auditOnly: true,
    _auditNote:
      'Matrix leg for dry-run/sealed mileage audit. Automator omits travel_records on shift PATCH; to_store {} owns first-time travel. Do not send this object on field-app shifts PATCH.',
  };
}

/** Shift T&E PATCH body — automator shape (no travel_records). */
function shiftPatchPayload({
  actualStartDate,
  actualStartTime,
  actualEndDate,
  actualEndTime,
  timeChangeReasonId,
  timeChangeComment,
  flags = {},
}) {
  return {
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
  if (shiftEmployee?.actual_start_time) {
    return abort(result, 'already_started_in_prod');
  }
  if (!shiftEmployee) return abort(result, 'shift_employee_not_found_on_visit');

  pushCall({
    method: 'GET',
    url: `${BASE}/api/v2/field-app/shifts/${shiftId}/`,
    sourceRef: 'HAR entry #128 — pre-state (home_to_store/store_to_store/store_to_home/calculate_mileage flags)',
  });
  const shiftPreState = await sasGet(token, `/v2/field-app/shifts/${shiftId}/`);

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
   * Send contract: docs/sas-payload-contract.md (automator-aligned after 26822165 live). */

  // Audit-only matrix leg (not attached to shift PATCH — see contract)
  const travelAudit = buildTravelRecordFragment(leg, visitStartIso);
  result.mileageAudit = travelAudit;

  // 1. Travel preview — automator: POST body MUST be {} with Content-Type JSON.
  //    Executor skips when travel_records already exist on the shift.
  pushCall({
    method: 'POST',
    url: `${BASE}/api/v2/field-app/travel/${shiftId}/to_store/`,
    payload: {},
    sourceRef:
      'HAR entry #132 + sas-retail-automator postTravelToStore — body MUST be {} (JSON). Skip at execute if shift already has travel_records. Establishes first-time H-S travel (Google); matrix leg is sealed-record/audit only.',
  });

  // 2. Start visit — local wall-clock times; NO travel_records on shift PATCH
  //    (automator applyRegularShiftTimesViaApi). actual_end provisional = start.
  const storeForTimezone = result.actualStore ?? result.scheduledStore;
  const localStartTime = toStoreLocalTime(visitStartIso, storeForTimezone);
  if (!localStartTime) {
    return abort(result, `store_timezone_unresolved:${storeForTimezone ?? 'null'}`);
  }
  const shiftFlags = {
    home_to_store: shiftPreState?.home_to_store ?? true,
    store_to_store: shiftPreState?.store_to_store ?? true,
    store_to_home: shiftPreState?.store_to_home ?? true,
    calculate_mileage: shiftPreState?.calculate_mileage ?? true,
  };
  const startShiftPayload = shiftPatchPayload({
    actualStartDate: visitStartIso.slice(0, 10),
    actualStartTime: localStartTime,
    actualEndDate: visitStartIso.slice(0, 10),
    actualEndTime: localStartTime,
    timeChangeReasonId: shiftReason.id,
    timeChangeComment,
    flags: shiftFlags,
  });
  const startShiftSeq = pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v2/field-app/shifts/${shiftId}/`,
    payload: startShiftPayload,
    sourceRef:
      'HAR entry #137 times + automator applyRegularShiftTimesViaApi — local actual_*_time, time_change_reason/comment, mileage flags; NO travel_records on this PATCH (to_store owns first-time travel). actual_end provisional (= start); corrected on stop PATCH.',
    reconstructed: true,
  });

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

  // 7. Category Reset — completion_status. Request body reconstructed from
  //    the echoed "data" object (comment/completion_status/exception_id).
  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/${primaryResetRow.id}/`,
    payload: { completion_status: true, comment: '', exception_id: null },
    sourceRef: 'HAR entry #186 — response data:{comment,completion_status,exception_id,time_modified} echoes these fields',
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
        // Prod requires run_info (run-infos row id) in addition to runid uuid
        run_info: `{{step${runInfoSeq}.id}}`,
      },
      dependsOn: [runInfoSeq, ...(responderCreateSeq ? [responderCreateSeq] : [])],
      sourceRef: `HAR entry #220 pattern (${q.id}) — response echoes {answer,question,responder,survey,answer_status,runid,id} verbatim`,
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

  /* ---- Stop time + shift completion ---- */

  const localStopTime = toStoreLocalTime(visitStopIso, storeForTimezone);
  if (!localStopTime) {
    return abort(result, `store_timezone_unresolved:${storeForTimezone ?? 'null'}`);
  }
  const stopShiftPayload = shiftPatchPayload({
    actualStartDate: visitStartIso.slice(0, 10),
    actualStartTime: localStartTime,
    actualEndDate: visitStopIso.slice(0, 10),
    actualEndTime: localStopTime,
    timeChangeReasonId: shiftReason.id,
    timeChangeComment,
    flags: shiftFlags,
  });
  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v2/field-app/shifts/${shiftId}/`,
    payload: stopShiftPayload,
    dependsOn: [startShiftSeq],
    sourceRef:
      'HAR entry #353 + automator — stop times only; no travel_records on shift PATCH',
    reconstructed: true,
  });

  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    payload: shiftCompletePingPayload(shiftId),
    sourceRef: 'HAR entry #372 step-advance with { shift_id }',
  });

  // Assign rep + spent time + reason. HAR entry #413 shows this is REQUIRED
  // once cumulative spent time on a category exceeds 5% of shift time (true
  // for any single-category-covers-the-whole-shift visit like this one), so
  // the reason is supplied directly rather than reproducing the doomed
  // reason-less first attempt (#410/#413) that the real tester's UI exploration
  // triggered.
  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/category-resets/${primaryResetRow.id}/`,
    payload: {
      team: [
        {
          id: shiftEmployee.id,
          spent_time: totalWorkTimeLabel(visitStartIso, visitStopIso),
          spent_time_reason: categoryReason.id,
        },
      ],
    },
    sourceRef:
      'HAR entry #414 (successful retry) + #415 (GET confirms applied team[].spent_time/spent_time_reason). Wrapper shape ({"team":[...]}) is response-echo inferred, not a directly observed request body (Chrome HAR omitted it) — flagged per T sign-off.',
    reconstructed: true,
  });

  pushCall({
    method: 'PUT',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    payload: shiftCompletePingPayload(shiftId),
    sourceRef:
      'HAR entry #435 first-time complete — live requires shift_id on body; empty {} 400s. Distinct from testMode POST …/recomplete/ for already-completed visits.',
  });

  pushCall({
    method: 'PATCH',
    url: `${BASE}/api/v1/field-app/visits/${visitId}/shift-complete/`,
    payload: shiftCompletePingPayload(shiftId),
    sourceRef: 'HAR entry #439 final step-advance with { shift_id }',
  });

  result.callCount = result.calls.length;
  result.shiftId = shiftId;
  return result;
}

module.exports = {
  transmitVisit,
  defaultSasGet,
  pickVisitRepResponder,
  shiftPatchPayload,
  shiftCompletePingPayload,
  defaultReadPhotoBase64,
  buildTravelRecordFragment,
  totalWorkTimeLabel,
  isImageRequiredForAnswer,
  resolveStoreTimezone,
  toStoreLocalTime,
  SURVEY_PHOTO_SOURCE,
  SURVEY_NAME,
  BASE,
};
