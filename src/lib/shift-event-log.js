'use strict';

/**
 * Verbose shift audit log (shift_events) + carry-forward store notes (store_notes).
 *
 * Primary store is the Railway Postgres via src/lib/db.js. When DATABASE_URL is
 * absent (local dev), everything degrades to JSON files under data/ so the app —
 * and its tests — work without a database. All writes are best-effort: a DB
 * hiccup must never block a rep from sealing a shift, so callers wrap in try/catch
 * and these functions also swallow+log their own errors.
 */

const fs = require('fs');
const path = require('path');
const { getPool, query } = require('./db');

const SQL_PATH = path.join(__dirname, '../../scripts/init-shift-events.sql');
// Paths are env-overridable so tests can point the JSON fallback at a temp dir.
const EVENTS_JSON = process.env.SHIFT_EVENTS_JSON || path.join(__dirname, '../../data/shift-events.json');
const STORE_NOTES_JSON = process.env.STORE_NOTES_JSON || path.join(__dirname, '../../data/store-notes.json');

function hasDb() {
  return !!getPool();
}

/* ---------- JSON fallback helpers ---------- */

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[shift-event-log] could not read ${path.basename(file)}:`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ---------- Boot ---------- */

async function ensureTables() {
  if (!hasDb()) {
    console.log('[shift-event-log] no DATABASE_URL — using JSON fallback (data/shift-events.json, data/store-notes.json)');
    return;
  }
  try {
    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    await query(sql);
    console.log('[shift-event-log] shift_events + store_notes tables ready');
  } catch (err) {
    console.error('[shift-event-log] ensureTables failed:', err.message);
  }
}

/* ---------- Draft -> event mapping ---------- */

function processesOf(draft) {
  const p = [];
  if (draft.workLoad) p.push('workLoad');
  if (draft.writeOrder) p.push('writeOrder');
  if (draft.picksDay) p.push('picks');
  return p.join(',');
}

function splitOutcomes(outcomes) {
  const did = [];
  const variances = [];
  for (const o of outcomes || []) {
    const label = o.label || o.optionId || '';
    if (!label) continue;
    (o.kind === 'variance' ? variances : did).push(label);
  }
  return { outcome_summary: did.join('; '), variance_summary: variances.join('; ') };
}

/** Build the flat event record from a sealed draft. */
function eventFromDraft(draft, { eventType, repEmail, visitId, shiftId } = {}) {
  const { outcome_summary, variance_summary } = splitOutcomes(draft.shiftLog?.outcomes);
  const redirected =
    draft.scheduledStore != null && Number(draft.scheduledStore) !== Number(draft.actualStore);
  return {
    draft_id: draft.id,
    event_type: eventType || 'sealed',
    rep_key: draft.repKey,
    rep_email: repEmail || null,
    shift_date: draft.date,
    scheduled_store: draft.scheduledStore ?? null,
    actual_store: draft.actualStore,
    redirected,
    visit_id: visitId ?? null,
    shift_id: shiftId ?? null,
    processes: processesOf(draft),
    start_actual: draft.visitStart?.actual || null,
    stop_actual: draft.visitStop?.actual || null,
    mileage_miles: draft.mileage?.leg?.miles ?? null,
    outcome_summary,
    variance_summary,
    custom_note: draft.shiftLog?.custom || null,
    next_visit_note: draft.nextVisitNote || null,
    stage_notes: draft.stageNotes || {},
    survey: draft.survey || {},
    payload: draft,
    sealed_at: draft.sealedAt || null,
    transmitted_at: eventType === 'transmitted' ? new Date().toISOString() : null,
  };
}

/* ---------- shift_events ---------- */

const UPSERT_SQL = `
INSERT INTO shift_events (
  draft_id, event_type, rep_key, rep_email, shift_date, scheduled_store, actual_store,
  redirected, visit_id, shift_id, processes, start_actual, stop_actual, mileage_miles,
  outcome_summary, variance_summary, custom_note, next_visit_note, stage_notes, survey,
  payload, sealed_at, transmitted_at
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
)
ON CONFLICT (draft_id) DO UPDATE SET
  event_type = EXCLUDED.event_type,
  rep_email = COALESCE(EXCLUDED.rep_email, shift_events.rep_email),
  shift_date = EXCLUDED.shift_date,
  scheduled_store = EXCLUDED.scheduled_store,
  actual_store = EXCLUDED.actual_store,
  redirected = EXCLUDED.redirected,
  visit_id = COALESCE(EXCLUDED.visit_id, shift_events.visit_id),
  shift_id = COALESCE(EXCLUDED.shift_id, shift_events.shift_id),
  processes = EXCLUDED.processes,
  start_actual = EXCLUDED.start_actual,
  stop_actual = EXCLUDED.stop_actual,
  mileage_miles = EXCLUDED.mileage_miles,
  outcome_summary = EXCLUDED.outcome_summary,
  variance_summary = EXCLUDED.variance_summary,
  custom_note = EXCLUDED.custom_note,
  next_visit_note = EXCLUDED.next_visit_note,
  stage_notes = EXCLUDED.stage_notes,
  survey = EXCLUDED.survey,
  payload = EXCLUDED.payload,
  sealed_at = COALESCE(EXCLUDED.sealed_at, shift_events.sealed_at),
  transmitted_at = COALESCE(EXCLUDED.transmitted_at, shift_events.transmitted_at),
  updated_at = NOW()
