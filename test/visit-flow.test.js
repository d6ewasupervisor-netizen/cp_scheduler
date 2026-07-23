'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const visitFlow = require('../src/lib/visit-flow');

describe('buildStepSequence (branch logic)', () => {
  it('load-only: before → load_check → after → survey → time → review (no category step)', () => {
    const steps = visitFlow.buildStepSequence({ workLoad: true, writeOrder: false });
    assert.deepEqual(steps, [
      'before_photos',
      'load_check',
      'after_photos',
      'survey',
      'time',
      'shift_log',
      'review',
    ]);
  });

  it('order-only: before → write_order_checklist → after → survey → time → review', () => {
    const steps = visitFlow.buildStepSequence({ workLoad: false, writeOrder: true });
    assert.deepEqual(steps, [
      'before_photos',
      'write_order_checklist',
      'after_photos',
      'survey',
      'time',
      'shift_log',
      'review',
    ]);
  });

  it('both: load check comes before the write-order checklist', () => {
    const steps = visitFlow.buildStepSequence({ workLoad: true, writeOrder: true });
    const loadIdx = steps.indexOf('load_check');
    const orderIdx = steps.indexOf('write_order_checklist');
    assert.ok(loadIdx >= 0 && orderIdx >= 0);
    assert.ok(loadIdx < orderIdx, 'load_check must precede write_order_checklist');
    assert.deepEqual(steps, [
      'before_photos',
      'load_check',
      'write_order_checklist',
      'after_photos',
      'survey',
      'time',
      'shift_log',
      'review',
    ]);
    assert.ok(!steps.includes('category_photos'));
  });

  it('neither load nor order: skips both conditional steps; after then survey', () => {
    const steps = visitFlow.buildStepSequence({ workLoad: false, writeOrder: false });
    assert.deepEqual(steps, [
      'before_photos',
      'after_photos',
      'survey',
      'time',
      'shift_log',
      'review',
    ]);
  });

  it('nextStep/prevStep walk the sequence and return null at the ends', () => {
    const steps = visitFlow.buildStepSequence({ workLoad: false, writeOrder: false });
    assert.equal(visitFlow.nextStep(steps, 'before_photos'), 'after_photos');
    assert.equal(visitFlow.prevStep(steps, 'survey'), 'after_photos');
    assert.equal(visitFlow.prevStep(steps, 'before_photos'), null);
    assert.equal(visitFlow.nextStep(steps, 'review'), null);
  });

  it('AFTER_PHOTO_COACH covers every category target', () => {
    const ids = new Set(visitFlow.AFTER_PHOTO_COACH.map((c) => c.id));
    for (const cat of visitFlow.CATEGORY_PHOTO_TARGETS) {
      assert.ok(ids.has(cat.id), `missing coach for ${cat.id}`);
    }
  });

  it('endcaps and wing-panels are optional fixture targets', () => {
    const endcaps = visitFlow.CATEGORY_PHOTO_TARGETS.find((c) => c.id === 'endcaps');
    const wings = visitFlow.CATEGORY_PHOTO_TARGETS.find((c) => c.id === 'wing-panels');
    assert.equal(endcaps.optional, true);
    assert.equal(wings.optional, true);
    assert.equal(endcaps.optionalGroup, visitFlow.OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS);
    assert.equal(wings.optionalGroup, visitFlow.OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS);
  });
});

describe('load-check escalation branch (first-person supervisor voice)', () => {
  it('yes → instructs photo + work to shelf', () => {
    const msg = visitFlow.loadCheckInstruction(visitFlow.LOAD_FOUND.YES);
    assert.match(msg, /work it to the shelf/i);
  });

  it('no_found_later → instructs checking racks/behind everything/floor', () => {
    const msg = visitFlow.loadCheckInstruction(visitFlow.LOAD_FOUND.NO_FOUND_LATER);
    assert.match(msg, /racks in the back/i);
    assert.match(msg, /behind everything/i);
    assert.match(msg, /floor/i);
  });

  it('no_escalated → first-person contact-me instruction naming the store number', () => {
    const msg = visitFlow.loadCheckInstruction(visitFlow.LOAD_FOUND.NO_ESCALATED);
    assert.match(msg, /contact me/i);
    assert.match(msg, /store number you are physically at/i);
    // Never third person ("the rep should...")
    assert.doesNotMatch(msg, /\bthe rep\b/i);
    assert.doesNotMatch(msg, /\bthey should\b/i);
  });
});

