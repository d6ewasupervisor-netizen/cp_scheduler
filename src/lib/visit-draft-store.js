'use strict';

const fs = require('fs');
const path = require('path');
const {
  STEP,
  buildStepSequence,
  normalizeCurrentStep,
  tagPhoto,
  surveyAutoFill,
  listUnmetRequirements,
  canSeal,
  enrichDraftForUi,
  OPTIONAL_FIXTURE_GROUPS,
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
  const draft = readDraftFile(repKey, date, actualStore);
  if (!draft) return null;
  return migrateDraftSteps(draft);
}

/**
 * Migrate in-progress drafts to the single-page visit flow.
 * Drops legacy steps (load, checklist, outcome, review) from navigation.
 */
function migrateDraftSteps(draft) {
  if (!draft) return draft;
  const canonicalSteps = buildStepSequence({});
  let changed = false;
  const next = { ...draft };

  const legacyInSteps =
    next.steps?.includes(STEP.CATEGORY_PHOTOS) ||
    next.steps?.includes(STEP.LOAD_CHECK) ||
    next.steps?.includes(STEP.WRITE_ORDER_CHECKLIST) ||
    next.steps?.includes(STEP.SHIFT_LOG) ||
    next.steps?.includes(STEP.REVIEW) ||
    JSON.stringify(next.steps) !== JSON.stringify(canonicalSteps);

  if (legacyInSteps) {
    next.steps = canonicalSteps;
    changed = true;
  }

  const normalizedStep = normalizeCurrentStep(next.currentStep, next.steps);
  if (normalizedStep !== next.currentStep) {
    next.currentStep = normalizedStep;
    changed = true;
  }

  if (changed && draft.status !== 'ready_for_prod') {
    try {
      writeDraftFile(next);
    } catch {
      /* read path should still return migrated view */
    }
  }
  return next;
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
  if (existing) return migrateDraftSteps(existing);

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
    optionalFixtures: {},
    survey: {},
    shiftLog: { outcomes: [], custom: '' },
    stageNotes: {},
    nextVisitNote: null,
    isLastStopOfDay: false,
    mileage: { leg: null, legs: [], repNote: null },
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
    let removed = null;
    if (seq != null) {
      const idx = draft.afterPhotos.findIndex((p) => Number(p.seq) === Number(seq));
      if (idx >= 0) removed = draft.afterPhotos.splice(idx, 1)[0];
    } else {
      removed = draft.afterPhotos.pop();
    }
    draft.afterPhotos.forEach((p, i) => {
      p.seq = i + 1;
    });
    // Category picks are drawn from afters — drop assignments that used the removed file.
    if (removed?.path) {
      for (const catId of Object.keys(draft.categoryPhotos || {})) {
        const arr = draft.categoryPhotos[catId] || [];
        draft.categoryPhotos[catId] = arr.filter((p) => p.path !== removed.path);
        draft.categoryPhotos[catId].forEach((p, i) => {
          p.seq = i + 1;
        });
      }
    }
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

/**
 * Assign an existing after photo to a category target (no new capture).
 * Reuses the same file path so category picks are a selection over afters.
 */
function assignCategoryFromAfter(repKey, date, actualStore, categoryId, { afterSeq }) {
  if (!categoryId) throw new Error('categoryId required');
  if (afterSeq == null) throw new Error('afterSeq required');
  return mutate(repKey, date, actualStore, (draft) => {
    const after = (draft.afterPhotos || []).find((p) => Number(p.seq) === Number(afterSeq));
    if (!after?.path) throw new Error(`After photo #${afterSeq} not found`);
    if (!draft.categoryPhotos[categoryId]) draft.categoryPhotos[categoryId] = [];
    const already = draft.categoryPhotos[categoryId].some(
      (p) => p.path === after.path || Number(p.fromAfterSeq) === Number(after.seq)
    );
    if (already) return;
    const seq = draft.categoryPhotos[categoryId].length + 1;
    const tag = tagPhoto({ store: draft.actualStore, date: draft.date, category: categoryId, seq });
    draft.categoryPhotos[categoryId].push({
      path: after.path,
      ...tag,
      fromAfterSeq: after.seq,
      capturedAt: after.capturedAt || new Date().toISOString(),
    });
  });
}

/** Remove a category assignment by seq (does not delete the after photo file). */
function removeCategoryPhoto(repKey, date, actualStore, categoryId, { seq } = {}) {
  if (!categoryId) throw new Error('categoryId required');
  return mutate(repKey, date, actualStore, (draft) => {
    const arr = draft.categoryPhotos?.[categoryId] || [];
    if (!arr.length) return;
    if (seq != null) {
      draft.categoryPhotos[categoryId] = arr.filter((p) => Number(p.seq) !== Number(seq));
    } else {
      draft.categoryPhotos[categoryId] = arr.slice(0, -1);
    }
    draft.categoryPhotos[categoryId].forEach((p, i) => {
      p.seq = i + 1;
    });
  });
}

/** Clear every photo in a category bucket (AI re-sort). */
function clearCategoryPhotos(repKey, date, actualStore, categoryId) {
  if (!categoryId) throw new Error('categoryId required');
  return mutate(repKey, date, actualStore, (draft) => {
    draft.categoryPhotos[categoryId] = [];
  });
}

function setPhotoClassification(repKey, date, actualStore, meta) {
  return mutate(repKey, date, actualStore, (draft) => {
    draft.photoClassification = meta || null;
  });
}

/**
 * Resolve a draft photo file under the visit photo dir (path-traversal safe).
 * @returns {{ absPath: string, filename: string } | null}
 */
function resolvePhotoFile(repKey, date, actualStore, fileOrRelativePath) {
  if (!fileOrRelativePath) return null;
  const draft = readDraftFile(repKey, date, actualStore);
  if (!draft) return null;
  const base = path.basename(String(fileOrRelativePath).replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return null;
  const dir = path.resolve(photoDirPath(repKey, date, actualStore));
  const abs = path.resolve(dir, base);
  const rel = path.relative(dir, abs);
  // Must stay inside this visit's photo directory
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return { absPath: abs, filename: base };
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

function setMileage(repKey, date, actualStore, { leg, legs, repNote } = {}) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (legs !== undefined) {
      const list = Array.isArray(legs) ? legs.filter(Boolean) : [];
      draft.mileage.legs = list;
      // Primary display leg = last (outbound home on last-stop, else the only inbound).
      draft.mileage.leg = list.length ? list[list.length - 1] : null;
    } else if (leg !== undefined) {
      draft.mileage.leg = leg;
      draft.mileage.legs = leg ? [leg] : [];
    }
    if (repNote !== undefined) draft.mileage.repNote = repNote;
  });
}

