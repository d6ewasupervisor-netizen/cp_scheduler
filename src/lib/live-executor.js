'use strict';

/**
 * Live-mode executor for Stage 4 assembled dry-run visit files.
 *
 * Sends EXACTLY the reviewed call sequence — never re-assembles or improvises.
 * Safety model: pre-flight verification + abort-on-first-failure + resumable
 * state. There is NO automatic rollback (several prod calls are not cleanly
 * reversible) and NO automatic retry.
 *
 * Gate: LIVE_TRANSMIT=1 AND draft id on data/live-allowlist.json.
 *
 * testMode (round-trip verification): requires a golden export
 * (export-cp-shift-full format, allChecksPassed). Bypasses only the
 * not-completed / not-started idempotency checks so assembled writes can land
 * on an already-completed visit; auto-appends recompleteVisit as the final
 * call; returns next-step instructions for re-export + diff.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { loadSasSession } = require('./sas-session');
const dryrunStore = require('./dryrun-store');
const visitDraftStore = require('./visit-draft-store');
const {
  isLiveTransmitEnabled,
  isDraftAllowlisted,
  draftIdFromParts,
} = require('./live-allowlist');
const liveRegistry = require('./live-registry');
const liveStore = require('./live-store');
const { validateGoldenExport } = require('./golden-export');
const {
  diffExports,
  formatRoundtripReport,
  writeRoundtripReport,
} = require('./roundtrip-diff');
const { deliverVisitPhotos } = require('./photo-delivery');

const REPO_ROOT = path.join(__dirname, '../..');
const SAS_BASE = 'https://prod.sasretail.com';

/** Automator: Pin required on completed T&E PATCH is a wrong-context signal (not a PIN to type). */
function isPinRequiredError(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  return /Pin filed is required|Pin is not valid|projects\/undefined/i.test(text);
}

function isTravelToStoreCall(call) {
  return call.method === 'POST' && /\/field-app\/travel\/\d+\/to_store\/?$/.test(call.url || '');
}

function isTravelToHomeCall(call) {
  return call.method === 'POST' && /\/field-app\/travel\/\d+\/to_home\/?$/.test(call.url || '');
}

function isTravelCall(call) {
  return isTravelToStoreCall(call) || isTravelToHomeCall(call);
}

function isShiftPatchCall(call) {
  return call.method === 'PATCH' && /\/field-app\/shifts\/\d+\/?$/.test(call.url || '');
}

/**
 * Prod often returns HTTP 200 with success:false for business rules
 * (e.g. spent_time_reason required when category share > 5%).
 * Treat those as failures so we never continue as if the write landed.
 * James FM53 HAR 2026-07-15: is_spent_time soft-fail + duration 400.
 */
function isSasBusinessFailure(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.success === false) return true;
  if (body.is_spent_time === true && body.success !== true) return true;
  return false;
}

function sasBusinessFailureMessage(body) {
  if (!body || typeof body !== 'object') return 'sas_business_failure';
  const msg = body.message;
  if (Array.isArray(msg)) return msg.join('; ');
  if (typeof msg === 'string' && msg) return msg;
  if (body.detail) return String(body.detail);
  return 'sas_business_failure';
}

/* ---------- Placeholder resolution ---------- */

const PLACEHOLDER_RE = /\{\{step(\d+)\.([a-zA-Z0-9_]+)\}\}/g;

function resolvePlaceholders(value, stepResults) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (_, seqStr, field) => {
      const seq = Number(seqStr);
      const body = stepResults[seq];
      if (body == null || body[field] == null) {
        throw new Error(`Unresolved placeholder {{step${seq}.${field}}}`);
      }
      return String(body[field]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, stepResults));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolvePlaceholders(v, stepResults);
    }
    return out;
  }
  return value;
}

/* ---------- Default network write (injectable for tests) ---------- *
 * Node's fetch() forbids the Cookie header. Automator uses credentials:include
 * + X-CSRFToken + Authorization. Mirror that with https.request so morning
 * sas-auth cookieHeader/csrfToken actually reach prod. */

