'use strict';

const fs = require('fs');
const path = require('path');
const {
  STEP,
  buildStepSequence,
  tagPhoto,
  surveyAutoFill,
  listUnmetRequirements,
  canSeal,
  enrichDraftForUi,
} = require('./visit-flow');

const ROOT = path.join(__dirname, '../../data/visit-drafts');

/* ---------- Paths (per-rep isolation is the scope boundary) ---------- */

function safeSeg(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function draftDir(repKey) {
  return path.join(ROOT, safeSeg(repKey));
}

function draftBaseName(date, actualStore) {
  return `${safeSeg(date)}-${safeSeg(actualStore)}`;
}

function draftFilePath(repKey, date, actualStore) {
  return path.join(draftDir(repKey), `${draftBaseName(date, actualStore)}.json`);
}

function photoDirPath(repKey, date, actualStore) {
  return path.join(draftDir(repKey), `${draftBaseName(date, actualStore)}-photos`);
}

function draftId(repKey, date, actualStore) {
  return `${repKey}/${draftBaseName(date, actualStore)}`;
}

/* ---------- Read / write ---------- */

function readDraftFile(repKey, date, actualStore) {
  const file = draftFilePath(repKey, date, actualStore);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeDraftFile(draft) {
  const file = draftFilePath(draft.repKey, draft.date, draft.actualStore);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  draft.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(draft, null, 2));
  return draft;
}

function getDraft(repKey, date, actualStore) {
  return readDraftFile(repKey, date, actualStore);
}

function assertMutable(draft) {
  if (!draft) throw new Error('Draft not found — start the visit first');
  if (draft.status === 'ready_for_prod') {
    throw new Error('Visit is sealed and immutable — start a new visit to make changes');
  }
}

/* ---------- Start / resume ---------- */

/**
 * Start (or resume) a visit draft. Local start only — records a timestamp,
 * never touches prod. If a draft already exists for this rep/date/store,
 * it is returned unchanged (resume-in-place, including mid-branch).
 */
function startVisit({
  repKey,
  weekStart,
  shiftId,
  date,
  actualStore,
  scheduledStore = null,
  writeOrder = false,
  workLoad = false,
  picksDay = null,
  startedAt = null,
  startedBy = null,
}) {
  if (!repKey) throw new Error('repKey required');
  if (!date) throw new Error('date required');
  if (actualStore == null) throw new Error('actualStore (decoded) required');

  const existing = readDraftFile(repKey, date, actualStore);
  if (existing) return existing;

  const steps = buildStepSequence({ workLoad: !!workLoad, writeOrder: !!writeOrder });
  const now = new Date().toISOString();

  const draft = {
    id: draftId(repKey, date, actualStore),
    repKey,
    weekStart: weekStart || null,
    shiftId: shiftId || null,
    date,
    scheduledStore: scheduledStore != null ? Number(scheduledStore) : null,
    actualStore: Number(actualStore),
    writeOrder: !!writeOrder,
    workLoad: !!workLoad,
    picksDay: picksDay || null,
    steps,
    currentStep: steps[0],
    status: 'in_progress',
    startedAt: startedAt || now,
    startedBy: startedBy || null,
    visitStart: { actual: startedAt || now, source: 'start_tap', note: null },
    visitStop: { actual: null, note: null },
    beforePhotos: [],
    afterPhotos: [],
    loadCheck: workLoad ? { status: null, photo: null, updatedAt: null } : null,
    checklist: {},
    categoryPhotos: {},
    survey: {},
    isLastStopOfDay: false,
    mileage: { leg: null, repNote: null },
    createdAt: now,
    updatedAt: now,
    sealedAt: null,
  };

  return writeDraftFile(draft);
}

/* ---------- Mutations (each call IS the autosave for that discrete action) ---------- */

function mutate(repKey, date, actualStore, fn) {
  const draft = readDraftFile(repKey, date, actualStore);
  assertMutable(draft);
  fn(draft);
  return writeDraftFile(draft);
}

function savePhotoBuffer(repKey, date, actualStore, buffer, ext = 'jpg') {
  const dir = photoDirPath(repKey, date, actualStore);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext.replace(/^\./, '')}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return path.relative(path.join(__dirname, '../..'), path.join(dir, filename)).split(path.sep).join('/');
}

/** Apply the Q1/Q12 auto-fill rule in place (add or remove photos flips answers). */
function applySurveyAutoFill(draft) {
  const patch = surveyAutoFill(draft.survey, {
    hasBeforePhotos: draft.beforePhotos.length > 0,
    hasAfterPhotos: draft.afterPhotos.length > 0,
  });
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete draft.survey[k];
    else draft.survey[k] = v;
  }
}

function recordBeforePhoto(repKey, date, actualStore, { photoPath }) {
  return mutate(repKey, date, actualStore, (draft) => {
    const seq = draft.beforePhotos.length + 1;
    const tag = tagPhoto({ store: draft.actualStore, date: draft.date, category: 'before', seq });
    draft.beforePhotos.push({ path: photoPath, ...tag, capturedAt: new Date().toISOString() });
    applySurveyAutoFill(draft);
  });
}

