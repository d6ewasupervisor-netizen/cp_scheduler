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

/** Opt-in group: endcaps + wings are only required when the rep selects this section. */
const OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS = 'endcaps-wings';

const CATEGORY_PHOTO_TARGETS = [
  {
    id: 'endcaps',
    label: 'End caps',
    optional: true,
    optionalGroup: OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS,
  },
  { id: 'clipstrips', label: 'Clip strips' },
  {
    id: 'wing-panels',
    label: 'Wing panels',
    optional: true,
    optionalGroup: OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS,
  },
  { id: 'cat-litter-pan-liners', label: 'Cat litter pan liners' },
  { id: 'butcher-block-rack', label: 'Butcher Block rack' },
  { id: 'cp-serviced-section', label: 'Did you stock the section?' },
];

/**
 * Coach copy shown during AFTER burst capture. Reps photograph these fixtures
 * in one pass; Gemini sorts them into category/survey slots on the backend.
 * End caps / wings are optional — only required after the rep opts in.
 */
const AFTER_PHOTO_COACH = [
  {
    id: 'endcaps',
    label: 'End caps',
    tip: 'Shoot each end cap you serviced — full fixture, not just a close-up of one SKU.',
    optional: true,
    optionalGroup: OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS,
  },
  {
    id: 'clipstrips',
    label: 'Clip strips',
    tip: 'Hang / strip close enough to read the product, with the strip still visible.',
  },
  {
    id: 'wing-panels',
    label: 'Wing panels',
    tip: 'Frame the wing beside the end cap so the panel shape is obvious.',
    optional: true,
    optionalGroup: OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS,
  },
  {
    id: 'cat-litter-pan-liners',
    label: 'Cat litter pan liners',
    tip: 'Show the liner bags/packs on the shelf or clip (packaging readable).',
  },
  {
    id: 'butcher-block-rack',
    label: 'Butcher Block rack',
    tip: 'Full rack view — wood/metal butcher-block fixture with treats.',
  },
  {
    id: 'cp-serviced-section',
    label: 'Did you stock the section?',
    tip: 'Two 4ft sections per shot of the finished Pet Care aisle you worked.',
  },
];

const OPTIONAL_FIXTURE_GROUPS = [
  {
    id: OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS,
    label: 'End caps / wings',
    tip: 'Only if you serviced endcaps or wing panels this visit — turn this on, then include them in your after burst.',
    categoryIds: ['endcaps', 'wing-panels'],
  },
];

/** Whether an optional category group is selected on this draft. */
function isOptionalFixtureGroupSelected(draft, groupId) {
  return !!(draft?.optionalFixtures && draft.optionalFixtures[groupId]);
}

/**
 * Category photo targets that gate seal for this draft.
 * Always-required categories + any optional ones the rep selected into.
 */
function requiredCategoryPhotoTargets(draft) {
  return CATEGORY_PHOTO_TARGETS.filter((cat) => {
    if (!cat.optional) return true;
    return isOptionalFixtureGroupSelected(draft, cat.optionalGroup);
  });
}

/* ---------- Step sequence ---------- */

const STEP = {
  /** Single scroll page: start → before → survey → after → time */
  VISIT: 'visit',
  BEFORE_PHOTOS: 'before_photos',
  LOAD_CHECK: 'load_check',
  WRITE_ORDER_CHECKLIST: 'write_order_checklist',
  /** @deprecated Removed from UI — kept for migrating old drafts only */
  CATEGORY_PHOTOS: 'category_photos',
  SURVEY: 'survey',
  AFTER_PHOTOS: 'after_photos',
  TIME: 'time',
  SHIFT_LOG: 'shift_log',
  REVIEW: 'review',
};

/** Survey questions shown to reps (Q1/Q12 are the before/after photo steps). */
const REP_SURVEY_QUESTION_IDS = new Set(['q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11']);