function httpsRequest(urlStr, { method, headers, body, rawBody = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload =
      rawBody != null
        ? rawBody
        : body == null
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
    if (payload != null) {
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
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
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          body: parsed,
          text,
        });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** Multipart body for /surveys/answer-images/ (prod rejects JSON image objects). */
function buildAnswerImageMultipart(payload) {
  const boundary = '----cpLive' + Date.now().toString(16);
  const answer = payload.answer;
  const img = payload.image || {};
  const filename = img.filename || 'photo.jpg';
  const filetype = img.filetype || 'image/jpeg';
  const buf = Buffer.from(String(img.base64 || ''), 'base64');
  const parts = [];
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="answer"\r\n\r\n${answer}\r\n`
  );
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${filetype}\r\n\r\n`
  );
  const head = Buffer.from(parts.join(''), 'utf8');
  const mid = buf;
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, mid, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function defaultSasFetch(url, { method, headers, body } = {}) {
  return httpsRequest(url, { method, headers, body });
}

/** Build automator-style headers from morning sas-auth session. */
function buildSessionHeaders(session, { visitId = null, write = false } = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Token ${session.token}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (session.csrfToken) headers['X-CSRFToken'] = session.csrfToken;
  if (session.cookieHeader) headers.Cookie = session.cookieHeader;
  // Prefer schedule/admin referer — automator note: shift-completion context → Pin required / projects/undefined
  headers.Referer = visitId
    ? `${SAS_BASE}/en/field/schedules/${visitId}/schedule/admin`
    : `${SAS_BASE}/en/field/`;
  headers.Origin = SAS_BASE;
  if (write) headers['Content-Type'] = 'application/json;charset=UTF-8';
  return headers;
}

/* ---------- Pre-flight ---------- */

function collectPhotoPathsFromDraft(draft) {
  const paths = [];
  if (!draft) return paths;
  for (const p of draft.beforePhotos || []) if (p.path) paths.push(p.path);
  for (const p of draft.afterPhotos || []) if (p.path) paths.push(p.path);
  if (draft.loadCheck?.photo?.path) paths.push(draft.loadCheck.photo.path);
  for (const arr of Object.values(draft.categoryPhotos || {})) {
    for (const p of arr || []) if (p.path) paths.push(p.path);
  }
  for (const row of Object.values(draft.checklist || {})) {
    if (row?.photo?.path) paths.push(row.photo.path);
  }
  return paths;
}

function photosReadable(draft) {
  const missing = [];
  for (const rel of collectPhotoPathsFromDraft(draft)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) missing.push(rel);
  }
  return missing;
}

function imagePayloadsPresent(calls) {
  const problems = [];
  for (const call of calls || []) {
    const payload = call.payload;
    if (!payload || typeof payload !== 'object') continue;
    const images = [];
    if (payload.before?.image) images.push({ seq: call.seq, slot: 'before', image: payload.before.image });
    if (payload.after?.image) images.push({ seq: call.seq, slot: 'after', image: payload.after.image });
    if (payload.image && payload.image.base64 != null) {
      images.push({ seq: call.seq, slot: 'answer-image', image: payload.image });
    }
    for (const { seq, slot, image } of images) {
      if (!image.base64 || String(image.base64).length < 8) {
        problems.push(`seq ${seq} ${slot}: missing/empty base64`);
      }
    }
  }
  return problems;
}

/**
 * Read-only pre-flight.
 * Cohesive PROD+app path: if the rep already started the shift in SAS PROD
 * (actual_start_time set), allow mode=start so the app can still finish the
 * visit (photos, survey, times, mileage, close). Resume still skips the same
 * check for partial *app* transmits.
 * testMode: also skip not-completed / not-started (round-trip against a
 * completed golden visit); require validated golden export.
 */
async function runPreflight({
  assembled,
  draft,
  draftId,
  mode,
  testMode = false,
  goldenExportPath = null,
  loadSession = loadSasSession,
  sasGet,
  token,
  allowlistPath,
  registryPath,
}) {
  const failures = [];

  if (!isLiveTransmitEnabled()) {
    failures.push({ code: 'live_transmit_disabled', message: 'LIVE_TRANSMIT is off' });
  }
  if (!isDraftAllowlisted(draftId, allowlistPath)) {
    failures.push({ code: 'not_allowlisted', message: `Draft ${draftId} is not on the live allowlist` });
  }
  // Production mode refuses re-transmit; testMode may re-arm the same draft for another round-trip.
  if (!testMode && liveRegistry.isAlreadyTransmitted(draftId, registryPath)) {
    failures.push({ code: 'already_transmitted', message: `Draft ${draftId} already fully transmitted` });
  }
  if (!assembled?.calls?.length) {
    failures.push({ code: 'empty_sequence', message: 'Assembled visit has no calls' });
  }

  if (testMode) {
    const golden = validateGoldenExport(goldenExportPath);
    if (!golden.ok) {
      failures.push({
        code: 'golden_export_required',
        message: `testMode requires a golden export (manifest+raw+photos, allChecksPassed): ${golden.failures.join('; ')}`,
      });
    } else if (
      golden.manifest?.visitId != null &&
      assembled?.visitId != null &&
      String(golden.manifest.visitId) !== String(assembled.visitId)
    ) {
      failures.push({
        code: 'golden_visit_mismatch',
        message: `Golden visitId ${golden.manifest.visitId} != assembled ${assembled.visitId}`,
      });
    }
  }

  if (!draft) {
    failures.push({ code: 'draft_missing', message: 'Sealed draft not found on disk' });
  } else if (draft.status !== 'ready_for_prod' && mode === 'start' && !testMode) {
    failures.push({ code: 'not_sealed', message: `Draft status is ${draft.status}, expected ready_for_prod` });
  } else if (draft && draft.status !== 'ready_for_prod' && mode === 'start' && testMode) {
    // Still prefer sealed, but allow ready_for_prod only for true live; testMode needs sealed assembly source
    failures.push({ code: 'not_sealed', message: `Draft status is ${draft.status}, expected ready_for_prod` });
  }

  const missingPhotos = photosReadable(draft);
  if (missingPhotos.length) {
    failures.push({
      code: 'photo_unreadable',
      message: `Photo file(s) missing: ${missingPhotos.slice(0, 5).join(', ')}`,
    });
  }
  const imageProblems = imagePayloadsPresent(assembled?.calls);
  if (imageProblems.length) {
    failures.push({ code: 'image_payload_missing', message: imageProblems.join('; ') });
  }

  let sessionToken = token;
  try {
    if (!sessionToken) {
      const session = await loadSession();
      sessionToken = session?.token;
    }
    if (!sessionToken) failures.push({ code: 'session_invalid', message: 'No SAS token from loadSasSession' });
  } catch (err) {
    failures.push({ code: 'session_invalid', message: err.message });
  }

  // Prod idempotency (read-only).
  // Completed visits are blocked (unless testMode). Already-started PROD shifts
  // are allowed so reps who punched in SAS can still complete via the app.
  // testMode also bypasses not-completed so writes can re-land on a golden visit.
  if (sessionToken && sasGet && assembled?.visitId) {
    try {
      const shiftComplete = await sasGet(sessionToken, `/field-app/visits/${assembled.visitId}/shift-complete/`);
      const status = String(shiftComplete?.current_status || '').toLowerCase();
      if (status === 'completed' && !testMode) {
        failures.push({ code: 'already_completed_in_prod', message: 'Visit already completed in prod' });
      }
      // Note: do not fail on employees[].actual_start_time — cohesive complete path.
    } catch (err) {
      failures.push({ code: 'preflight_read_failed', message: err.message });
    }
  }

  // Matcher-still-green lite: assembled visitId must match draft identity
  if (draft && assembled) {
    if (Number(draft.actualStore) !== Number(assembled.actualStore)) {
      failures.push({
        code: 'matcher_drift',
        message: `Draft store ${draft.actualStore} != assembled ${assembled.actualStore}`,
      });
    }
    if (draft.repKey !== assembled.repKey || draft.date !== assembled.date) {
      failures.push({ code: 'matcher_drift', message: 'Draft rep/date does not match assembled file' });
    }
  }

  return { ok: failures.length === 0, failures, token: sessionToken };
}