describe('write-order scope checklist filtering', () => {
  it('includes only appliesTo order|both items', () => {
    const items = visitFlow.writeOrderChecklistItems();
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.ok(['order', 'both'].includes(item.appliesTo));
    }
  });

  it('excludes load-only items (e.g. P6 shipper build items)', () => {
    const items = visitFlow.writeOrderChecklistItems();
    assert.ok(!items.some((i) => i.id === 'p6-01'));
    assert.ok(!items.some((i) => i.id === 'p6-02'));
  });

  it('includes the Lennox/Lifebound priority-ordering item', () => {
    const items = visitFlow.writeOrderChecklistItems();
    assert.ok(items.some((i) => i.id === 'ewc-04'));
  });
});

describe('survey conditionals', () => {
  it('Q4 hidden unless Q3 answered and != Fully stocked', () => {
    let vis = visitFlow.surveyVisibility({});
    assert.equal(vis.find((v) => v.id === 'q4').visible, false);

    vis = visitFlow.surveyVisibility({ q3: 'Fully stocked' });
    assert.equal(vis.find((v) => v.id === 'q4').visible, false);

    vis = visitFlow.surveyVisibility({ q3: 'Partially stocked with holes / OOS' });
    assert.equal(vis.find((v) => v.id === 'q4').visible, true);
  });

  it('Q6 only visible when Q5 = no', () => {
    assert.equal(visitFlow.surveyVisibility({ q5: 'yes' }).find((v) => v.id === 'q6').visible, false);
    assert.equal(visitFlow.surveyVisibility({ q5: 'no' }).find((v) => v.id === 'q6').visible, true);
    assert.equal(visitFlow.surveyVisibility({}).find((v) => v.id === 'q6').visible, false);
  });

  it('Q8 only visible when Q7 = No', () => {
    assert.equal(visitFlow.surveyVisibility({ q7: 'No' }).find((v) => v.id === 'q8').visible, true);
    assert.equal(visitFlow.surveyVisibility({ q7: 'Yes' }).find((v) => v.id === 'q8').visible, false);
  });

  it('Q10 only visible when Q9 = no', () => {
    assert.equal(visitFlow.surveyVisibility({ q9: 'no' }).find((v) => v.id === 'q10').visible, true);
    assert.equal(visitFlow.surveyVisibility({ q9: 'yes' }).find((v) => v.id === 'q10').visible, false);
  });

  it('Q11 (free text) and Q1/Q12 are always visible regardless of answers', () => {
    const vis = visitFlow.surveyVisibility({});
    assert.equal(vis.find((v) => v.id === 'q11').visible, true);
    assert.equal(vis.find((v) => v.id === 'q1').visible, true);
    assert.equal(vis.find((v) => v.id === 'q12').visible, true);
  });
});

describe('survey Q1/Q12 auto-fill', () => {
  it('does nothing when no photos exist yet', () => {
    const patch = visitFlow.surveyAutoFill({}, { hasBeforePhotos: false, hasAfterPhotos: false });
    assert.deepEqual(patch, {});
  });

  it('sets q1=yes once before photos exist', () => {
    const patch = visitFlow.surveyAutoFill({}, { hasBeforePhotos: true, hasAfterPhotos: false });
    assert.deepEqual(patch, { q1: 'yes' });
  });

  it('sets q12=yes once after photos exist', () => {
    const patch = visitFlow.surveyAutoFill({}, { hasBeforePhotos: false, hasAfterPhotos: true });
    assert.deepEqual(patch, { q12: 'yes' });
  });

  it('never overwrites an existing manual answer', () => {
    const patch = visitFlow.surveyAutoFill({ q1: 'no' }, { hasBeforePhotos: true, hasAfterPhotos: false });
    assert.deepEqual(patch, {});
  });

  it('clears auto-filled yes when photos are removed (reactive free-nav)', () => {
    const patch = visitFlow.surveyAutoFill({ q1: 'yes', q12: 'yes' }, {
      hasBeforePhotos: false,
      hasAfterPhotos: false,
    });
    assert.equal(patch.q1, null);
    assert.equal(patch.q12, null);
  });

  it('isSurveyComplete respects visibility (hidden questions do not block completion)', () => {
    const answers = {
      q1: 'yes',
      q2: 'Yes',
      q3: 'Fully stocked', // q4 stays hidden
      q5: 'yes', // q6 stays hidden
      q7: 'Yes', // q8 stays hidden
      q9: 'yes', // q10 stays hidden
      q11: 'looks good',
      q12: 'yes',
    };
    assert.equal(visitFlow.isSurveyComplete(answers), true);
    assert.equal(visitFlow.isSurveyComplete({ ...answers, q3: 'Partially stocked with holes / OOS' }), false);
  });
});