`;

async function recordShiftEvent(draft, meta = {}) {
  if (!draft || !draft.id) return { ok: false, reason: 'no_draft' };
  const ev = eventFromDraft(draft, meta);
  if (!hasDb()) {
    const all = readJson(EVENTS_JSON, {});
    const existing = all[ev.draft_id] || {};
    all[ev.draft_id] = {
      ...existing,
      ...ev,
      visit_id: ev.visit_id ?? existing.visit_id ?? null,
      shift_id: ev.shift_id ?? existing.shift_id ?? null,
      transmitted_at: ev.transmitted_at || existing.transmitted_at || null,
      sealed_at: ev.sealed_at || existing.sealed_at || null,
      updated_at: new Date().toISOString(),
    };
    writeJson(EVENTS_JSON, all);
    return { ok: true, store: 'json' };
  }
  try {
    await query(UPSERT_SQL, [
      ev.draft_id, ev.event_type, ev.rep_key, ev.rep_email, ev.shift_date,
      ev.scheduled_store, ev.actual_store, ev.redirected, ev.visit_id, ev.shift_id,
      ev.processes, ev.start_actual, ev.stop_actual, ev.mileage_miles,
      ev.outcome_summary, ev.variance_summary, ev.custom_note, ev.next_visit_note,
      JSON.stringify(ev.stage_notes), JSON.stringify(ev.survey), JSON.stringify(ev.payload),
      ev.sealed_at, ev.transmitted_at,
    ]);
    return { ok: true, store: 'pg' };
  } catch (err) {
    console.error('[shift-event-log] recordShiftEvent failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

/** Query events by inclusive shift_date range (YYYY-MM-DD). */
async function queryShiftEvents({ start, end } = {}) {
  if (!hasDb()) {
    const all = Object.values(readJson(EVENTS_JSON, {}));
    return all
      .filter((e) => (!start || e.shift_date >= start) && (!end || e.shift_date <= end))
      .sort((a, b) =>
        a.shift_date === b.shift_date
          ? Number(a.actual_store) - Number(b.actual_store)
          : a.shift_date < b.shift_date ? -1 : 1
      );
  }
  const clauses = [];
  const params = [];
  if (start) { params.push(start); clauses.push(`shift_date >= $${params.length}`); }
  if (end) { params.push(end); clauses.push(`shift_date <= $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM shift_events ${where} ORDER BY shift_date ASC, actual_store ASC`,
    params
  );
  return rows;
}

/* ---------- store_notes (carry-forward) ---------- */

async function addStoreNote({ store, note, rep = null, draftId = null } = {}) {
  const storeNum = Number(store);
  const text = (note == null ? '' : String(note)).trim();
  if (!Number.isFinite(storeNum)) throw new Error('store required');
  if (!text) throw new Error('note text required');
  if (!hasDb()) {
    const all = readJson(STORE_NOTES_JSON, { notes: [] });
    const id = (all.notes.reduce((m, n) => Math.max(m, n.id || 0), 0) || 0) + 1;
    const row = {
      id, store: storeNum, note: text, created_by_rep: rep, created_from_draft: draftId,
      created_at: new Date().toISOString(), resolved_at: null, resolved_by: null,
    };
    all.notes.push(row);
    writeJson(STORE_NOTES_JSON, all);
    return row;
  }
  const { rows } = await query(
    `INSERT INTO store_notes (store, note, created_by_rep, created_from_draft)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [storeNum, text, rep, draftId]
  );
  return rows[0];
}

async function listActiveStoreNotes(store) {
  const storeNum = Number(store);
  if (!Number.isFinite(storeNum)) return [];
  if (!hasDb()) {
    const all = readJson(STORE_NOTES_JSON, { notes: [] });
    return all.notes
      .filter((n) => Number(n.store) === storeNum && !n.resolved_at)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  const { rows } = await query(
    `SELECT * FROM store_notes WHERE store = $1 AND resolved_at IS NULL ORDER BY created_at DESC`,
    [storeNum]
  );
  return rows;
}

async function resolveStoreNote(id, rep = null) {
  const noteId = Number(id);
  if (!Number.isFinite(noteId)) throw new Error('note id required');
  if (!hasDb()) {
    const all = readJson(STORE_NOTES_JSON, { notes: [] });
    const row = all.notes.find((n) => Number(n.id) === noteId);
    if (!row) return null;
    row.resolved_at = new Date().toISOString();
    row.resolved_by = rep;
    writeJson(STORE_NOTES_JSON, all);
    return row;
  }
  const { rows } = await query(
    `UPDATE store_notes SET resolved_at = NOW(), resolved_by = $2 WHERE id = $1 RETURNING *`,
    [noteId, rep]
  );
  return rows[0] || null;
}

module.exports = {
  ensureTables,
  eventFromDraft,
  recordShiftEvent,
  queryShiftEvents,
  addStoreNote,
  listActiveStoreNotes,
  resolveStoreNote,
  processesOf,
  splitOutcomes,
  hasDb,
  EVENTS_JSON,
  STORE_NOTES_JSON,
};
