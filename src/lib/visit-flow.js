'use strict';

/**
 * Stage 3 guided visit flow — pure step/branch/survey/mileage logic.
 * No fs/express here; persistence lives in visit-draft-store.js so this
 * module stays trivially unit-testable.
 *
 * STILL READ-ONLY vs prod — this module only computes local state.
 */

const scopeChecklist = require('../../data/cp-scope-checklist.json');
const serviceSurvey = require('../../data/cp-service-survey.json');
const storeMatrix = require('../../data/d8_mileage_matrix.json');
const homeMatrix = require('../../data/d8_home_to_store.json');

/* ---------- Category photo targets (Part B Step 4, all visit types) ---------- */

const CATEGORY_PHOTO_TARGETS = [
  { id: 'endcaps', label: 'End caps' },
  { id: 'clipstrips', label: 'Clip strips' },
  { id: 'wing-panels', label: 'Wing panels' },
  { id: 'cat-litter-pan-liners', label: 'Cat litter pan liners' },
  { id: 'butcher-block-rack', label: 'Butcher Block rack' },
  { id: 'cp-serviced-section', label: 'Each CP-serviced section' },
];

/* ---------- Step sequence ---------- */

const STEP = {
  BEFORE_PHOTOS: 'before_photos',
  LOAD_CHECK: 'load_check',
  WRITE_ORDER_CHECKLIST: 'write_order_checklist',
  CATEGORY_PHOTOS: 'category_photos',
  SURVEY: 'survey',
  AFTER_PHOTOS: 'after_photos',
  TIME: 'time',
  SHIFT_LOG: 'shift_log',
  REVIEW: 'review',
};

/**
 * Build the ordered step sequence for a visit given its decoded flags.
 * Step order per spec:
 *  1. before photos (always) — burst capture on arrival
 *  2. load check (only if workLoad)
 *  3. write-order checklist (only if writeOrder) — load first when both
 *  4. after photos (always) — burst capture when finished
 *  5. category photos (always) — pick from after photos (no second camera pass)
 *  6. survey (always)
 *  7. time (always)
 *  8. outcome & notes (always) — mandatory shift-outcome log
 *  9. review (always)
 */
function buildStepSequence({ workLoad, writeOrder }) {
  const steps = [STEP.BEFORE_PHOTOS];
  if (workLoad) steps.push(STEP.LOAD_CHECK);
  if (writeOrder) steps.push(STEP.WRITE_ORDER_CHECKLIST);
  steps.push(STEP.AFTER_PHOTOS, STEP.CATEGORY_PHOTOS, STEP.SURVEY, STEP.TIME, STEP.SHIFT_LOG, STEP.REVIEW);
  return steps;
}

function nextStep(sequence, currentStep) {
  const idx = sequence.indexOf(currentStep);
  if (idx === -1 || idx === sequence.length - 1) return null;
  return sequence[idx + 1];
}

function prevStep(sequence, currentStep) {
  const idx = sequence.indexOf(currentStep);
  if (idx <= 0) return null;
  return sequence[idx - 1];
}

/* ---------- Load-check branch (first-person supervisor voice, never third person) ---------- */

const LOAD_FOUND = {
  YES: 'yes',
  NO_FOUND_LATER: 'no_found_later',
  NO_ESCALATED: 'no_escalated',
};

const LOAD_CHECK_INSTRUCTIONS = {
  ask: 'Did you find the load?',
  [LOAD_FOUND.YES]:
    'Great — take a photo of the load, then work it to the shelf.',
  first_not_found:
    "Check the racks in the back of the warehouse. Look behind everything, and confirm the load wasn't already placed on the floor or near the pet area.",
  [LOAD_FOUND.NO_ESCALATED]:
    'Contact me so I can check if tracking is available for your store — include the store number you are physically at.',
};

/**
 * Decide the load-check instruction text for the given branch state.
 * @param {'yes'|'no_found_later'|'no_escalated'} status
 */