describe('free-nav section status + seal requirements (only gate)', () => {
  function baseDraft(overrides = {}) {
    return {
      workLoad: false,
      writeOrder: false,
      steps: visitFlow.buildStepSequence({ workLoad: false, writeOrder: false }),
      currentStep: 'survey',
      beforePhotos: [],
      afterPhotos: [],
      loadCheck: null,
      checklist: {},
      categoryPhotos: {},
      survey: {},
      shiftLog: { outcomes: [], custom: '' },
      visitStart: { actual: '2026-07-08T13:00:00Z', source: 'start_tap' },
      visitStop: { actual: null },
      mileage: { leg: null },
      isLastStopOfDay: false,
      ...overrides,
    };
  }

  it('lists unmet requirements with deep-link section + anchor', () => {
    const unmet = visitFlow.listUnmetRequirements(baseDraft());
    assert.ok(unmet.length > 0);
    for (const u of unmet) {
      assert.ok(u.section);
      assert.ok(u.anchor);
      assert.ok(u.message);
    }
    assert.ok(unmet.some((u) => u.section === 'before_photos' && u.anchor === 'before-photos'));
    assert.ok(unmet.some((u) => u.section === 'survey' && u.anchor.startsWith('survey-')));
  });

  it('endcaps/wings photos do not gate seal unless the optional section is selected', () => {
    const requiredOnly = Object.fromEntries(
      visitFlow
        .requiredCategoryPhotoTargets({})
        .map((c) => [c.id, [{ path: c.id }]])
    );
    const d = baseDraft({
      beforePhotos: [{ path: 'b' }],
      afterPhotos: [{ path: 'a' }],
      categoryPhotos: requiredOnly,
      survey: {
        q1: 'yes',
        q2: 'Yes',
        q3: 'Fully stocked',
        q5: 'yes',
        q7: 'Yes',
        q9: 'yes',
        q11: 'ok',
        q12: 'yes',
      },
      visitStop: { actual: '2026-07-08T18:00:00Z' },
      mileage: { leg: { from: 'home', to: '215', miles: 3.6, source: 'home-to-store' } },
      shiftLog: {
        outcomes: [{ optionId: 'worked_load_wrote_order', kind: 'outcome', label: 'Worked load and wrote order' }],
        custom: '',
      },
    });
    assert.ok(!requiredOnly.endcaps);
    assert.ok(!requiredOnly['wing-panels']);
    assert.equal(visitFlow.canSeal(d), true);

    const optedIn = {
      ...d,
      optionalFixtures: { [visitFlow.OPTIONAL_FIXTURE_GROUP_ENDCAPS_WINGS]: true },
    };
    const unmet = visitFlow.listUnmetRequirements(optedIn);
    assert.ok(unmet.some((u) => /End caps/i.test(u.message)));
    assert.ok(unmet.some((u) => /Wing panels/i.test(u.message)));
    assert.equal(visitFlow.canSeal(optedIn), false);

    optedIn.categoryPhotos = {
      ...requiredOnly,
      endcaps: [{ path: 'e' }],
      'wing-panels': [{ path: 'w' }],
    };
    assert.equal(visitFlow.canSeal(optedIn), true);
  });

  it('load escalation (no_escalated) counts as a valid load outcome', () => {
    const d = baseDraft({
      workLoad: true,
      steps: visitFlow.buildStepSequence({ workLoad: true, writeOrder: false }),
      loadCheck: { status: 'no_escalated', photo: null },
      beforePhotos: [{ path: 'x' }],
      afterPhotos: [{ path: 'y' }],
      categoryPhotos: Object.fromEntries(visitFlow.CATEGORY_PHOTO_TARGETS.map((c) => [c.id, [{ path: c.id }]])),
      survey: {
        q1: 'yes', q2: 'Yes', q3: 'Fully stocked', q5: 'yes', q7: 'Yes', q9: 'yes', q11: 'ok', q12: 'yes',
      },
      visitStop: { actual: '2026-07-08T18:00:00Z' },
      mileage: { leg: { from: 'home', to: '215', miles: 3.6, source: 'home-to-store' } },
      shiftLog: { outcomes: [{ optionId: 'worked_load_wrote_order', kind: 'outcome', label: 'Worked load and wrote order' }], custom: '' },
    });
    assert.equal(visitFlow.canSeal(d), true);
    assert.ok(!visitFlow.listUnmetRequirements(d).some((u) => u.section === 'load_check'));
  });

  it('mandatory Outcome & Notes: seal blocked until at least one outcome is logged', () => {
    const complete = {
      workLoad: false,
      writeOrder: false,
      steps: visitFlow.buildStepSequence({ workLoad: false, writeOrder: false }),
      currentStep: 'shift_log',
      beforePhotos: [{ path: 'b' }],
      afterPhotos: [{ path: 'a' }],
      loadCheck: null,
      checklist: {},
      categoryPhotos: Object.fromEntries(visitFlow.CATEGORY_PHOTO_TARGETS.map((c) => [c.id, [{ path: c.id }]])),
      survey: { q1: 'yes', q2: 'Yes', q3: 'Fully stocked', q5: 'yes', q7: 'Yes', q9: 'yes', q11: 'ok', q12: 'yes' },
      visitStart: { actual: '2026-07-08T13:00:00Z', source: 'start_tap' },
      visitStop: { actual: '2026-07-08T18:00:00Z' },
      mileage: { leg: { from: 'home', to: '215', miles: 3.6, source: 'home-to-store' } },
      isLastStopOfDay: false,
      shiftLog: { outcomes: [], custom: '' },
    };
    // Everything else done, but no outcome logged → still blocked, on the shift_log section.
    assert.equal(visitFlow.canSeal(complete), false);
    assert.ok(
      visitFlow.listUnmetRequirements(complete).some((u) => u.section === 'shift_log' && u.anchor === 'shift-log')
    );
    // Log one normal outcome → seals.
    complete.shiftLog.outcomes = [{ optionId: 'cleaned_up_section', kind: 'outcome', label: 'Cleaned up the section' }];
    assert.equal(visitFlow.canSeal(complete), true);
    // Picking "Other" requires a custom description.
    complete.shiftLog.outcomes = [{ optionId: 'other', kind: 'variance', label: 'Other' }];
    assert.equal(visitFlow.canSeal(complete), false);
    complete.shiftLog.custom = 'Freezer aisle flooded, worked around it';
    assert.equal(visitFlow.canSeal(complete), true);
  });

  it('sidebar statuses never gate — incomplete sections report chips only', () => {
    const d = baseDraft({ currentStep: 'time' });
    const statuses = visitFlow.sectionStatuses(d);
    assert.ok(statuses.every((s) => ['empty', 'in_progress', 'complete', 'needs_attention'].includes(s.status)));
    const before = statuses.find((s) => s.id === 'before_photos');
    assert.equal(before.status, 'empty');
    assert.equal(before.hint, 'BEFORE photos are time-sensitive');
    // Every section from the step list is present (free-nav order)
    assert.deepEqual(
      statuses.map((s) => s.id),
      d.steps
    );
  });

  it('canSeal is false until all Stage 3 requirements are met', () => {
    assert.equal(visitFlow.canSeal(baseDraft()), false);
  });
});