function recordAfterPhoto(repKey, date, actualStore, { photoPath }) {
  return mutate(repKey, date, actualStore, (draft) => {
    const seq = draft.afterPhotos.length + 1;
    const tag = tagPhoto({ store: draft.actualStore, date: draft.date, category: 'after', seq });
    draft.afterPhotos.push({ path: photoPath, ...tag, capturedAt: new Date().toISOString() });
    applySurveyAutoFill(draft);
  });
}

/** Remove a before photo by seq (or last if omitted). Free-nav: Q1 clears when none remain. */
function removeBeforePhoto(repKey, date, actualStore, { seq } = {}) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.beforePhotos.length) return;
    if (seq != null) {
      draft.beforePhotos = draft.beforePhotos.filter((p) => Number(p.seq) !== Number(seq));
    } else {
      draft.beforePhotos.pop();
    }
    // Re-number seqs for stable UI labels
    draft.beforePhotos.forEach((p, i) => {
      p.seq = i + 1;
    });
    applySurveyAutoFill(draft);
  });
}

/** Remove an after photo by seq (or last if omitted). Free-nav: Q12 clears when none remain. */
function removeAfterPhoto(repKey, date, actualStore, { seq } = {}) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.afterPhotos.length) return;
    if (seq != null) {
      draft.afterPhotos = draft.afterPhotos.filter((p) => Number(p.seq) !== Number(seq));
    } else {
      draft.afterPhotos.pop();
    }
    draft.afterPhotos.forEach((p, i) => {
      p.seq = i + 1;
    });
    applySurveyAutoFill(draft);
  });
}

function recordCategoryPhoto(repKey, date, actualStore, categoryId, { photoPath }) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.categoryPhotos[categoryId]) draft.categoryPhotos[categoryId] = [];
    const seq = draft.categoryPhotos[categoryId].length + 1;
    const tag = tagPhoto({ store: draft.actualStore, date: draft.date, category: categoryId, seq });
    draft.categoryPhotos[categoryId].push({ path: photoPath, ...tag, capturedAt: new Date().toISOString() });
  });
}

function recordChecklistPhoto(repKey, date, actualStore, itemId, { photoPath }) {
  return mutate(repKey, date, actualStore, (draft) => {
    const existing = draft.checklist[itemId] || { checked: false, photo: null, ackAt: null };
    const seq = 1;
    const tag = tagPhoto({ store: draft.actualStore, date: draft.date, category: `checklist-${itemId}`, seq });
    existing.photo = { path: photoPath, ...tag, capturedAt: new Date().toISOString() };
    draft.checklist[itemId] = existing;
  });
}

function setLoadCheck(repKey, date, actualStore, { status, photoPath = undefined }) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.loadCheck) draft.loadCheck = { status: null, photo: null, updatedAt: null };
    draft.loadCheck.status = status;
    if (photoPath !== undefined) {
      const tag = tagPhoto({ store: draft.actualStore, date: draft.date, category: 'load', seq: 1 });
      draft.loadCheck.photo = { path: photoPath, ...tag, capturedAt: new Date().toISOString() };
    }
    draft.loadCheck.updatedAt = new Date().toISOString();
  });
}

function setChecklistItem(repKey, date, actualStore, itemId, { checked }) {
  return mutate(repKey, date, actualStore, (draft) => {
    const existing = draft.checklist[itemId] || { checked: false, photo: null, ackAt: null };
    existing.checked = !!checked;
    existing.ackAt = new Date().toISOString();
    draft.checklist[itemId] = existing;
  });
}

function setSurveyAnswer(repKey, date, actualStore, questionId, value) {
  return mutate(repKey, date, actualStore, (draft) => {
    draft.survey[questionId] = value;
  });
}

function setSurveyAnswers(repKey, date, actualStore, patch) {
  return mutate(repKey, date, actualStore, (draft) => {
    Object.assign(draft.survey, patch);
  });
}

function setTimes(repKey, date, actualStore, { startActual, startNote, stopActual, stopNote, isLastStopOfDay } = {}) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (startActual !== undefined) draft.visitStart.actual = startActual;
    if (startNote !== undefined) draft.visitStart.note = startNote;
    if (startActual !== undefined) draft.visitStart.source = 'manual';
    if (stopActual !== undefined) draft.visitStop.actual = stopActual;
    if (stopNote !== undefined) draft.visitStop.note = stopNote;
    if (isLastStopOfDay !== undefined) draft.isLastStopOfDay = !!isLastStopOfDay;
  });
}

function setMileage(repKey, date, actualStore, { leg, repNote } = {}) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (leg !== undefined) draft.mileage.leg = leg;
    if (repNote !== undefined) draft.mileage.repNote = repNote;
  });
}

/**
 * Free navigation: any section in this visit's step list is always reachable.
 * No forward-locking / "complete this first" gates.
 */