function loadCheckInstruction(status) {
  if (status === LOAD_FOUND.YES) return LOAD_CHECK_INSTRUCTIONS[LOAD_FOUND.YES];
  if (status === LOAD_FOUND.NO_ESCALATED) return LOAD_CHECK_INSTRUCTIONS[LOAD_FOUND.NO_ESCALATED];
  if (status === LOAD_FOUND.NO_FOUND_LATER) return LOAD_CHECK_INSTRUCTIONS.first_not_found;
  return LOAD_CHECK_INSTRUCTIONS.ask;
}

/* ---------- Write-order scope checklist ---------- */

/** Flatten cp-scope-checklist.json sections into items, tagged with section id. */
function allScopeChecklistItems() {
  const items = [];
  for (const section of scopeChecklist.sections) {
    for (const item of section.items) {
      items.push({ ...item, sectionTitle: section.title });
    }
  }
  return items;
}

/** Items shown in the write-order checklist step: appliesTo order|both only. */
function writeOrderChecklistItems() {
  return allScopeChecklistItems().filter((item) => item.appliesTo === 'order' || item.appliesTo === 'both');
}

/* ---------- Survey conditionals + auto-fill ---------- */

function evalCondition(cond, answers) {
  if (!cond) return true;
  const actual = answers?.[cond.questionId];
  if (actual == null) return false; // referenced question not yet answered — stay hidden
  if (cond.op === 'equals') return actual === cond.value;
  if (cond.op === 'notEquals') return actual !== cond.value;
  return true;
}

/**
 * Compute which survey questions are currently visible given answers so far.
 * @returns {Array<{id:string, visible:boolean}>}
 */
function surveyVisibility(answers = {}) {
  return serviceSurvey.questions.map((q) => ({
    id: q.id,
    visible: evalCondition(q.visibleIf, answers),
  }));
}

/**
 * Auto-fill Q1/Q12 (or whichever questions declare autoFill) from photo
 * presence. Reactive both ways for free-nav:
 *  - photos present + no answer yet → set 'yes'
 *  - photos removed + answer was auto 'yes' → clear (null in patch = delete)
 * Never overwrites a non-yes manual answer (e.g. rep chose 'no').
 * @returns {Object} partial answers patch (may be empty; null value means clear)
 */
function surveyAutoFill(answers = {}, { hasBeforePhotos = false, hasAfterPhotos = false } = {}) {
  const patch = {};
  for (const q of serviceSurvey.questions) {
    if (!q.autoFill) continue;
    const has =
      q.autoFill === 'beforePhotos' ? hasBeforePhotos : q.autoFill === 'afterPhotos' ? hasAfterPhotos : false;
    if (has) {
      if (answers[q.id] == null) patch[q.id] = 'yes';
    } else if (answers[q.id] === 'yes') {
      // Clear auto-filled yes when the underlying photos are gone (remove flips Q1/Q12).
      patch[q.id] = null;
    }
  }
  return patch;
}

/** Convenience: is the whole survey complete (every visible question answered)? */
function isSurveyComplete(answers = {}) {
  const visibility = surveyVisibility(answers);
  return visibility.every(({ id, visible }) => !visible || answers[id] != null);
}

/* ---------- Free-nav section status + seal-time requirements (only gate) ---------- */

const SECTION_STATUS = {
  EMPTY: 'empty',
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete',
  NEEDS_ATTENTION: 'needs_attention',
};

const SECTION_LABELS = {
  [STEP.BEFORE_PHOTOS]: 'Before Photos',
  [STEP.LOAD_CHECK]: 'Load',
  [STEP.WRITE_ORDER_CHECKLIST]: 'Order Checklist',
  [STEP.CATEGORY_PHOTOS]: 'Category Photos',
  [STEP.SURVEY]: 'Survey',
  [STEP.AFTER_PHOTOS]: 'After Photos',
  [STEP.TIME]: 'Time',
  [STEP.SHIFT_LOG]: 'Outcome & Notes',
  [STEP.REVIEW]: 'Review & Finish',
};