describe('photo tagging (must use DECODED store, not scheduled)', () => {
  it('tags with store/date/category/seq', () => {
    const tag = visitFlow.tagPhoto({ store: 215, date: '2026-07-08', category: 'before', seq: 2 });
    assert.deepEqual(tag, { store: 215, date: '2026-07-08', category: 'before', seq: 2 });
  });

  it('throws without a decoded store (prevents tagging with placeholder store)', () => {
    assert.throws(() => visitFlow.tagPhoto({ date: '2026-07-08', category: 'before', seq: 1 }));
  });

  it('coerces store/seq to numbers', () => {
    const tag = visitFlow.tagPhoto({ store: '391', date: '2026-07-08', category: 'after', seq: '3' });
    assert.equal(tag.store, 391);
    assert.equal(tag.seq, 3);
  });
});

describe('Central Pet Service Survey wording is locked byte-for-byte (Stage 4 exact-match dependency)', () => {
  const survey = visitFlow.serviceSurvey;

  it('is no longer flagged pending — real wording has been supplied', () => {
    assert.equal(survey._meta.pending, false);
  });

  it('Q1/Q12 text and yes/no options match verbatim (lowercase, per prod choices[].text)', () => {
    const q1 = survey.questions.find((q) => q.id === 'q1');
    const q12 = survey.questions.find((q) => q.id === 'q12');
    assert.equal(q1.text, 'Take BEFORE photos of the Pet Supplies aisle when you arrive. Two 4ft sections per photo.');
    assert.deepEqual(q1.options, ['yes', 'no']);
    assert.equal(q12.text, 'Take AFTER photos of the Pet Supplies aisle when you are finished. Two 4ft sections per photo.');
    assert.deepEqual(q12.options, ['yes', 'no']);
  });

  it('Q5/Q9 yes/no options are lowercase to match prod exactly (HAR entry #198)', () => {
    const q5 = survey.questions.find((q) => q.id === 'q5');
    const q9 = survey.questions.find((q) => q.id === 'q9');
    assert.deepEqual(q5.options, ['yes', 'no']);
    assert.deepEqual(q9.options, ['yes', 'no']);
  });

  it('Q3 stock-level options match verbatim (feeds Q4 conditional)', () => {
    const q3 = survey.questions.find((q) => q.id === 'q3');
    assert.deepEqual(q3.options, ['Fully stocked', 'Partially stocked with holes / OOS', 'Did not stock']);
  });

  it("Q7's en dash option is the real U+2013 en dash, not a hyphen-minus", () => {
    const q7 = survey.questions.find((q) => q.id === 'q7');
    const opt = q7.options[1];
    assert.equal(opt, 'Small format store \u2013 no Central Pet items in Cat Litter');
    assert.ok(opt.includes('\u2013'), 'must contain U+2013 EN DASH');
    assert.ok(!opt.includes('\u002d\u002d'), 'must not be a double hyphen substitute');
  });

  it('every question keeps its supervisor-supplied text non-empty and un-truncated', () => {
    for (const q of survey.questions) {
      assert.ok(q.text && q.text.length > 5, `question ${q.id} missing text`);
      assert.doesNotMatch(q.text, /PENDING WORDING/);
    }
  });
});