function goToStep(repKey, date, actualStore, stepId) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.steps.includes(stepId)) throw new Error(`Unknown step for this visit: ${stepId}`);
    draft.currentStep = stepId;
  });
}

/**
 * Seal-time is the only gate. Incomplete drafts throw with code SEAL_BLOCKED
 * and an `unmet` array grouped by section (same shape as listUnmetRequirements).
 */
function finishVisit(repKey, date, actualStore) {
  const draft = readDraftFile(repKey, date, actualStore);
  assertMutable(draft);
  const unmet = listUnmetRequirements(draft);
  if (unmet.length) {
    const err = new Error('Visit cannot be sealed — requirements unmet');
    err.code = 'SEAL_BLOCKED';
    err.unmet = unmet;
    throw err;
  }
  return mutate(repKey, date, actualStore, (d) => {
    d.status = 'ready_for_prod';
    d.sealedAt = new Date().toISOString();
    d.currentStep = STEP.REVIEW;
  });
}

/* ---------- Listing (in-progress pill indicator + admin read-only view) ---------- */

function summarize(draft) {
  const pd = draft.photoDelivery || null;
  return {
    id: draft.id,
    repKey: draft.repKey,
    date: draft.date,
    actualStore: draft.actualStore,
    scheduledStore: draft.scheduledStore,
    status: draft.status,
    currentStep: draft.currentStep,
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
    sealedAt: draft.sealedAt,
    photoDelivery: pd
      ? {
          status: pd.status,
          enabled: pd.enabled,
          lastRunAt: pd.lastRunAt || null,
          summary: pd.summary || null,
          message: pd.message || null,
        }
      : null,
  };
}

/**
 * Stage 5 bookkeeping: photo-delivery state may be written after seal.
 * Does not re-open content fields (photos, survey, etc.).
 */
function setPhotoDelivery(repKey, date, actualStore, photoDelivery) {
  const draft = readDraftFile(repKey, date, actualStore);
  if (!draft) throw new Error('Draft not found');
  draft.photoDelivery = photoDelivery;
  return writeDraftFile(draft);
}

function listDraftsForRep(repKey) {
  const dir = draftDir(repKey);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** Most recently completed (stopActual set) visit for this rep/day, excluding one store. */
function previousCompletedStoreForDay(repKey, date, { excludeActualStore = null, beforeIso = null } = {}) {
  const drafts = listDraftsForRep(repKey).filter(
    (d) =>
      d.date === date &&
      (excludeActualStore == null || Number(d.actualStore) !== Number(excludeActualStore)) &&
      d.visitStop?.actual
  );
  const filtered = beforeIso ? drafts.filter((d) => d.visitStop.actual < beforeIso) : drafts;
  if (!filtered.length) return null;
  filtered.sort((a, b) => (a.visitStop.actual < b.visitStop.actual ? 1 : -1));
  return filtered[0].actualStore;
}

/**
 * Discard an in-progress visit draft (and its photo folder).
 * Sealed visits (ready_for_prod) cannot be abandoned.
 */
function abandonVisit(repKey, date, actualStore) {
  if (!repKey) throw new Error('repKey required');
  if (!date) throw new Error('date required');
  if (actualStore == null) throw new Error('actualStore required');

  const draft = readDraftFile(repKey, date, actualStore);
  if (!draft) {
    const err = new Error('No visit draft to discard');
    err.code = 'NO_DRAFT';
    throw err;
  }
  if (draft.status === 'ready_for_prod') {
    const err = new Error('This visit is sealed and cannot be discarded');
    err.code = 'SEALED';
    throw err;
  }

  const file = draftFilePath(repKey, date, actualStore);
  const photos = photoDirPath(repKey, date, actualStore);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  if (fs.existsSync(photos)) fs.rmSync(photos, { recursive: true, force: true });

  return {
    ok: true,
    abandonedId: draft.id,
    repKey,
    date,
    actualStore: Number(actualStore),
  };
}

/** Admin-only, read-only: every draft/record across every rep (Planning Desk). */
function listAllDrafts() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const repDir of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, repDir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.json')) continue;
      out.push(summarize(JSON.parse(fs.readFileSync(path.join(full, f), 'utf8'))));
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

module.exports = {
  ROOT,
  draftId,
  draftFilePath,
  photoDirPath,
  getDraft,
  startVisit,
  savePhotoBuffer,
  recordBeforePhoto,
  recordAfterPhoto,
  removeBeforePhoto,
  removeAfterPhoto,
  recordCategoryPhoto,
  recordChecklistPhoto,
  setLoadCheck,
  setChecklistItem,
  setSurveyAnswer,
  setSurveyAnswers,
  setTimes,
  setMileage,
  goToStep,
  finishVisit,
  abandonVisit,
  listDraftsForRep,
  listAllDrafts,
  previousCompletedStoreForDay,
  summarize,
  setPhotoDelivery,
  listUnmetRequirements,
  canSeal,
  enrichDraftForUi,
  STEP,
};