/**
 * Seal-time requirements for one draft. Unchanged from Stage 3 intent:
 * before/after photos, load outcome (yes+photo OR escalated), full order
 * checklist (+ required photos), every category photo target, complete survey
 * (visible questions only), start/stop times, resolved mileage leg.
 * Load escalation (contacted supervisor) is a valid load outcome.
 *
 * @returns {Array<{section:string, anchor:string, message:string}>}
 */
function listUnmetRequirements(draft) {
  if (!draft) return [{ section: STEP.REVIEW, anchor: 'review', message: 'No visit draft' }];
  const unmet = [];

  if (!draft.beforePhotos?.length) {
    unmet.push({
      section: STEP.BEFORE_PHOTOS,
      anchor: 'before-photos',
      message: 'At least 1 before photo is required',
    });
  }

  if (draft.workLoad) {
    const status = draft.loadCheck?.status;
    if (!status) {
      unmet.push({
        section: STEP.LOAD_CHECK,
        anchor: 'load-check',
        message: 'Record whether you found the load',
      });
    } else if (status === LOAD_FOUND.NO_FOUND_LATER) {
      unmet.push({
        section: STEP.LOAD_CHECK,
        anchor: 'load-check',
        message: 'Finish the load search (found later, or contact supervisor)',
      });
    } else if (status === LOAD_FOUND.YES && !draft.loadCheck?.photo) {
      unmet.push({
        section: STEP.LOAD_CHECK,
        anchor: 'load-photo',
        message: 'Take a photo of the load',
      });
    }
    // no_escalated (contacted supervisor) is a valid complete outcome — no photo required
  }

  if (draft.writeOrder) {
    for (const item of writeOrderChecklistItems()) {
      const row = draft.checklist?.[item.id];
      if (!row?.checked) {
        unmet.push({
          section: STEP.WRITE_ORDER_CHECKLIST,
          anchor: `checklist-${item.id}`,
          message: `Check off: ${item.text.slice(0, 80)}${item.text.length > 80 ? '…' : ''}`,
        });
      } else if (item.photoRequired && !row.photo) {
        unmet.push({
          section: STEP.WRITE_ORDER_CHECKLIST,
          anchor: `checklist-photo-${item.id}`,
          message: `Photo required for checklist item ${item.id}`,
        });
      }
    }
  }

  for (const cat of CATEGORY_PHOTO_TARGETS) {
    if (!(draft.categoryPhotos?.[cat.id] || []).length) {
      unmet.push({
        section: STEP.CATEGORY_PHOTOS,
        anchor: `category-${cat.id}`,
        message: `At least 1 photo for ${cat.label}`,
      });
    }
  }

  if (!isSurveyComplete(draft.survey || {})) {
    const vis = surveyVisibility(draft.survey || {});
    for (const { id, visible } of vis) {
      if (!visible) continue;
      if (draft.survey?.[id] == null || draft.survey[id] === '') {
        const q = serviceSurvey.questions.find((x) => x.id === id);
        unmet.push({
          section: STEP.SURVEY,
          anchor: `survey-${id}`,
          message: `Answer survey ${id.toUpperCase()}${q ? `: ${q.text.slice(0, 60)}…` : ''}`,
        });
      }
    }
  }

  if (!draft.afterPhotos?.length) {
    unmet.push({
      section: STEP.AFTER_PHOTOS,
      anchor: 'after-photos',
      message: 'At least 1 after photo is required',
    });
  }

  if (!draft.visitStart?.actual) {
    unmet.push({
      section: STEP.TIME,
      anchor: 'time-start',
      message: 'Set actual start time',
    });
  }
  if (!draft.visitStop?.actual) {
    unmet.push({
      section: STEP.TIME,
      anchor: 'time-stop',
      message: 'Set stop time',
    });
  }
  if (!draft.mileage?.leg) {
    unmet.push({
      section: STEP.TIME,
      anchor: 'time-mileage',
      message: 'Compute the mileage leg for this visit',
    });
  }

  const outcomes = draft.shiftLog?.outcomes || [];
  if (!outcomes.length) {
    unmet.push({
      section: STEP.SHIFT_LOG,
      anchor: 'shift-log',
      message: 'Record at least one outcome for this shift (what you did and/or any variances)',
    });
  } else if (outcomes.some((o) => o.optionId === 'other') && !(draft.shiftLog?.custom || '').trim()) {
    unmet.push({
      section: STEP.SHIFT_LOG,
      anchor: 'shift-log-custom',
      message: 'Describe the "Other" outcome you selected',
    });
  }

  return unmet;
}