/**
 * Mandatory Outcome & Notes step. `outcomes` is [{ optionId, kind, label }];
 * at least one is required to seal (see visit-flow.listUnmetRequirements).
 * `custom` is optional free text describing this shift.
 */
function setShiftLog(repKey, date, actualStore, { outcomes, custom } = {}) {
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.shiftLog) draft.shiftLog = { outcomes: [], custom: '' };
    if (outcomes !== undefined) {
      draft.shiftLog.outcomes = Array.isArray(outcomes)
        ? outcomes
            .filter((o) => o && o.optionId)
            .map((o) => ({ optionId: String(o.optionId), kind: o.kind || 'variance', label: o.label || '' }))
        : [];
    }
    if (custom !== undefined) draft.shiftLog.custom = custom == null ? '' : String(custom);
  });
}

/**
 * Opt into / out of optional fixture photo groups (e.g. endcaps-wings).
 * When selected, those categories gate seal like the always-required ones.
 */
function setOptionalFixtures(repKey, date, actualStore, { groupId, selected } = {}) {
  if (!groupId) throw new Error('groupId required');
  const known = new Set(OPTIONAL_FIXTURE_GROUPS.map((g) => g.id));
  if (!known.has(String(groupId))) throw new Error(`Unknown optional fixture group: ${groupId}`);
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.optionalFixtures) draft.optionalFixtures = {};
    if (selected) draft.optionalFixtures[groupId] = true;
    else delete draft.optionalFixtures[groupId];
  });
}

/** Universal per-stage note (in-the-moment, shift-scoped). Optional — never gates. */
function setStageNote(repKey, date, actualStore, { step, text } = {}) {
  if (!step) throw new Error('step required for stage note');
  return mutate(repKey, date, actualStore, (draft) => {
    if (!draft.stageNotes) draft.stageNotes = {};
    const clean = text == null ? '' : String(text);
    if (!clean.trim()) {
      delete draft.stageNotes[step];
    } else {
      draft.stageNotes[step] = { text: clean, updatedAt: new Date().toISOString() };
    }
  });
}

/**
 * Carry-forward note authored this visit for the next servicer of this store.
 * The durable, store-scoped copy is written to store_notes by the route; this
 * only stamps the draft with what the rep wrote here (provenance / CSV).
 */
function setNextVisitNote(repKey, date, actualStore, { text } = {}) {
  return mutate(repKey, date, actualStore, (draft) => {
    const clean = text == null ? '' : String(text);
    draft.nextVisitNote = clean.trim() ? clean : null;
  });
}

/**
 * Free navigation: any section in this visit's step list is always reachable.
 * No forward-locking / "complete this first" gates.
 */