/** Legacy step ids from older drafts — map to the single-page visit flow. */
const LEGACY_STEP_REDIRECT = {
  [STEP.BEFORE_PHOTOS]: STEP.VISIT,
  [STEP.SURVEY]: STEP.VISIT,
  [STEP.AFTER_PHOTOS]: STEP.VISIT,
  [STEP.TIME]: STEP.VISIT,
  [STEP.LOAD_CHECK]: STEP.VISIT,
  [STEP.WRITE_ORDER_CHECKLIST]: STEP.VISIT,
  [STEP.CATEGORY_PHOTOS]: STEP.VISIT,
  [STEP.SHIFT_LOG]: STEP.VISIT,
  [STEP.REVIEW]: STEP.VISIT,
};

/** Survey answers that need an inline category photo (matches prod transmit slots). */
const SURVEY_CATEGORY_PHOTO = {
  q3: { categoryId: 'cp-serviced-section', label: 'Did you stock the section?' },
  q5: { categoryId: 'clipstrips', label: 'Clip strips' },
  q7: { categoryId: 'cat-litter-pan-liners', label: 'Cat litter top shelf' },
  q9: { categoryId: 'butcher-block-rack', label: 'Butcher Block rack' },
};

/**
 * Build the ordered step sequence for a visit.
 * Mobile flow is one scroll page (see STEP.VISIT).
 * workLoad / writeOrder are ignored (reps work load/order outside the app).
 */
function buildStepSequence(/* { workLoad, writeOrder } */) {
  return [STEP.VISIT];
}

/** Whether a survey answer requires an inline category photo for seal. */
function surveyAnswerNeedsCategoryPhoto(questionId, answer) {
  if (answer == null || answer === '') return false;
  if (questionId === 'q3') return answer !== 'Did not stock';
  if (questionId === 'q5') return String(answer).toLowerCase() === 'yes';
  if (questionId === 'q7') return answer === 'Yes';
  if (questionId === 'q9') return String(answer).toLowerCase() === 'yes';
  return false;
}

/**
 * Category photos required for this draft — driven by survey answers (inline
 * capture) plus optional endcap/wing selections on after photos.
 */
function requiredSurveyCategoryPhotos(draft) {
  if (!draft) return [];
  const answers = draft.survey || {};
  const visMap = Object.fromEntries(surveyVisibility(answers).map(({ id, visible }) => [id, visible]));
  const reqs = [];

  for (const [qId, meta] of Object.entries(SURVEY_CATEGORY_PHOTO)) {
    if (!visMap[qId]) continue;
    const ans = answers[qId];
    if (!surveyAnswerNeedsCategoryPhoto(qId, ans)) continue;
    reqs.push({ questionId: qId, categoryId: meta.categoryId, label: meta.label });
  }

  for (const cat of requiredCategoryPhotoTargets(draft)) {
    if (cat.id === 'endcaps' || cat.id === 'wing-panels') {
      reqs.push({ questionId: null, categoryId: cat.id, label: cat.label });
    }
  }

  return reqs;
}