function canSeal(draft) {
  return listUnmetRequirements(draft).length === 0;
}

/**
 * Per-section status for sidebar chips. Complete never gates navigation —
 * it's informational only until Review & Finish seal-time enforcement.
 * @returns {Array<{id:string, label:string, status:string, hint:string|null}>}
 */
function sectionStatuses(draft) {
  if (!draft?.steps) return [];
  const unmetBySection = new Map();
  for (const u of listUnmetRequirements(draft)) {
    if (!unmetBySection.has(u.section)) unmetBySection.set(u.section, []);
    unmetBySection.get(u.section).push(u);
  }

  return draft.steps.map((id) => {
    const unmet = unmetBySection.get(id) || [];
    let status = SECTION_STATUS.EMPTY;
    if (id === STEP.REVIEW) {
      status = unmetBySection.size === 0 ? SECTION_STATUS.COMPLETE : SECTION_STATUS.IN_PROGRESS;
    } else if (unmet.length === 0) {
      status = SECTION_STATUS.COMPLETE;
    } else if (sectionHasAnyProgress(draft, id)) {
      status = SECTION_STATUS.NEEDS_ATTENTION;
    } else {
      status = SECTION_STATUS.EMPTY;
    }

    // Passive guidance only — never a modal/block
    let hint = null;
    if (
      id === STEP.BEFORE_PHOTOS &&
      status !== SECTION_STATUS.COMPLETE &&
      draft.currentStep !== STEP.BEFORE_PHOTOS
    ) {
      hint = 'BEFORE photos are time-sensitive';
    }

    return {
      id,
      label: SECTION_LABELS[id] || id,
      status,
      hint,
    };
  });
}

function sectionHasAnyProgress(draft, id) {
  switch (id) {
    case STEP.BEFORE_PHOTOS:
      return (draft.beforePhotos || []).length > 0;
    case STEP.LOAD_CHECK:
      return !!(draft.loadCheck?.status || draft.loadCheck?.photo);
    case STEP.WRITE_ORDER_CHECKLIST:
      return Object.keys(draft.checklist || {}).length > 0;
    case STEP.CATEGORY_PHOTOS:
      return Object.values(draft.categoryPhotos || {}).some((a) => (a || []).length > 0);
    case STEP.SURVEY:
      return Object.keys(draft.survey || {}).length > 0;
    case STEP.SHIFT_LOG:
      return (
        (draft.shiftLog?.outcomes || []).length > 0 ||
        !!(draft.shiftLog?.custom || '').trim() ||
        !!draft.nextVisitNote
      );
    case STEP.AFTER_PHOTOS:
      return (draft.afterPhotos || []).length > 0;
    case STEP.TIME:
      return !!(
        (draft.visitStart?.source === 'manual' && draft.visitStart?.actual) ||
        draft.visitStop?.actual ||
        draft.mileage?.leg ||
        draft.isLastStopOfDay
      );
    case STEP.REVIEW:
      return false;
    default:
      return false;
  }
}

/** Enrich a draft for API/UI without mutating the on-disk sealed shape. */
function enrichDraftForUi(draft) {
  if (!draft) return draft;
  const unmetRequirements = listUnmetRequirements(draft);
  return {
    ...draft,
    sectionStatuses: sectionStatuses(draft),
    unmetRequirements,
    canSeal: unmetRequirements.length === 0,
  };
}