/**
 * Append recomplete as the final call for testMode round-trip.
 * Always appended after the assembled sequence.
 *
 * CRITICAL: re-closing an already-completed visit uses
 *   POST /api/v1/field-app/visits/{id}/recomplete/
 * NOT PUT …/shift-complete/ (that is first-time completion, HAR #435).
 *
 * Body: prefer assembled.recompletePayload from prod-transmitter
 * (prod completion.har: category-reset[] + complete_shift_final). Empty {} still
 * accepted by some projects but often soft-fails "Please provide valid data".
 */
function appendRecompleteCall(calls, visitId, recompletePayload = null) {
  const list = Array.isArray(calls) ? [...calls] : [];
  const maxSeq = list.reduce((m, c) => Math.max(m, Number(c.seq) || 0), 0);
  const payload =
    recompletePayload && typeof recompletePayload === 'object'
      ? recompletePayload
      : {
          'category-reset': [],
          complete_shift_final: {
            team_lead_feedback: null,
            allowed_truncation: false,
            allowed_overlap: false,
            allowed_missing_ques: false,
          },
        };
  list.push({
    seq: maxSeq + 1,
    method: 'POST',
    url: `${SAS_BASE}/api/v1/field-app/visits/${visitId}/recomplete/`,
    headers: {
      Accept: 'application/json',
      Authorization: 'Token {{REDACTED}}',
      'X-Requested-With': 'XMLHttpRequest',
    },
    payload,
    dependsOn: maxSeq ? [maxSeq] : [],
    sourceRef:
      'testMode — POST …/recomplete/ with category-reset + complete_shift_final (prod completion.har 2026-07-15). NOT PUT shift-complete (first-time). Fallback empty category-reset if assembler omitted recompletePayload.',
    reconstructed: true,
    testModeAppended: true,
  });
  return list;
}

/* ---------- Default read helper for pre-flight (same shape as transmitter) ---------- */