function normalizeCurrentStep(currentStep, steps = buildStepSequence({})) {
  if (steps.includes(currentStep)) return currentStep;
  if (LEGACY_STEP_REDIRECT[currentStep]) return LEGACY_STEP_REDIRECT[currentStep];
  return steps[0];
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

/** Rep-facing survey complete — Q2–Q11 only (Q1/Q12 come from photo steps). */
function isRepSurveyComplete(answers = {}) {
  const visibility = surveyVisibility(answers);
  return visibility.every(({ id, visible }) => {
    if (!visible || !REP_SURVEY_QUESTION_IDS.has(id)) return true;
    const val = answers[id];
    return val != null && val !== '';
  });
}

/* ---------- Free-nav section status + seal-time requirements (only gate) ---------- */

const SECTION_STATUS = {
  EMPTY: 'empty',
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete',
  NEEDS_ATTENTION: 'needs_attention',
};

const SECTION_LABELS = {
  [STEP.VISIT]: 'Visit',
  [STEP.BEFORE_PHOTOS]: 'Before photos',
  [STEP.LOAD_CHECK]: 'Load', // legacy drafts only
  [STEP.WRITE_ORDER_CHECKLIST]: 'Order Checklist', // legacy drafts only
  [STEP.CATEGORY_PHOTOS]: 'Category Photos', // legacy drafts only
  [STEP.SURVEY]: 'Questions',
  [STEP.AFTER_PHOTOS]: 'After photos',
  [STEP.TIME]: 'Confirm time',
  [STEP.SHIFT_LOG]: 'Outcome & Notes', // legacy drafts only
  [STEP.REVIEW]: 'Review & Finish', // legacy drafts only
};

/**
 * Finish-time requirements: before/after photos, fixture coverage from after
 * burst, rep-facing survey (Q2–Q11), start/stop times, mileage.
 *
 * @returns {Array<{section:string, anchor:string, message:string}>}
 */
function listUnmetRequirements(draft) {
  if (!draft) return [{ section: STEP.TIME, anchor: 'time', message: 'No visit draft' }];
  const unmet = [];

  if (!draft.beforePhotos?.length) {
    unmet.push({
      section: STEP.VISIT,
      anchor: 'before-photos',
      message: 'Take at least one before photo of the Pet Supplies aisle',
    });
  }

  if (!isRepSurveyComplete(draft.survey || {})) {
    const vis = surveyVisibility(draft.survey || {});
    for (const { id, visible } of vis) {
      if (!visible || !REP_SURVEY_QUESTION_IDS.has(id)) continue;
      if (draft.survey?.[id] == null || draft.survey[id] === '') {
        const q = serviceSurvey.questions.find((x) => x.id === id);
        unmet.push({
          section: STEP.VISIT,
          anchor: `survey-${id}`,
          message: q ? q.text : `Answer question ${id.toUpperCase()}`,
        });
      }
    }
  }

  for (const req of requiredSurveyCategoryPhotos(draft)) {
    if (!(draft.categoryPhotos?.[req.categoryId] || []).length) {
      unmet.push({
        section: STEP.VISIT,
        anchor: req.questionId ? `survey-${req.questionId}-photo` : `after-photos-${req.categoryId}`,
        message: req.questionId
          ? `Take a photo for: ${req.label}`
          : `Still need a photo of ${req.label}`,
      });
    }
  }

  if (!draft.afterPhotos?.length) {
    unmet.push({
      section: STEP.VISIT,
      anchor: 'after-photos',
      message: 'Take at least one after photo when you are finished',
    });
  }

  if (!draft.visitStart?.actual) {
    unmet.push({
      section: STEP.VISIT,
      anchor: 'shift-start',
      message: 'Set your start time',
    });
  }
  if (!draft.visitStop?.actual) {
    unmet.push({
      section: STEP.VISIT,
      anchor: 'time-stop',
      message: 'Set your stop time',
    });
  }
  if (!draft.mileage?.leg) {
    unmet.push({
      section: STEP.VISIT,
      anchor: 'time-mileage',
      message: 'Tap Calculate Mileage',
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
  const unmet = listUnmetRequirements(draft);
  let status = SECTION_STATUS.EMPTY;
  if (unmet.length === 0) {
    status = SECTION_STATUS.COMPLETE;
  } else if (sectionHasAnyProgress(draft, STEP.VISIT)) {
    status = SECTION_STATUS.NEEDS_ATTENTION;
  }
  return [
    {
      id: STEP.VISIT,
      label: SECTION_LABELS[STEP.VISIT] || STEP.VISIT,
      status,
      hint: null,
    },
  ];
}

function sectionHasAnyProgress(draft, id) {
  switch (id) {
    case STEP.VISIT:
      return (
        (draft.beforePhotos || []).length > 0 ||
        (draft.afterPhotos || []).length > 0 ||
        Object.keys(draft.survey || {}).length > 0 ||
        Object.values(draft.categoryPhotos || {}).some((a) => (a || []).length > 0) ||
        !!(draft.visitStart?.actual || draft.visitStop?.actual || draft.mileage?.leg)
      );
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
 * Compute the mileage leg(s) for this visit.
 *
 * - No previous store today + not last stop → home → thisStore (home matrix)
 * - Previous completed store today, not last stop → prevStore → thisStore (store matrix)
 * - Marked last stop of day, no previous → thisStore → home (home matrix, mirrored)
 * - Marked last stop AFTER a previous store → BOTH inbound S→S and outbound S→H
 *   (kompass-netcap HAR 2026-07-21 visit 27092124 puts both CHANGE rows on one shift)
 *
 * `computeMileageLeg` returns the primary (display) leg — outbound home when last
 * stop, otherwise the single inbound leg. Use `computeMileageLegs` when sealing /
 * transmitting so last-stop visits keep the inbound S→S miles.
 *
 * @param {Object} opts
 * @param {string} opts.workdayGivenId - rep EID key into the home matrix
 * @param {number} opts.actualStore - DECODED store for this visit
 * @param {number|null} [opts.previousCompletedStore] - decoded store of the
 *        most recently completed visit earlier today (same rep), if any
 * @param {boolean} [opts.isLastStopOfDay]
 * @returns {{from:string, to:string, miles:number|null, source:string, warning:string|null}}
 */
function computeMileageLeg(opts) {
  const legs = computeMileageLegs(opts);
  // Primary = last leg (outbound home on last-stop, else the only inbound).
  return legs[legs.length - 1] || {
    from: null,
    to: null,
    miles: null,
    source: 'unresolved',
    warning: 'Mileage could not be resolved',
  };
}

/**
 * Attach wall-clock windows when we know prior stop / this visit start/stop.
 * Prod CHANGE rows prefer these over estimated drive-back times.
 */
function stampMileageLegTimes(legs, { previousStopIso = null, visitStartIso = null, visitStopIso = null } = {}) {
  return (legs || []).map((leg) => {
    if (!leg || leg.source === 'unresolved') return leg;
    const next = { ...leg };
    if (leg.source === 'store-to-store' || leg.source === 'same-store') {
      if (previousStopIso) next.startTime = previousStopIso;
      if (visitStartIso) next.endTime = visitStartIso;
    } else if (leg.source === 'home-to-store') {
      if (visitStartIso) next.endTime = visitStartIso;
    } else if (leg.source === 'store-to-home') {
      if (visitStopIso) next.startTime = visitStopIso;
    }
    return next;
  });
}

/**
 * @returns {Array<{from:string, to:string, miles:number|null, source:string, warning:string|null, startTime?:string, endTime?:string}>}
 */
function computeMileageLegs({
  workdayGivenId,
  actualStore,
  previousCompletedStore = null,
  isLastStopOfDay = false,
  previousStopIso = null,
  visitStartIso = null,
  visitStopIso = null,
}) {
  const rep = homeMatrix.reps[String(workdayGivenId)];
  if (!rep) {
    return [
      {
        from: null,
        to: null,
        miles: null,
        source: 'unresolved',
        warning:
          'Your Home To Store mileage is not set up yet — ask your supervisor, or note the miles below',
      },
    ];
  }

  const legs = [];

  // Inbound to this store (skipped only when last-stop is also the first/only stop —
  // then there is no prior store and we go straight home… still need H→S? No: last
  // stop alone means they somehow only have home return; first-and-last would be
  // H→S inbound + S→H outbound. HAR last-stop-with-prior had S→S + S→H.
  // First-and-last (no previous): H→S + S→H.
  if (isLastStopOfDay) {
    if (previousCompletedStore != null && Number(previousCompletedStore) !== Number(actualStore)) {
      const key = `${previousCompletedStore}-${actualStore}`;
      const miles = Object.prototype.hasOwnProperty.call(storeMatrix.matrix, key)
        ? storeMatrix.matrix[key]
        : null;
      legs.push({
        from: String(previousCompletedStore),
        to: String(actualStore),
        miles,
        source: 'store-to-store',
        warning:
          miles == null
            ? `No Store To Store mileage on file for Store ${previousCompletedStore} → Store ${actualStore} — note the miles below`
            : null,
      });
    } else if (previousCompletedStore == null) {
      const miles = Object.prototype.hasOwnProperty.call(rep.miles, String(actualStore))
        ? rep.miles[String(actualStore)]
        : null;
      legs.push({
        from: 'home',
        to: String(actualStore),
        miles,
        source: 'home-to-store',
        warning:
          miles == null
            ? `No Home To Store mileage on file for Store ${actualStore} — note the miles below`
            : null,
      });
    } else {
      // same-store previous → 0-mile inbound, still return home
      legs.push({
        from: String(previousCompletedStore),
        to: String(actualStore),
        miles: 0,
        source: 'same-store',
        warning: null,
      });
    }

    const homeMiles = Object.prototype.hasOwnProperty.call(rep.miles, String(actualStore))
      ? rep.miles[String(actualStore)]
      : null;
    legs.push({
      from: String(actualStore),
      to: 'home',
      miles: homeMiles,
      source: 'store-to-home',
      warning:
        homeMiles == null
          ? `No Store To Home mileage on file for Store ${actualStore} — note the miles below`
          : null,
    });
    return stampMileageLegTimes(legs, { previousStopIso, visitStartIso, visitStopIso });
  }

  if (previousCompletedStore != null && Number(previousCompletedStore) !== Number(actualStore)) {
    const key = `${previousCompletedStore}-${actualStore}`;
    const miles = Object.prototype.hasOwnProperty.call(storeMatrix.matrix, key)
      ? storeMatrix.matrix[key]
      : null;
    return stampMileageLegTimes(
      [
        {
          from: String(previousCompletedStore),
          to: String(actualStore),
          miles,
          source: 'store-to-store',
          warning:
            miles == null
              ? `No Store To Store mileage on file for Store ${previousCompletedStore} → Store ${actualStore} — note the miles below`
              : null,
        },
      ],
      { previousStopIso, visitStartIso, visitStopIso }
    );
  }

  if (previousCompletedStore != null && Number(previousCompletedStore) === Number(actualStore)) {
    return stampMileageLegTimes(
      [
        {
          from: String(previousCompletedStore),
          to: String(actualStore),
          miles: 0,
          source: 'same-store',
          warning: null,
        },
      ],
      { previousStopIso, visitStartIso, visitStopIso }
    );
  }

  const miles = Object.prototype.hasOwnProperty.call(rep.miles, String(actualStore))
    ? rep.miles[String(actualStore)]
    : null;
  return stampMileageLegTimes(
    [
      {
        from: 'home',
        to: String(actualStore),
        miles,
        source: 'home-to-store',
        warning:
          miles == null
            ? `No Home To Store mileage on file for Store ${actualStore} — note the miles below`
            : null,
      },
    ],
    { previousStopIso, visitStartIso, visitStopIso }
  );
}

module.exports = {
  STEP,
  REP_SURVEY_QUESTION_IDS,
  LEGACY_STEP_REDIRECT,
  CATEGORY_PHOTO_TARGETS,
  AFTER_PHOTO_COACH,
  OPTIONAL_FIXTURE_GROUPS,
  OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS,
  isOptionalFixtureGroupSelected,
  requiredCategoryPhotoTargets,
  SURVEY_CATEGORY_PHOTO,
  surveyAnswerNeedsCategoryPhoto,
  requiredSurveyCategoryPhotos,
  LOAD_FOUND,
  SECTION_STATUS,
  SECTION_LABELS,
  buildStepSequence,
  normalizeCurrentStep,
  nextStep,
  prevStep,
  loadCheckInstruction,
  allScopeChecklistItems,
  writeOrderChecklistItems,
  surveyVisibility,
  surveyAutoFill,
  isSurveyComplete,
  isRepSurveyComplete,
  listUnmetRequirements,
  canSeal,
  sectionStatuses,
  sectionHasAnyProgress,
  enrichDraftForUi,
  tagPhoto,
  computeMileageLeg,
  computeMileageLegs,
  scopeChecklist,
  serviceSurvey,
};