/* ---------- Photo tagging ---------- */

/**
 * Build the tag stamped on a captured photo. Always uses the DECODED
 * (actual) store, never the scheduled/placeholder store.
 */
function tagPhoto({ store, date, category, seq }) {
  if (store == null) throw new Error('tagPhoto requires a decoded store number');
  if (!date) throw new Error('tagPhoto requires a date');
  if (!category) throw new Error('tagPhoto requires a category');
  return {
    store: Number(store),
    date: String(date),
    category: String(category),
    seq: Number(seq) || 1,
  };
}

/* ---------- Mileage leg (single leg for this visit, using DECODED store) ---------- */

/**
 * Compute the mileage leg for this visit.
 *
 * - No previous store today + not last stop → home → thisStore (home matrix)
 * - Previous completed store today, not last stop → prevStore → thisStore (store matrix)
 * - Marked last stop of day → thisStore → home (home matrix, mirrored)
 *
 * @param {Object} opts
 * @param {string} opts.workdayGivenId - rep EID key into the home matrix
 * @param {number} opts.actualStore - DECODED store for this visit
 * @param {number|null} [opts.previousCompletedStore] - decoded store of the
 *        most recently completed visit earlier today (same rep), if any
 * @param {boolean} [opts.isLastStopOfDay]
 * @returns {{from:string, to:string, miles:number|null, source:string, warning:string|null}}
 */
function computeMileageLeg({
  workdayGivenId,
  actualStore,
  previousCompletedStore = null,
  isLastStopOfDay = false,
}) {
  const rep = homeMatrix.reps[String(workdayGivenId)];
  if (!rep) {
    return {
      from: null,
      to: null,
      miles: null,
      source: 'unresolved',
      warning: `EID ${workdayGivenId} not in home-to-store matrix — rebuild matrix or enter mileage manually`,
    };
  }

  if (isLastStopOfDay) {
    const miles = Object.prototype.hasOwnProperty.call(rep.miles, String(actualStore))
      ? rep.miles[String(actualStore)]
      : null;
    return {
      from: String(actualStore),
      to: 'home',
      miles,
      source: 'store-to-home',
      warning: miles == null ? `No home leg on file for store ${actualStore}` : null,
    };
  }

  if (previousCompletedStore != null && Number(previousCompletedStore) !== Number(actualStore)) {
    const key = `${previousCompletedStore}-${actualStore}`;
    const miles = Object.prototype.hasOwnProperty.call(storeMatrix.matrix, key)
      ? storeMatrix.matrix[key]
      : null;
    return {
      from: String(previousCompletedStore),
      to: String(actualStore),
      miles,
      source: 'store-to-store',
      warning: miles == null ? `No store pair ${key} in matrix — enter mileage manually` : null,
    };
  }

  if (previousCompletedStore != null && Number(previousCompletedStore) === Number(actualStore)) {
    return { from: String(previousCompletedStore), to: String(actualStore), miles: 0, source: 'same-store', warning: null };
  }

  const miles = Object.prototype.hasOwnProperty.call(rep.miles, String(actualStore))
    ? rep.miles[String(actualStore)]
    : null;
  return {
    from: 'home',
    to: String(actualStore),
    miles,
    source: 'home-to-store',
    warning: miles == null ? `No home leg on file for store ${actualStore}` : null,
  };
}

module.exports = {
  STEP,
  CATEGORY_PHOTO_TARGETS,
  LOAD_FOUND,
  SECTION_STATUS,
  SECTION_LABELS,
  buildStepSequence,
  nextStep,
  prevStep,
  loadCheckInstruction,
  allScopeChecklistItems,
  writeOrderChecklistItems,
  surveyVisibility,
  surveyAutoFill,
  isSurveyComplete,
  listUnmetRequirements,
  canSeal,
  sectionStatuses,
  sectionHasAnyProgress,
  enrichDraftForUi,
  tagPhoto,
  computeMileageLeg,
  scopeChecklist,
  serviceSurvey,
};