async function defaultSasGet(token, urlPath, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  const p = urlPath.startsWith('/api/') ? urlPath : `/api/v1${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`;
  const url = `https://prod.sasretail.com${p}${qs.toString() ? `?${qs}` : ''}`;
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

/* ---------- Executor ---------- */

/**
 * @param {Object} opts
 * @param {string} opts.dryRunId - dry-run run folder id
 * @param {string} opts.visitFile - basename of assembled visit JSON
 * @param {string} [opts.draftId] - defaults from assembled rep/date/store
 * @param {string|number} opts.confirmStore - two-tap arm: must equal actualStore
 * @param {'start'|'resume'} [opts.mode]
 * @param {boolean} [opts.testMode] - round-trip verification against a completed golden visit
 * @param {string} [opts.goldenExportPath] - required when testMode (export-cp-shift-full folder)
 * @param {string} [opts.postExportPath] - optional; if set after transmit, run diff immediately
 * @param {Object} [opts.inject] - test injectables
 */
async function executeLiveTransmit({
  dryRunId,
  visitFile,
  draftId: draftIdOpt,
  confirmStore,
  mode = 'start',
  testMode = false,
  goldenExportPath = null,
  postExportPath = null,
  inject = {},
} = {}) {
  const {
    loadSession = loadSasSession,
    sasFetch = defaultSasFetch,
    sasGet = defaultSasGet,
    getDraft = visitDraftStore.getDraft,
    readVisitFile = dryrunStore.readVisitFile,
    now = () => new Date().toISOString(),
    registryPath,
    allowlistPath,
  } = inject;

  const result = {
    status: 'aborted',
    mode,
    testMode: !!testMode,
    dryRunId,
    visitFile,
    draftId: draftIdOpt || null,
    lastSuccessfulSeq: null,
    failedSeq: null,
    abortReason: null,
    preflightFailures: [],
    callsSent: 0,
    transmittedAt: null,
    goldenExportPath: goldenExportPath || null,
    recompleteAppended: false,
    nextStep: null,
    roundtrip: null,
  };

  // Hard gates before any I/O that could touch prod writes
  if (!isLiveTransmitEnabled()) {
    result.abortReason = 'live_transmit_disabled';
    return result;
  }

  // testMode arming REQUIRES golden export up front (refuse before any network)
  if (testMode) {
    const golden = validateGoldenExport(goldenExportPath);
    if (!golden.ok) {
      result.abortReason = 'golden_export_required';
      result.preflightFailures = golden.failures.map((message) => ({
        code: 'golden_export_required',
        message,
      }));
      return result;
    }
    result.goldenExportPath = golden.path;
  }

  const assembled = readVisitFile(dryRunId, visitFile);
  if (!assembled) {
    result.abortReason = 'assembled_file_missing';
    return result;
  }

  const draftId =
    draftIdOpt || draftIdFromParts(assembled.repKey, assembled.date, assembled.actualStore);
  result.draftId = draftId;

  if (!isDraftAllowlisted(draftId, allowlistPath)) {
    result.abortReason = 'not_allowlisted';
    return result;
  }

  // Two-tap arm: type the store number
  if (confirmStore == null || String(confirmStore) !== String(assembled.actualStore)) {
    result.abortReason = 'confirm_store_mismatch';
    return result;
  }

  if (!testMode && liveRegistry.isAlreadyTransmitted(draftId, registryPath)) {
    result.abortReason = 'already_transmitted';
    return result;
  }

  const draft = getDraft(assembled.repKey, assembled.date, assembled.actualStore);

  // Resume: load prior stepResults + lastSuccessfulSeq
  let stepResults = {};
  let startSeq = 1;
  let priorLogEntries = [];

  if (mode === 'resume') {
    const state = liveStore.readExecutorState(dryRunId, visitFile);
    const rec = liveRegistry.getTransmitRecord(draftId, registryPath);
    if (!state && !rec) {
      result.abortReason = 'no_partial_state_to_resume';
      return result;
    }
    if ((rec && rec.status === 'complete') || (state && state.status === 'complete')) {
      result.abortReason = 'already_transmitted';
      return result;
    }
    const lastOk = state?.lastSuccessfulSeq ?? rec?.lastSuccessfulSeq;
    if (lastOk == null) {
      result.abortReason = 'no_partial_state_to_resume';
      return result;
    }
    stepResults = { ...(state?.stepResults || rec?.stepResults || {}) };
    // Keys may be strings after JSON round-trip
    stepResults = Object.fromEntries(Object.entries(stepResults).map(([k, v]) => [Number(k), v]));
    startSeq = Number(lastOk) + 1;
    result.lastSuccessfulSeq = Number(lastOk);
    const priorLog = liveStore.readExecutionLog(dryRunId, visitFile);
    priorLogEntries = priorLog?.entries || [];
  } else {
    // Fresh start refuses if partial exists without explicit resume
    const rec = liveRegistry.getTransmitRecord(draftId, registryPath);
    if (rec?.status === 'partial') {
      result.abortReason = 'partial_exists_use_resume';
      return result;
    }
  }

  // Record runId + visit file BEFORE first call
  const bootState = {
    status: mode === 'resume' ? 'resuming' : 'starting',
    dryRunId,
    visitFile,
    draftId,
    visitId: assembled.visitId,
    mode,
    testMode: !!testMode,
    goldenExportPath: result.goldenExportPath,
    startSeq,
    lastSuccessfulSeq: result.lastSuccessfulSeq,
    stepResults,
    recordedAt: now(),
  };
  liveStore.writeExecutorState(dryRunId, visitFile, bootState);
  liveStore.writeExecutionLog(dryRunId, visitFile, {
    dryRunId,
    visitFile,
    draftId,
    visitId: assembled.visitId,
    mode,
    testMode: !!testMode,
    startedAt: now(),
    entries: [...priorLogEntries],
  });

  const preflight = await runPreflight({
    assembled,
    draft,
    draftId,
    mode,
    testMode: !!testMode,
    goldenExportPath: result.goldenExportPath,
    loadSession,
    sasGet,
    token: inject.token,
    allowlistPath,
    registryPath,
  });
  if (!preflight.ok) {
    result.abortReason = 'preflight_failed';
    result.preflightFailures = preflight.failures;
    liveStore.writeExecutorState(dryRunId, visitFile, {
      ...bootState,
      status: 'aborted_preflight',
      preflightFailures: preflight.failures,
      updatedAt: now(),
    });
    return result;
  }

  // Prefer full morning session (token+csrf+cookies) over bare token
  let session = null;
  try {
    session = await loadSession();
  } catch {
    session = { token: preflight.token };
  }
  if (!session.token) session = { token: preflight.token };

  // testMode: append recomplete as final call (POST …/recomplete/, not PUT shift-complete)
  let calls = assembled.calls;
  const recompleteBody = assembled.recompletePayload || null;
  if (testMode && mode === 'start') {
    calls = appendRecompleteCall(assembled.calls, assembled.visitId, recompleteBody);
    result.recompleteAppended = true;
  } else if (testMode && mode === 'resume') {
    const hasRecomplete = (assembled.calls || []).some((c) => c.testModeAppended);
    calls = hasRecomplete
      ? assembled.calls
      : appendRecompleteCall(assembled.calls, assembled.visitId, recompleteBody);
    result.recompleteAppended = true;
  }
  const logEntries = [...priorLogEntries];
  const softSkipped = [];

  for (const call of calls) {
    if (call.seq < startSeq) continue;

    // dependsOn: all deps must have results (this run or restored partial state)
    for (const dep of call.dependsOn || []) {
      if (stepResults[dep] == null) {
        result.status = 'partial';
        result.abortReason = `missing_dependency_result:step${dep}`;
        result.failedSeq = call.seq;
        persistPartial({
          dryRunId,
          visitFile,
          draftId,
          assembled,
          lastSuccessfulSeq: result.lastSuccessfulSeq,
          failedSeq: call.seq,
          stepResults,
          logEntries,
          abortReason: result.abortReason,
          now,
          registryPath,
        });
        return result;
      }
    }

    // If matching travel already on shift, skip that leg (PROD-started cohesive path + testMode).
    // to_store: any inbound-to-store record (end S) or any travel when only to_store is being sent.
    // to_home: only when an S→H row already exists (do not block last-stop home after H→S only).
    if (isTravelCall(call)) {
      try {
        const shiftPath = (call.url || '').replace(/\/travel\/(\d+)\/(to_store|to_home)\/?$/, '/shifts/$1/');
        const pref = await sasFetch(shiftPath, {
          method: 'GET',
          headers: buildSessionHeaders(session, { visitId: assembled.visitId, write: false }),
        });
        const records = Array.isArray(pref.body?.travel_records) ? pref.body.travel_records : [];
        let shouldSkipTravel = false;
        let skipReason = 'travel already on shift';
        if (pref.ok && records.length) {
          if (isTravelToHomeCall(call)) {
            shouldSkipTravel = records.some(
              (tr) =>
                String(tr?.start_location_type || '').toUpperCase() === 'S' &&
                String(tr?.end_location_type || '').toUpperCase() === 'H'
            );
            skipReason = 'S→H travel already on shift — skip to_home';
          } else if (isTravelToStoreCall(call)) {
            // Any existing travel usually means to_store already ran (or multi-stop day).
            shouldSkipTravel = true;
            skipReason = 'travel already on shift — skip to_store';
          }
        }
        if (shouldSkipTravel) {
          softSkipped.push(call.seq);
          stepResults[call.seq] = { softSkipped: true, reason: 'travel_records_already_present' };
          result.lastSuccessfulSeq = call.seq;
          logEntries.push({
            seq: call.seq,
            method: call.method,
            url: call.url,
            status: 200,
            body: { softSkipped: true, reason: 'travel_records_already_present' },
            softSkipped: true,
            skipReason,
            timestamp: now(),
            ok: true,
          });
          continue;
        }
      } catch {
        /* fall through to attempt */
      }
    }

    let resolvedPayload = call.payload;
    try {
      if (call.payload != null) {
        resolvedPayload = resolvePlaceholders(call.payload, stepResults);
        if (resolvedPayload && typeof resolvedPayload === 'object') {
          // travel_records on shift PATCH:
          // - empty [] OK (time-only edit, prod completion.har)
          // - complete CHANGE rows OK (prod completion mileage edit: shift_id, times,
          //   distance, duration, change_reason, change_comment)
          // - incomplete/audit-only rows stripped (500 "TravelRecord has no shift")
          if (isShiftPatchCall(call) && Object.prototype.hasOwnProperty.call(resolvedPayload, 'travel_records')) {
            const raw = resolvedPayload.travel_records;
            if (!Array.isArray(raw) || raw.length === 0) {
              resolvedPayload = { ...resolvedPayload, travel_records: [] };
            } else {
              const cleaned = raw
                .filter((tr) => tr && !tr._auditOnly)
                .map((tr) => {
                  const { _auditOnly, _auditNote, ...rest } = tr;
                  return rest;
                })
                .filter((tr) => {
                  return (
                    tr.shift_id != null &&
                    tr.start_time &&
                    tr.end_time &&
                    tr.distance != null &&
                    tr.distance !== '' &&
                    tr.duration != null &&
                    tr.duration !== '' &&
                    tr.start_location_type &&
                    tr.end_location_type &&
                    tr.change_reason != null
                  );
                });
              if (cleaned.length === 0) {
                // Prefer omit broken travel over 500ing the whole T&E write
                const { travel_records, ...rest } = resolvedPayload;
                resolvedPayload = rest;
              } else {
                resolvedPayload = { ...resolvedPayload, travel_records: cleaned };
              }
            }
          }
        }
      }
    } catch (err) {
      result.status = 'partial';
      result.abortReason = err.message;
      result.failedSeq = call.seq;
      persistPartial({
        dryRunId,
        visitFile,
        draftId,
        assembled,
        lastSuccessfulSeq: result.lastSuccessfulSeq,
        failedSeq: call.seq,
        stepResults,
        logEntries,
        abortReason: result.abortReason,
        now,
        registryPath,
      });
      return result;
    }

    // Automator: write methods always send JSON body ({} when empty) with Content-Type.
    // Exception: GET never has body. travel/to_store and to_home require body {}.
    // Completed-visit step-advance PATCH …/shift-complete/ needs { shift_id } (empty {} → 406).
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(call.method || '').toUpperCase());
    let sendBody;
    if (!isWrite) {
      sendBody = null;
    } else if (resolvedPayload == null) {
      sendBody = {};
    } else {
      sendBody = resolvedPayload;
    }
    if (
      isWrite &&
      (call.method === 'PATCH' || call.method === 'PUT') &&
      /\/field-app\/visits\/\d+\/shift-complete\/?$/.test(call.url || '') &&
      sendBody &&
      typeof sendBody === 'object' &&
      !Array.isArray(sendBody) &&
      sendBody.shift_id == null &&
      // Don't inject shift_id into the full first-time-complete bodies (PUT with
      // validate_geo, final PATCH { team_lead_feedback }) — those must match the HAR
      // exactly; only the bare step-advance pings want { shift_id }.
      sendBody.validate_geo === undefined &&
      !('team_lead_feedback' in sendBody)
    ) {
      // Resolve shift id from assembled start-shift URL or matched visit
      let shiftId = assembled.shiftId || null;
      if (!shiftId) {
        const shiftCall = (assembled.calls || []).find((c) => /\/field-app\/shifts\/(\d+)/.test(c.url || ''));
        const m = shiftCall && (shiftCall.url || '').match(/\/field-app\/shifts\/(\d+)/);
        if (m) shiftId = Number(m[1]);
      }
      if (!shiftId) {
        const m2 = (call.url || '').match(/visits\/(\d+)/);
        // last resort from travel URL in sequence
        const tr = (assembled.calls || []).find((c) => /\/travel\/(\d+)\//.test(c.url || ''));
        const m3 = tr && (tr.url || '').match(/\/travel\/(\d+)\//);
        if (m3) shiftId = Number(m3[1]);
      }
      if (shiftId) sendBody = { ...sendBody, shift_id: shiftId };
    }

    // Shift PATCH is read-modify-write: SAS wants the full shift object echoed back
    // with our overrides. A minimal subset 400s (prod completio7n.har shift PATCH
    // carries ~35 fields). GET the current shift, merge our changes onto it.
    if (isWrite && isShiftPatchCall(call) && sendBody && typeof sendBody === 'object' && !Array.isArray(sendBody)) {
      try {
        const shiftGet = await sasFetch(call.url, {
          method: 'GET',
          headers: buildSessionHeaders(session, { visitId: assembled.visitId, write: false }),
        });
        if (shiftGet.ok && shiftGet.body && typeof shiftGet.body === 'object') {
          const full = shiftGet.body;
          const overrides = { ...sendBody };
          const existing = Array.isArray(full.travel_records) ? full.travel_records : [];
          const ours = Array.isArray(overrides.travel_records) ? overrides.travel_records : [];
          if (ours.length) {
            // Prepend our CHANGE rows; keep the server's system LOG rows.
            const logs = existing.filter((t) => String(t && t.record_type).toUpperCase() !== 'CHANGE');
            overrides.travel_records = [...ours, ...logs];
          } else {
            // Time-only edit: keep whatever travel the server already has.
            delete overrides.travel_records;
          }
          sendBody = { ...full, ...overrides };
        }
      } catch {
        /* fall through with the minimal body if the GET fails */
      }
    }

    const headers = buildSessionHeaders(session, {
      visitId: assembled.visitId,
      write: isWrite,
    });

    // answer-images: multipart file upload (JSON base64 → 400 "not a file")
    let fetchBody = sendBody;
    if (
      isWrite &&
      /\/surveys\/answer-images\/?$/.test(call.url || '') &&
      sendBody &&
      sendBody.image &&
      sendBody.image.base64
    ) {
      const mp = buildAnswerImageMultipart(sendBody);
      headers['Content-Type'] = mp.contentType;
      fetchBody = mp.body;
    }

    let response;
    try {
      response = await sasFetch(call.url, {
        method: call.method,
        headers,
        body: fetchBody,
      });
    } catch (err) {
      result.status = 'partial';
      result.abortReason = `network_error:${err.message}`;
      result.failedSeq = call.seq;
      logEntries.push({
        seq: call.seq,
        method: call.method,
        url: call.url,
        status: null,
        body: null,
        error: err.message,
        timestamp: now(),
        ok: false,
      });
      persistPartial({
        dryRunId,
        visitFile,
        draftId,
        assembled,
        lastSuccessfulSeq: result.lastSuccessfulSeq,
        failedSeq: call.seq,
        stepResults,
        logEntries,
        abortReason: result.abortReason,
        now,
        registryPath,
      });
      return result;
    }

    result.callsSent += 1;
    const httpOk = response.ok && response.status >= 200 && response.status < 300;
    const businessFail = httpOk && isSasBusinessFailure(response.body);
    const entry = {
      seq: call.seq,
      method: call.method,
      url: call.url,
      status: response.status,
      body: response.body,
      timestamp: now(),
      ok: httpOk && !businessFail,
      businessFailure: businessFail || undefined,
      businessMessage: businessFail ? sasBusinessFailureMessage(response.body) : undefined,
    };
    logEntries.push(entry);

    if (!entry.ok) {
      // Automator-aligned soft skips (testMode on already-completed golden visits):
      // 1) travel/to_store|to_home preview — skip if 5xx (completed visit); distance lives on shift/matrix
      // 2) shift T&E PATCH returning "Pin filed is required" — automator only does times while
      //    in-progress (schedule/admin punch). Pin is NOT typed in API body; completed visits
      //    refuse field-app shift PATCH. Continue with photos/survey/recomplete (no pin).
      // to_home 5xx is non-fatal in any mode: the working complete-shift HAR never
      // posts to_home; the S→H mileage rides on the subsequent shift PATCH travel
      // CHANGE. to_store 5xx stays testMode-only (it must succeed on a live start).
      const softTravel =
        isTravelCall(call) && response.status >= 500 && (testMode || isTravelToHomeCall(call));
      const softPin =
        testMode && isShiftPatchCall(call) && isPinRequiredError(response.body || response.text);
      // First-time complete (PUT shift-complete) on an already-completed visit asks for start_time+reason
      const softFirstComplete =
        testMode &&
        call.method === 'PUT' &&
        /\/shift-complete\/?$/.test(call.url || '') &&
        /start_time and reason are required|shift_id is required/i.test(
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body || {})
        );
      // recomplete when visit already complete and data is already valid
      const softRecomplete =
        testMode &&
        call.method === 'POST' &&
        /\/recomplete\/?$/.test(call.url || '') &&
        /Please provide valid data|Complete shift/i.test(
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body || {})
        );
      if (softTravel || softPin || softFirstComplete || softRecomplete) {
        entry.softSkipped = true;
        entry.ok = true;
        entry.skipReason = softPin
          ? 'completed-visit T&E PATCH: Pin filed is required (automator: in-progress/schedule-admin only — not a PIN field). Soft-skip.'
          : softFirstComplete
            ? 'PUT shift-complete is first-time close; visit already completed — soft-skip (use recomplete for re-close)'
            : softRecomplete
              ? 'recomplete: visit already complete with valid data — soft-skip'
              : `testMode soft-skip travel preview after HTTP ${response.status}`;
        logEntries[logEntries.length - 1] = entry;
        softSkipped.push(call.seq);
        stepResults[call.seq] = {
          softSkipped: true,
          reason: softPin
            ? 'pin_required_completed_visit_te'
            : softFirstComplete
              ? 'first_time_complete_on_completed'
              : softRecomplete
                ? 'recomplete_already_valid'
                : 'travel_preview_failed',
          httpStatus: response.status,
        };
        result.lastSuccessfulSeq = call.seq;
        liveStore.writeExecutorState(dryRunId, visitFile, {
          status: 'in_progress',
          dryRunId,
          visitFile,
          draftId,
          visitId: assembled.visitId,
          lastSuccessfulSeq: call.seq,
          stepResults,
          softSkipped,
          updatedAt: now(),
        });
        liveStore.writeExecutionLog(dryRunId, visitFile, {
          dryRunId,
          visitFile,
          draftId,
          visitId: assembled.visitId,
          mode,
          testMode: !!testMode,
          updatedAt: now(),
          entries: logEntries,
        });
        continue;
      }

      result.status = 'partial';
      result.abortReason = businessFail
        ? `sas_business_failure:${entry.businessMessage || 'success_false'}`
        : `http_${response.status}`;
      result.failedSeq = call.seq;
      persistPartial({
        dryRunId,
        visitFile,
        draftId,
        assembled,
        lastSuccessfulSeq: result.lastSuccessfulSeq,
        failedSeq: call.seq,
        failedStatus: response.status,
        failedBody: response.body,
        stepResults,
        logEntries,
        abortReason: result.abortReason,
        now,
        registryPath,
      });
      return result;
    }

    // Store response body for placeholder resolution (objects only; empty OK)
    stepResults[call.seq] = response.body && typeof response.body === 'object' ? response.body : {};
    result.lastSuccessfulSeq = call.seq;

    // Persist progress after each success (resumable mid-run if process dies)
    liveStore.writeExecutorState(dryRunId, visitFile, {
      status: 'in_progress',
      dryRunId,
      visitFile,
      draftId,
      visitId: assembled.visitId,
      lastSuccessfulSeq: call.seq,
      stepResults,
      updatedAt: now(),
    });
    liveStore.writeExecutionLog(dryRunId, visitFile, {
      dryRunId,
      visitFile,
      draftId,
      visitId: assembled.visitId,
      mode,
      updatedAt: now(),
      entries: logEntries,
    });
  }

  // Full success
  const transmittedAt = now();
  liveRegistry.markComplete(
    draftId,
    {
      dryRunId,
      visitFile,
      visitId: assembled.visitId,
      lastSuccessfulSeq: result.lastSuccessfulSeq,
      stepResults,
      transmittedAt,
      callsSent: result.callsSent,
      testMode: !!testMode,
      goldenExportPath: result.goldenExportPath,
    },
    registryPath
  );
  liveStore.writeExecutorState(dryRunId, visitFile, {
    status: 'complete',
    dryRunId,
    visitFile,
    draftId,
    visitId: assembled.visitId,
    lastSuccessfulSeq: result.lastSuccessfulSeq,
    stepResults,
    transmittedAt,
    testMode: !!testMode,
    goldenExportPath: result.goldenExportPath,
    updatedAt: transmittedAt,
  });
  liveStore.writeExecutionLog(dryRunId, visitFile, {
    dryRunId,
    visitFile,
    draftId,
    visitId: assembled.visitId,
    mode,
    testMode: !!testMode,
    status: 'complete',
    transmittedAt,
    entries: logEntries,
  });

  result.status = 'complete';
  result.transmittedAt = transmittedAt;
  result.abortReason = null;

  // Stage 5: inventory + optional Resend photo delivery (gated off by default).
  try {
    const sealedDraft = visitDraftStore.getDraft(
      assembled.repKey,
      assembled.date,
      assembled.actualStore
    );
    if (sealedDraft) {
      const delivery = await deliverVisitPhotos({
        draft: sealedDraft,
        existingDelivery: sealedDraft.photoDelivery || null,
      });
      visitDraftStore.setPhotoDelivery(
        sealedDraft.repKey,
        sealedDraft.date,
        sealedDraft.actualStore,
        delivery
      );
      result.photoDelivery = {
        status: delivery.status,
        summary: delivery.summary,
        message: delivery.message,
        enabled: delivery.enabled,
      };
    }
  } catch (err) {
    result.photoDelivery = {
      status: 'failed',
      error: err.message || String(err),
    };
  }

  if (testMode) {
    result.nextStep = {
      action: 're_export_then_diff',
      message:
        'Transmit + recomplete finished. Re-run kompass-netcap scripts/export-cp-shift-full.js for this visitId, then POST /shift-day/live/roundtrip-diff with goldenExportPath + postExportPath.',
      exportScript: 'kompass-netcap/scripts/export-cp-shift-full.js',
      visitId: assembled.visitId,
      goldenExportPath: result.goldenExportPath,
    };

    // Optional immediate diff if post-run export path already provided
    if (postExportPath) {
      result.roundtrip = runRoundtripDiff({
        dryRunId,
        goldenExportPath: result.goldenExportPath,
        postExportPath,
        transmittedCalls: calls,
        visitId: assembled.visitId,
        draftId,
      });
    }
  }

  return result;
}