function goToStep(repKey, date, actualStore, stepId) {
  return mutate(repKey, date, actualStore, (draft) => {
    const steps = buildStepSequence({});
    draft.steps = steps;
    const normalized = normalizeCurrentStep(stepId, steps);
    if (!steps.includes(normalized)) throw new Error(`Unknown step for this visit: ${stepId}`);
    draft.currentStep = normalized;
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
    d.currentStep = STEP.VISIT;
  });
}

/* ---------- Listing (in-progress pill indicator + admin read-only view) ---------- */

function summarize(draft) {
  const pd = draft.photoDelivery || null;
  const categoryPhotoCount = Object.values(draft.categoryPhotos || {}).reduce(
    (n, a) => n + (Array.isArray(a) ? a.length : 0),
    0
  );
  const checklistChecked = Object.values(draft.checklist || {}).filter((c) => c?.checked).length;
  const STEP_LABELS = {
    visit: 'Visit',
    before_photos: 'Before photos',
    load_check: 'Load',
    write_order_checklist: 'Order Checklist',
    category_photos: 'Category Photos',
    survey: 'Questions',
    after_photos: 'After photos',
    time: 'Confirm time',
    shift_log: 'Outcome & Notes',
    review: 'Review & Finish',
  };
  return {
    id: draft.id,
    repKey: draft.repKey,
    date: draft.date,
    actualStore: draft.actualStore,
    scheduledStore: draft.scheduledStore,
    status: draft.status,
    currentStep: draft.currentStep,
    currentStepLabel: STEP_LABELS[draft.currentStep] || draft.currentStep || null,
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
    sealedAt: draft.sealedAt,
    beforePhotoCount: (draft.beforePhotos || []).length,
    afterPhotoCount: (draft.afterPhotos || []).length,
    categoryPhotoCount,
    checklistChecked,
    surveyAnswerCount: Object.keys(draft.survey || {}).length,
    shiftLogOutcomeCount: (draft.shiftLog?.outcomes || []).length,
    stageNoteCount: Object.keys(draft.stageNotes || {}).length,
    hasNextVisitNote: !!draft.nextVisitNote,
    hasStartTime: !!(draft.visitStart && draft.visitStart.actual),
    hasStopTime: !!(draft.visitStop && draft.visitStop.actual),
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

function visitRunTime(d) {
  // Reality of the day: when the lead started the visit in the app — not schedule/PROD order.
  return d?.visitStart?.actual || d?.startedAt || d?.visitStop?.actual || '';
}

/**
 * Prior store by actual run order today (visit start times), not calendar/PROD order.
 * Leads run stores in whatever order fits the day; store→store must follow that clock order.
 * Picks the latest other visit whose run time is still before this visit's start.
 * @returns {{ actualStore:number, visitStop:string|null, visitStart:string|null }|null}
 */
function previousCompletedVisitForDay(repKey, date, { excludeActualStore = null, beforeIso = null } = {}) {
  const others = listDraftsForRep(repKey).filter(
    (d) =>
      d.date === date &&
      (excludeActualStore == null || Number(d.actualStore) !== Number(excludeActualStore)) &&
      !!visitRunTime(d)
  );

  let candidates = others;
  if (beforeIso) {
    candidates = others.filter((d) => visitRunTime(d) < beforeIso);
  }
  if (!candidates.length) return null;

  // Immediate predecessor = most recently started (still before current).
  candidates.sort((a, b) => (visitRunTime(a) < visitRunTime(b) ? 1 : -1));
  const best = candidates[0];
  return {
    actualStore: Number(best.actualStore),
    visitStop: best.visitStop?.actual || null,
    visitStart: best.visitStart?.actual || best.startedAt || null,
  };
}

/** Most recently completed visit store for this rep/day, excluding one store. */
function previousCompletedStoreForDay(repKey, date, opts = {}) {
  const prev = previousCompletedVisitForDay(repKey, date, opts);
  return prev ? prev.actualStore : null;
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
  assignCategoryFromAfter,
  removeCategoryPhoto,
  clearCategoryPhotos,
  setPhotoClassification,
  resolvePhotoFile,
  recordChecklistPhoto,
  setLoadCheck,
  setChecklistItem,
  setSurveyAnswer,
  setSurveyAnswers,
  setTimes,
  setMileage,
  setShiftLog,
  setOptionalFixtures,
  setStageNote,
  setNextVisitNote,
  goToStep,
  finishVisit,
  abandonVisit,
  listDraftsForRep,
  listAllDrafts,
  previousCompletedStoreForDay,
  previousCompletedVisitForDay,
  summarize,
  setPhotoDelivery,
  listUnmetRequirements,
  canSeal,
  enrichDraftForUi,
  STEP,
};