describe('computeMileageLeg', () => {
  const BRIAN = '800553343'; // in d8_mileage_matrix.json fixture data

  it('home → store when no previous stop today and not last stop', () => {
    const leg = visitFlow.computeMileageLeg({ workdayGivenId: BRIAN, actualStore: 215 });
    assert.equal(leg.from, 'home');
    assert.equal(leg.to, '215');
    assert.equal(leg.miles, 3.6);
    assert.equal(leg.source, 'home-to-store');
  });

  it('store → store using the previous completed store today (mid-day leg)', () => {
    const leg = visitFlow.computeMileageLeg({
      workdayGivenId: BRIAN,
      actualStore: 23,
      previousCompletedStore: 19,
    });
    assert.equal(leg.from, '19');
    assert.equal(leg.to, '23');
    assert.equal(leg.source, 'store-to-store');
    assert.equal(typeof leg.miles, 'number');
  });

  it('store → home is primary when marked last stop; legs also keep inbound S→S', () => {
    const leg = visitFlow.computeMileageLeg({
      workdayGivenId: BRIAN,
      actualStore: 215,
      previousCompletedStore: 19,
      isLastStopOfDay: true,
    });
    assert.equal(leg.from, '215');
    assert.equal(leg.to, 'home');
    assert.equal(leg.miles, 3.6);
    assert.equal(leg.source, 'store-to-home');

    const legs = visitFlow.computeMileageLegs({
      workdayGivenId: BRIAN,
      actualStore: 215,
      previousCompletedStore: 19,
      isLastStopOfDay: true,
    });
    assert.equal(legs.length, 2);
    assert.equal(legs[0].source, 'store-to-store');
    assert.equal(legs[0].from, '19');
    assert.equal(legs[0].to, '215');
    assert.equal(legs[1].source, 'store-to-home');
  });

  it('first-and-last stop seals H→S + S→H', () => {
    const legs = visitFlow.computeMileageLegs({
      workdayGivenId: BRIAN,
      actualStore: 215,
      isLastStopOfDay: true,
    });
    assert.equal(legs.length, 2);
    assert.equal(legs[0].source, 'home-to-store');
    assert.equal(legs[1].source, 'store-to-home');
  });

  it('same-store consecutive visit is a 0-mile leg', () => {
    const leg = visitFlow.computeMileageLeg({
      workdayGivenId: BRIAN,
      actualStore: 19,
      previousCompletedStore: 19,
    });
    assert.equal(leg.miles, 0);
    assert.equal(leg.source, 'same-store');
  });

  it('unknown EID returns unresolved with a warning instead of throwing', () => {
    const leg = visitFlow.computeMileageLeg({ workdayGivenId: '000000000', actualStore: 19 });
    assert.equal(leg.miles, null);
    assert.equal(leg.source, 'unresolved');
    assert.match(leg.warning, /Home To Store mileage is not set up/i);
  });
});