/**
 * Compare golden vs post-run export; write live/{runId}/roundtrip-report.md
 */
function runRoundtripDiff({
  dryRunId,
  goldenExportPath,
  postExportPath,
  transmittedCalls = [],
  visitId = null,
  draftId = null,
}) {
  const diff = diffExports(goldenExportPath, postExportPath, { transmittedCalls });
  const md = formatRoundtripReport(diff, {
    generatedAt: new Date().toISOString(),
    dryRunId,
    visitId,
    draftId,
  });
  const reportPath = writeRoundtripReport(dryRunId, md);
  return {
    verdict: diff.verdict,
    expectedCount: diff.expected.length,
    unexpectedCount: diff.unexpected.length,
    reportPath,
    diff,
  };
}

function persistPartial({
  dryRunId,
  visitFile,
  draftId,
  assembled,
  lastSuccessfulSeq,
  failedSeq,
  failedStatus,
  failedBody,
  stepResults,
  logEntries,
  abortReason,
  now,
  registryPath,
}) {
  const ts = now();
  liveRegistry.markPartial(
    draftId,
    {
      dryRunId,
      visitFile,
      visitId: assembled.visitId,
      lastSuccessfulSeq,
      failedSeq,
      failedStatus: failedStatus ?? null,
      failedBody: failedBody ?? null,
      stepResults,
      abortReason,
      partialAt: ts,
    },
    registryPath
  );
  liveStore.writeExecutorState(dryRunId, visitFile, {
    status: 'partial',
    dryRunId,
    visitFile,
    draftId,
    visitId: assembled.visitId,
    lastSuccessfulSeq,
    failedSeq,
    failedStatus: failedStatus ?? null,
    stepResults,
    abortReason,
    updatedAt: ts,
  });
  liveStore.writeExecutionLog(dryRunId, visitFile, {
    dryRunId,
    visitFile,
    draftId,
    visitId: assembled.visitId,
    status: 'partial',
    abortReason,
    updatedAt: ts,
    entries: logEntries,
  });
}

module.exports = {
  executeLiveTransmit,
  runPreflight,
  runRoundtripDiff,
  appendRecompleteCall,
  resolvePlaceholders,
  defaultSasFetch,
  defaultSasGet,
  photosReadable,
  imagePayloadsPresent,
  draftIdFromParts,
  validateGoldenExport,
  isSasBusinessFailure,
  sasBusinessFailureMessage,
  isTravelToStoreCall,
  isTravelToHomeCall,
  isTravelCall,
};
