'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  transmitVisit,
  buildTravelRecordFragment,
  buildTravelChangeRecord,
  estimateDriveHours,
  isCompleteTravelChangeRecord,
  shiftPatchPayload,
  shiftCompletePingPayload,
  pickVisitRepResponder,
  totalWorkTimeLabel,
  totalWorkMinutes,
  categorySpentTimeLabel,
  needsSpentTimeReason,
  isImageRequiredForAnswer,
  resolveStoreTimezone,
  toStoreLocalTime,
} = require('../src/lib/prod-transmitter');
const writeReasons = require('../data/sas-write-reasons.json');
const storeTimezones = require('../data/store-timezones.json');

/* ---------- Fixtures mirroring the real HAR (visit 27000510) ---------- */

const PROD_QUESTIONS = [
  {
    id: 918565,
    text: 'Take BEFORE photos of the Pet Supplies aisle when you arrive. Two 4ft sections per photo.',
    answer_image_required: true,
    choices: [
      { text: 'no', is_image_required: false },
      { text: 'yes', is_image_required: true },
    ],
  },
  {
    id: 918566,
    text: 'Is the Central Pet order in store for you to work to shelf?',
    answer_image_required: false,
    choices: [
      { text: 'Yes', is_image_required: false },
      { text: 'No', is_image_required: false },
      { text: 'Service day only (no new order)', is_image_required: false },
    ],
  },
  {
    id: 918567,
    text: 'Did you stock the section?',
    answer_image_required: false,
    choices: [
      { text: 'Fully stocked', is_image_required: false },
      { text: 'Partially stocked with holes / OOS', is_image_required: true },
      { text: 'Did not stock', is_image_required: false },
    ],
  },
  {
    id: 918569,
    text: 'Did you merchandise clip strips?',
    answer_image_required: true,
    choices: [
      { text: 'no', is_image_required: false },
      { text: 'yes', is_image_required: true },
    ],
  },
  {
    id: 918571,
    text: 'Did you merchandise Central Pet items in the top shelf of the Cat Litter section?',
    answer_image_required: false,
    choices: [
      { text: 'Yes', is_image_required: true },
      { text: 'Small format store \u2013 no Central Pet items in Cat Litter', is_image_required: false },
      { text: 'No', is_image_required: false },
    ],
  },
  {
    id: 918573,
    text: 'Did you merchandise the Butcher Block rack?',
    answer_image_required: false,
    choices: [
      { text: 'no', is_image_required: false },
      { text: 'yes', is_image_required: false },
    ],
  },
  {
    id: 918575,
    text: 'Is there any additional feedback / issues / successes during your visit?',
    answer_image_required: false,
    choices: [],
  },
  {
    id: 918576,
    text: 'Take AFTER photos of the Pet Supplies aisle when you are finished. Two 4ft sections per photo.',
    answer_image_required: true,
    choices: [
      { text: 'no', is_image_required: false },
      { text: 'yes', is_image_required: true },
    ],
  },
];

function makeFixtureSasGet(overrides = {}) {
  return async function fixtureSasGet(token, urlPath, params = {}) {
    const p = urlPath.replace(/^\/v2\//, '/v2/').replace(/^\//, '');
    if (overrides[p]) return overrides[p](params);

    if (p === 'field-app/visits/27000510/shift-complete/') {
      return { current_status: 'active', employees: [{ id: 354456, shift_id: 44390825, actual_start_time: null }] };
    }
    if (p === 'v2/field-app/shifts/44390825/') {
      return { home_to_store: true, store_to_store: true, store_to_home: true, calculate_mileage: true };
    }
    if (p === 'field-app/visits/27000510/category-resets/') {
      return { category_resets: [{ id: 41384408, name: 'PET CARE SUPPLIES', category_id: 986 }] };
    }
    if (p === 'v2/field-app/survey-visits/') {
      return [{ id: 25760350, visit: 27000510, survey: { id: 115502, name: 'Central Pet Service Survey' } }];
    }
    if (p === 'surveys/questions/') {
      return PROD_QUESTIONS;
    }
    if (p === 'field-app/spent-time-reasons/') {
      return [
        { id: 1, text: 'Footage issue' },
        { id: 2, text: 'Team performance' },
        { id: 3, text: 'Other \u2013 supervisor was contacted' },
      ];
    }
    if (p === 'operations/time-change-reason/') {
      return [
        { id: 5, text: 'Tablet was Not Available' },
        { id: 8, text: 'Punched into Wrong Visit' },
      ];
    }
    if (p === 'surveys/responders/') {
      return [{ id: 8336939, name: 'brian.campbell@sasretailservices.com', visit_id: 27000510 }];
    }
    throw new Error(`fixtureSasGet: unhandled path ${p}`);
  };
}

function makeSealedRecord(overrides = {}) {
  return {
    repKey: 'brian-campbell',
    date: '2026-07-08',
    scheduledStore: 391,
    actualStore: 215,
    status: 'ready_for_prod',
    visitStart: { actual: '2026-07-08T13:01:00Z' },
    visitStop: { actual: '2026-07-08T18:01:00Z' },
    beforePhotos: [],
    afterPhotos: [],
    categoryPhotos: {},
    survey: {
      q1: 'yes',
      q2: 'Yes',
      q3: 'Fully stocked',
      q5: 'no',
      q9: 'yes',
      q11: '3 Endcaps, 3 Wing Panels, Six Endcap Clipstrips',
      q12: 'yes',
    },
    mileage: { leg: { from: 'home', to: '215', miles: 3.6, source: 'home-to-store', warning: null } },
    ...overrides,
  };
}

function makeMatchedVisit(overrides = {}) {
  return {
    status: 'matched',
    appShift: { id: 'export-1', repKey: 'brian-campbell', date: '2026-07-08', actualStore: 215 },
    prodVisit: {
      visitId: 27000510,
      scheduledStore: 391,
      actualStore: 215,
      workdayGivenId: '800553343',
      repKey: 'brian-campbell',
      shiftId: 44390825,
      visitStatus: 'in-progress',
    },
    ...overrides,
  };
}

function tmpPhoto(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-transmitter-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal jpeg-ish bytes
  return { absPath: file, path: path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/') };
}

const baseOpts = () => ({
  sasGet: makeFixtureSasGet(),
  loadSession: async () => ({ token: 'super-secret-real-token-should-never-appear-in-output' }),
  timeChangeComment: 'Entered from Stage 3 sealed record',
});

describe('transmitVisit — guards (Part C)', () => {
  it('aborts when the draft is not sealed', async () => {
    const sealed = makeSealedRecord({ status: 'in_progress' });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'not_sealed');
  });

  it('aborts when the matcher result is not a unique/green match', async () => {
    const sealed = makeSealedRecord();
    for (const bad of [null, { status: 'ambiguous' }, { status: 'unmatched' }, { status: 'orphaned' }]) {
      const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: bad, opts: baseOpts() });
      assert.equal(result.status, 'aborted');
      assert.equal(result.abortReason, 'not_matched_or_ambiguous');
    }
  });

  it('aborts when the visit is already completed in prod', async () => {
    const opts = baseOpts();
    opts.sasGet = makeFixtureSasGet({
      'field-app/visits/27000510/shift-complete/': async () => ({ current_status: 'completed', employees: [] }),
    });
    const result = await transmitVisit({ sealedRecord: makeSealedRecord(), matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'already_completed_in_prod');
  });

  it('assembles completion when the shift already has actual_start_time in prod (cohesive path)', async () => {
    const opts = baseOpts();
    opts.sasGet = makeFixtureSasGet({
      'field-app/visits/27000510/shift-complete/': async () => ({
        current_status: 'in-progress',
        employees: [{ id: 354456, shift_id: 44390825, actual_start_time: '06:01:00' }],
      }),
      'v2/field-app/shifts/44390825/': async () => ({
        home_to_store: true,
        store_to_store: true,
        store_to_home: true,
        calculate_mileage: true,
        travel_records: [
          {
            start_location_type: 'H',
            end_location_type: 'S',
            distance: '32.20',
          },
        ],
      }),
    });
    const sealed = makeSealedRecord({
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'ok', result.abortReason);
    assert.equal(result.alreadyStartedInProd, true);
    assert.equal(result.skippedVisitStart, true);
    assert.equal(result.skippedToStore, true);
    // Must not re-send first-time start schedule when PROD already punched
    assert.ok(
      !result.calls.some(
        (c) => c.method === 'PATCH' && /\/field-app\/visits\/27000510\/?$/.test(c.url) && Object.keys(c.payload || {}).length === 0
      ),
      'should skip empty visit-start PATCH'
    );
    assert.ok(
      !result.calls.some((c) => c.method === 'POST' && /\/travel\/44390825\/to_store\/?$/.test(c.url)),
      'should skip to_store when travel_records exist'
    );
    // Completion path still includes T&E times + final close
    assert.ok(result.calls.some((c) => c.method === 'PATCH' && /\/field-app\/shifts\/44390825\/?$/.test(c.url)));
    assert.ok(result.calls.some((c) => c.method === 'PUT' && /shift-complete/.test(c.url)));
  });

  it('aborts when isAlreadyTransmitted() reports true (local bookkeeping)', async () => {
    const opts = { ...baseOpts(), isAlreadyTransmitted: () => true };
    const result = await transmitVisit({ sealedRecord: makeSealedRecord(), matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'already_transmitted');
  });

  it('aborts when no timeChangeComment is supplied (never defaults to the HAR placeholder "k")', async () => {
    const opts = baseOpts();
    delete opts.timeChangeComment;
    const result = await transmitVisit({ sealedRecord: makeSealedRecord(), matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'missing_time_change_comment');
    assert.ok(!JSON.stringify(result).includes('"k"'));
  });

  it('aborts when the sealed record has no mileage leg resolved', async () => {
    const sealed = makeSealedRecord({ mileage: { leg: null } });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'mileage_leg_not_resolved');
  });
});

describe('transmitVisit — exact-string survey matching (never fuzzy-match)', () => {
  it('assembles successfully when every answer exact-matches a live prod choice', async () => {
    const sealed = makeSealedRecord({ beforePhotos: [tmpPhoto('before.jpg')], afterPhotos: [tmpPhoto('after.jpg')] });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
  });

  it('aborts on any answer text mismatch instead of fuzzy-matching', async () => {
    const sealed = makeSealedRecord({ survey: { ...makeSealedRecord().survey, q1: 'Yes' } }); // capitalized, prod wants lowercase
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'aborted');
    assert.match(result.abortReason, /^survey_answer_mismatch:q1:/);
  });

  it("verifies Q7's en dash option survives into the assembled answer payload", async () => {
    const sealed = makeSealedRecord({
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
      survey: { ...makeSealedRecord().survey, q7: 'Small format store \u2013 no Central Pet items in Cat Litter' },
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    const answerCall = result.calls.find(
      (c) => c.url.endsWith('/surveys/answers/') && c.payload?.question === 918571
    );
    assert.ok(answerCall, 'expected a q7 answer call to be assembled');
    assert.ok(answerCall.payload.answer.includes('\u2013'), 'answer text must retain the U+2013 en dash');
  });

  it('aborts when a sealed answer has no matching prod question at all', async () => {
    const sealed = makeSealedRecord({ survey: { ...makeSealedRecord().survey, q1: 'yes' } });
    const opts = baseOpts();
    opts.sasGet = makeFixtureSasGet({ 'surveys/questions/': async () => PROD_QUESTIONS.filter((q) => q.id !== 918565) });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'survey_question_not_found_in_prod:q1');
  });

  it('aborts when a required answer image is not available in the sealed record', async () => {
    // Q1 requires an image for "yes" but no beforePhotos are attached.
    const result = await transmitVisit({ sealedRecord: makeSealedRecord(), matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'survey_answer_image_required_but_unavailable:q1');
  });
});

describe('transmitVisit — reason-string resolution (exact match against live enum, never invent)', () => {
  it('resolves the approved category spent-time reason id by exact text', async () => {
    const sealed = makeSealedRecord({ beforePhotos: [tmpPhoto('before.jpg')], afterPhotos: [tmpPhoto('after.jpg')] });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    const spentCall = result.calls.find(
      (c) => c.payload?.spent_time && c.payload?.spent_time_reason && (c.url || '').includes('/category-resets/')
    );
    assert.equal(spentCall.payload.spent_time_reason.id, 3);
    assert.equal(writeReasons.categorySpentTimeReason.selected.text, 'Other \u2013 supervisor was contacted');
  });

  it('aborts when the configured reason text is not present in the live enum (e.g. the never-real "supervisor was notified")', async () => {
    const sealed = makeSealedRecord({ beforePhotos: [tmpPhoto('before.jpg')], afterPhotos: [tmpPhoto('after.jpg')] });
    const opts = { ...baseOpts(), categorySpentTimeReasonText: 'supervisor was notified' };
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'category_spent_time_reason_not_found:supervisor was notified');
  });

  it('aborts when the shift time-change reason text is not present in the live enum', async () => {
    const sealed = makeSealedRecord({ beforePhotos: [tmpPhoto('before.jpg')], afterPhotos: [tmpPhoto('after.jpg')] });
    const opts = { ...baseOpts(), timeChangeReasonText: 'Not a real reason' };
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortReason, 'shift_time_change_reason_not_found:Not a real reason');
  });
});

describe('transmitVisit — photo slotting', () => {
  it('places before photos in the before slot and after photos in the after slot', async () => {
    const sealed = makeSealedRecord({
      beforePhotos: [tmpPhoto('before-1.jpg')],
      afterPhotos: [tmpPhoto('after-1.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');

    const resetCalls = result.calls.filter((c) => c.url.includes('/category-resets/41384408/'));
    const beforeCall = resetCalls.find((c) => c.payload?.before);
    const afterCall = resetCalls.find((c) => c.payload?.after && !c.payload?.completion_status);
    assert.ok(beforeCall, 'expected a before-slot PATCH');
    assert.ok(afterCall, 'expected an after-slot PATCH');
    assert.equal(beforeCall.payload.before.image.filename, 'before-1.jpg');
    assert.equal(afterCall.payload.after.image.filename, 'after-1.jpg');
  });

  it('folds category-tagged photos into the after slot of the single reset row and counts them by category', async () => {
    const sealed = makeSealedRecord({
      beforePhotos: [tmpPhoto('before-1.jpg')],
      afterPhotos: [tmpPhoto('after-1.jpg')],
      categoryPhotos: { clipstrips: [tmpPhoto('clip-1.jpg')], 'butcher-block-rack': [tmpPhoto('bb-1.jpg')] },
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    assert.equal(result.photoCounts.clipstrips, 1);
    assert.equal(result.photoCounts['butcher-block-rack'], 1);
    assert.equal(result.photoCounts.before, 1);
    assert.equal(result.photoCounts.after, 1);

    const categoryFilenames = result.calls
      .filter((c) => c.url.includes('/category-resets/41384408/') && c.payload?.after?.image)
      .map((c) => c.payload.after.image.filename);
    assert.ok(categoryFilenames.includes('clip-1.jpg'));
    assert.ok(categoryFilenames.includes('bb-1.jpg'));
  });

  it('aborts if a tagged photo file is unreadable on disk (never fabricates image bytes)', async () => {
    const sealed = makeSealedRecord({
      beforePhotos: [{ path: 'data/visit-drafts/does-not-exist/nope.jpg', store: 215, date: '2026-07-08', category: 'before', seq: 1 }],
      afterPhotos: [tmpPhoto('after-1.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'aborted');
    // Survey runs before category photos (HAR 2026-07-21), so q1's before image fails first.
    assert.match(result.abortReason, /^photo_unreadable:(q1|before):/);
  });
});

describe('transmitVisit — ordering / dependencies / sourceRef', () => {
  it('assembles the full HAR-mirrored sequence for a "both" (load+order) visit and every call has a sourceRef', async () => {
    const sealed = makeSealedRecord({
      writeOrder: true,
      workLoad: true,
      beforePhotos: [tmpPhoto('before-1.jpg')],
      afterPhotos: [tmpPhoto('after-1.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    assert.ok(result.calls.length > 10);
    for (const call of result.calls) {
      assert.ok(call.sourceRef && call.sourceRef.length > 0, `call seq ${call.seq} (${call.method} ${call.url}) missing sourceRef`);
    }

    const methodsInOrder = result.calls.map((c) => `${c.method} ${c.url.split('?')[0].split('/').slice(3).join('/')}`);
    const surveyCompleteIdx = methodsInOrder.findIndex((m) => m.includes('surveys/surveys/115502/complete'));
    const travelIdx = methodsInOrder.findIndex((m) => m.includes('travel/44390825/to_store'));
    const punchIdx = methodsInOrder.findIndex((m, i) => i > travelIdx && m.startsWith('PATCH api/v2/field-app/shifts/'));
    const finalPutIdx = methodsInOrder.findIndex((m) => m.startsWith('PUT'));

    // kompass-netcap HAR 2026-07-21: survey → to_store → punch → PUT
    assert.ok(surveyCompleteIdx < travelIdx, 'survey completion must precede to_store');
    assert.ok(travelIdx < punchIdx, 'travel preview must precede the punch PATCH');
    assert.ok(punchIdx < finalPutIdx, 'punch must precede the final PUT shift-complete');
  });

  it('threads run_info/responder/answer ids as {{placeholder}} references, never invented literal ids', async () => {
    const opts = baseOpts();
    opts.sasGet = makeFixtureSasGet({ 'surveys/responders/': async () => [] }); // force a fresh responder
    opts.surveyResponderName = 'tyson.gauthier@advantagesolutions.net';
    const sealed = makeSealedRecord({ beforePhotos: [tmpPhoto('before.jpg')], afterPhotos: [tmpPhoto('after.jpg')] });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts });
    assert.equal(result.status, 'ok');

    const runInfo = result.calls.find((c) => c.url.endsWith('/surveys/run-infos/'));
    assert.ok(runInfo);
    assert.equal(runInfo.payload.runid, null);

    const createBeforeRun = result.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/surveys/responders/') && c.seq < runInfo.seq
    );
    assert.ok(createBeforeRun, 'create responder before run-infos');
    assert.equal(createBeforeRun.payload.name, 'tyson.gauthier@advantagesolutions.net');
    assert.equal(runInfo.payload.responder, `{{step${createBeforeRun.seq}.id}}`);

    const answers = result.calls.filter((c) => c.url.endsWith('/surveys/answers/'));
    assert.ok(answers.length > 0);
    for (const a of answers) {
      assert.equal(a.payload.responder, `{{step${createBeforeRun.seq}.id}}`);
      assert.equal(a.payload.run_info, `{{step${runInfo.seq}.id}}`);
      assert.equal(a.payload.runid, undefined);
      assert.equal(a.payload.survey, undefined);
      assert.ok(a.dependsOn.includes(runInfo.seq));
    }

    const answerImages = result.calls.filter((c) => c.url.endsWith('/surveys/answer-images/'));
    for (const img of answerImages) {
      assert.match(img.payload.answer, /^\{\{step\d+\.id\}\}$/);
    }
  });

  it('reuses an existing responder id directly (no placeholder) and claims it at the end, matching the real HAR position', async () => {
    const sealed = makeSealedRecord({ beforePhotos: [tmpPhoto('before.jpg')], afterPhotos: [tmpPhoto('after.jpg')] });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');

    const answers = result.calls.filter((c) => c.url.endsWith('/surveys/answers/'));
    for (const a of answers) assert.equal(a.payload.responder, 8336939);

    const responderPosts = result.calls.filter((c) => c.url.endsWith('/surveys/responders/') && c.method === 'POST');
    assert.equal(responderPosts.length, 1, 'existing responder → only the claim POST');
    const completeIdx = result.calls.findIndex((c) => c.url.includes('surveys/surveys/115502/complete'));
    const responderIdx = result.calls.indexOf(responderPosts[0]);
    const lastAnswerIdx = Math.max(...answers.map((a) => result.calls.indexOf(a)));
    assert.ok(responderIdx > lastAnswerIdx, 'claim POST must come after all answers, mirroring HAR');
    assert.ok(responderIdx < completeIdx, 'claim POST must come before survey completion');
  });
});

describe('transmitVisit — assembly by visit type', () => {
  it('load-only visit (endcaps/wing-panels categoryPhotos, no order-side categories) assembles the full call sequence', async () => {
    const sealed = makeSealedRecord({
      writeOrder: false,
      workLoad: true,
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
      categoryPhotos: { endcaps: [tmpPhoto('endcap-1.jpg')], 'wing-panels': [tmpPhoto('wing-1.jpg')] },
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    assert.equal(result.photoCounts.endcaps, 1);
    assert.equal(result.photoCounts['wing-panels'], 1);
    assert.equal(result.photoCounts.clipstrips, 0);
    for (const call of result.calls) assert.ok(call.sourceRef);
  });

  it('order-only visit (cat-litter/butcher-block categoryPhotos) assembles the full call sequence', async () => {
    const sealed = makeSealedRecord({
      writeOrder: true,
      workLoad: false,
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
      categoryPhotos: { 'cat-litter-pan-liners': [tmpPhoto('litter-1.jpg')], 'butcher-block-rack': [tmpPhoto('bb-1.jpg')] },
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    assert.equal(result.photoCounts['cat-litter-pan-liners'], 1);
    assert.equal(result.photoCounts['butcher-block-rack'], 1);
    assert.equal(result.photoCounts.endcaps, 0);
    for (const call of result.calls) assert.ok(call.sourceRef);
  });
});

describe('transmitVisit — redaction', () => {
  it('never includes the real token anywhere in the assembled output', async () => {
    const sealed = makeSealedRecord({ beforePhotos: [tmpPhoto('before.jpg')], afterPhotos: [tmpPhoto('after.jpg')] });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    const text = JSON.stringify(result);
    assert.ok(!text.includes('super-secret-real-token-should-never-appear-in-output'));
    for (const call of result.calls) {
      assert.equal(call.headers.Authorization, 'Token {{REDACTED}}');
    }
  });
});

describe('unit helpers', () => {
  it('buildTravelRecordFragment is audit-only matrix leg with filled start/duration', () => {
    const leg = { from: 'home', to: '215', miles: 3.6, source: 'home-to-store' };
    const frag = buildTravelRecordFragment(leg, '2026-07-08T13:01:00Z');
    assert.equal(frag.distance, '3.60');
    assert.equal(frag.start_location_type, 'H');
    assert.equal(frag.end_location_type, 'S');
    assert.equal(frag.end_time, '2026-07-08T13:01:00Z');
    assert.ok(frag.start_time, 'start_time filled');
    assert.equal(frag._auditOnly, true);
    assert.ok(!frag._unresolvedFields);
  });

  it('buildTravelRecordFragment returns null for a same-store 0-mile leg', () => {
    const leg = { from: '19', to: '19', miles: 0, source: 'same-store' };
    assert.equal(buildTravelRecordFragment(leg, '2026-07-08T13:01:00Z'), null);
  });

  it('buildTravelChangeRecord matches prod completion.har CHANGE shape (S→H)', () => {
    const leg = { from: '53', to: 'home', miles: 3.4, source: 'store-to-home' };
    const row = buildTravelChangeRecord(leg, {
      shiftId: 44392384,
      visitStartIso: '2026-07-15T22:40:00Z',
      visitStopIso: '2026-07-15T23:04:00Z',
      changeReasonId: 5,
      changeComment: 'Entered from Stage 3 sealed record',
    });
    assert.equal(row.shift_id, 44392384);
    assert.equal(row.id, null);
    assert.equal(row.start_location_type, 'S');
    assert.equal(row.end_location_type, 'H');
    assert.equal(row.distance, '3.40');
    assert.equal(row.record_type, 'CHANGE');
    assert.equal(row.change_reason, 5);
    assert.equal(row.change_comment, 'Entered from Stage 3 sealed record');
    assert.equal(row.is_system_generated, false);
    assert.equal(row.start_time, '2026-07-15T23:04:00.000Z');
    assert.ok(isCompleteTravelChangeRecord(row));
    // ~3.4 mi at 40 mph ≈ 0.085h; min 5 min = 0.0833
    assert.equal(row.duration, estimateDriveHours(3.4).toFixed(4));
  });

  it('shiftPatchPayload includes time_change + optional travel CHANGE', () => {
    const timeOnly = shiftPatchPayload({
      actualStartDate: '2026-07-15',
      actualStartTime: '15:40:00',
      actualEndDate: '2026-07-15',
      actualEndTime: '16:04:00',
      timeChangeReasonId: 5,
      timeChangeComment: 'sealed transmit',
      includeEmptyTravelRecords: true,
    });
    assert.equal(timeOnly.time_change_reason, 5);
    assert.equal(timeOnly.time_change_comment, 'sealed transmit');
    assert.deepEqual(timeOnly.travel_records, []);

    const withMiles = shiftPatchPayload({
      actualStartDate: '2026-07-15',
      actualStartTime: '15:40:00',
      actualEndDate: '2026-07-15',
      actualEndTime: '16:04:00',
      timeChangeReasonId: 5,
      timeChangeComment: 'sealed transmit',
      travelRecords: [
        {
          shift_id: 1,
          start_time: 'a',
          end_time: 'b',
          distance: '3.40',
          duration: '0.0833',
          start_location_type: 'S',
          end_location_type: 'H',
          record_type: 'CHANGE',
          change_reason: 5,
          change_comment: 'sealed transmit',
        },
      ],
    });
    assert.equal(withMiles.travel_records.length, 1);
    assert.equal(withMiles.travel_records[0].distance, '3.40');
  });

  it('totalWorkTimeLabel matches the HAR format ("Xh Ym")', () => {
    assert.equal(totalWorkTimeLabel('2026-07-08T13:01:00Z', '2026-07-08T18:01:00Z'), '5h 00m');
    assert.equal(totalWorkTimeLabel('2026-07-08T13:01:00Z', '2026-07-08T14:31:00Z'), '1h 30m');
  });

  it('short-visit work helpers (James FM53 24m rules)', () => {
    assert.equal(totalWorkMinutes('2026-07-15T22:40:00Z', '2026-07-15T23:04:00Z'), 24);
    assert.equal(categorySpentTimeLabel('2026-07-15T22:40:00Z', '2026-07-15T23:04:00Z'), '0h 24m');
    assert.equal(needsSpentTimeReason('2026-07-15T22:40:00Z', '2026-07-15T23:04:00Z'), true);
    assert.equal(needsSpentTimeReason('2026-07-15T22:40:00Z', '2026-07-15T23:04:00Z', 1), false); // 1/24 < 5%
  });

  it('isImageRequiredForAnswer checks choice-level flag first, falling back to question-level', () => {
    const q = PROD_QUESTIONS.find((x) => x.id === 918571);
    assert.equal(isImageRequiredForAnswer(q, 'Yes'), true);
    assert.equal(isImageRequiredForAnswer(q, 'No'), false);
  });
});

describe('store-local actual_*_time conversion (timezone map + Intl)', () => {
  it('maps all 11 D8 stores to America/Los_Angeles', () => {
    const d8 = ['19', '23', '28', '31', '53', '111', '215', '391', '459', '658', '682'];
    assert.equal(Object.keys(storeTimezones.stores).length, 11);
    for (const n of d8) {
      assert.equal(resolveStoreTimezone(n), 'America/Los_Angeles');
      assert.equal(resolveStoreTimezone(Number(n)), 'America/Los_Angeles');
    }
  });

  it('PDT (2026-07-10): converts UTC ISO to local store wall clock', () => {
    // 13:01 UTC = 06:01 PDT (UTC-7)
    assert.equal(toStoreLocalTime('2026-07-10T13:01:00Z', 215), '06:01:00');
    assert.equal(toStoreLocalTime('2026-07-10T18:01:00Z', 215), '11:01:00');
  });

  it('PST (2026-01-10): converts UTC ISO with standard-time offset (UTC-8)', () => {
    // 14:01 UTC = 06:01 PST; fixed -07:00 offset would wrongly yield 07:01
    assert.equal(toStoreLocalTime('2026-01-10T14:01:00Z', 215), '06:01:00');
    assert.equal(toStoreLocalTime('2026-01-10T19:01:00Z', 391), '11:01:00');
  });

  it('midnight boundary: local date differs from UTC date', () => {
    // 2026-07-10T06:30:00Z = 2026-07-09 23:30:00 PDT (UTC date is the 10th, local is still the 9th)
    assert.equal(toStoreLocalTime('2026-07-10T06:30:00Z', 215), '23:30:00');
    // Local midnight PDT = 07:00 UTC same calendar day
    assert.equal(toStoreLocalTime('2026-07-10T07:00:00Z', 215), '00:00:00');
  });

  it('returns null for unknown stores (never invents an offset)', () => {
    assert.equal(toStoreLocalTime('2026-07-10T13:01:00Z', 99999), null);
    assert.equal(resolveStoreTimezone(99999), null);
  });
});

describe('transmitVisit — actual_start_time/actual_end_time are store-local (HAR 27000510 regression)', () => {
  it('27000510 assembly emits actual_start_time "06:01:00" (HAR local), not UTC slice "13:01:00"', async () => {
    const sealed = makeSealedRecord({
      // HAR entry #137 / sealed times for Brian @ 215 (PDT)
      visitStart: { actual: '2026-07-08T13:01:00Z' },
      visitStop: { actual: '2026-07-08T18:01:00Z' },
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');

    const shiftPatches = result.calls.filter(
      (c) => c.method === 'PATCH' && c.url.includes('/api/v2/field-app/shifts/44390825/')
    );
    // home→store: one punch PATCH carries times + H→S CHANGE (kompass-netcap HAR)
    assert.equal(shiftPatches.length, 1, 'expected single punch+mileage shift PATCH');

    const punchPayload = shiftPatches[0].payload;

    assert.equal(punchPayload.actual_start_time, '06:01:00');
    assert.equal(punchPayload.actual_end_time, '11:01:00');
    assert.equal(punchPayload.time_change_reason, writeReasons.shiftTimeChangeReason.selected.id);
    assert.equal(
      punchPayload.time_change_comment,
      'Entered from Stage 3 sealed record | Actual store 215 (scheduled placeholder 391)'
    );

    assert.ok(punchPayload.travel_records?.some((t) => t.record_type === 'CHANGE'));
    assert.equal(punchPayload.travel_records[0].distance, '3.60');
    assert.equal(punchPayload.travel_records[0].change_reason, 5);
    assert.equal(punchPayload.travel_records[0].shift_id, 44390825);
    assert.equal(punchPayload.travel_records[0].id, null);

    assert.equal(punchPayload.actual_start_date, '2026-07-08');
    assert.ok(result.mileageAudit, 'matrix leg retained as audit-only on result');
    assert.equal(result.mileageAudit.distance, '3.60');
    assert.equal(result.mileageAudit._auditOnly, true);

    // Explicit anti-regression: must not reintroduce the UTC-slice bug
    assert.notEqual(punchPayload.actual_start_time, '13:01:00');
    assert.notEqual(punchPayload.actual_end_time, '18:01:00');
  });

  it('assembles automator-aligned travel + survey run_info (HAR 2026-07-21)', async () => {
    const sealed = makeSealedRecord({
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');

    const travel = result.calls.find((c) => c.url.includes('/travel/') && c.url.includes('/to_store/'));
    assert.deepEqual(travel.payload, {
      start_time: '2026-07-08T13:01:00.000Z',
      user_accepted_ss_replace: null,
    });

    // No shift_id step-advance pings — mid/final use team_lead_feedback:null
    const shiftIdPings = result.calls.filter(
      (c) => c.method === 'PATCH' && c.url.includes('/shift-complete/') && c.payload && c.payload.shift_id
    );
    assert.equal(shiftIdPings.length, 0);
    const feedbackPings = result.calls.filter(
      (c) =>
        c.method === 'PATCH' &&
        c.url.includes('/shift-complete/') &&
        c.payload &&
        Object.prototype.hasOwnProperty.call(c.payload, 'team_lead_feedback') &&
        !Object.prototype.hasOwnProperty.call(c.payload, 'allowed_overlap')
    );
    assert.ok(feedbackPings.length >= 2);

    const answer = result.calls.find((c) => c.url.endsWith('/surveys/answers/'));
    assert.ok(answer.payload.run_info);
    assert.equal(answer.payload.runid, undefined);
    assert.equal(answer.payload.is_field_web, true);

    const runInfo = result.calls.find((c) => c.url.endsWith('/surveys/run-infos/'));
    assert.equal(runInfo.payload.runid, null);

    const complete = result.calls.find((c) => c.url.includes('/surveys/surveys/') && c.url.endsWith('/complete/'));
    assert.equal(complete.payload.responder, 8336939);
    assert.ok(complete.payload.run_info);

    const ansImg = result.calls.find((c) => c.url.endsWith('/answer-images/'));
    assert.equal(ansImg.payload._executorEncoding, 'multipart-answer-image');
  });

  it('assembles assignee + spent_time after punch; category_completion before T&E', async () => {
    const sealed = makeSealedRecord({
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');

    assert.ok(!result.calls.some((c) => (c.url || '').includes('/validate-spent-time-reason/')));

    const completeIdx = result.calls.findIndex(
      (c) => c.payload?.category_completion === true && c.url.includes('/category-resets/')
    );
    const punchIdx = result.calls.findIndex((c) => c.method === 'PATCH' && c.url.includes('/api/v2/field-app/shifts/'));
    const assignIdx = result.calls.findIndex((c) => c.payload?.new_assignee && c.url.includes('/category-resets/'));
    const spentIdx = result.calls.findIndex(
      (c) => c.payload?.spent_time && c.payload?.spent_time_reason && c.url.includes('/category-resets/')
    );

    assert.ok(completeIdx >= 0 && completeIdx < punchIdx, 'category_completion before punch');
    assert.ok(assignIdx > punchIdx, 'new_assignee after punch');
    assert.equal(result.calls[assignIdx].payload.new_assignee.employee_id, 354456);
    assert.ok(spentIdx > assignIdx, 'spent_time after assignee');
    assert.equal(result.calls[spentIdx].payload.spent_time_reason.id, 3);
    assert.match(result.calls[spentIdx].payload.spent_time_reason.text, /supervisor was contacted/);

    assert.ok(result.recompletePayload?.['category-reset']?.[0]?.id);
    assert.equal(result.recompletePayload.complete_shift_final.allowed_truncation, false);

    const answer = result.calls.find((c) => c.url.endsWith('/surveys/answers/'));
    assert.equal(answer.payload.is_field_web, true);
    assert.equal(answer.payload.delete, false);
  });

  it('James FM53 path: visit start, time change, spent_time, to_home, S→H mileage CHANGE, PUT complete', async () => {
    const sealed = makeSealedRecord({
      visitStart: { actual: '2026-07-15T22:40:00Z' },
      visitStop: { actual: '2026-07-15T23:04:00Z' },
      isLastStopOfDay: true,
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
      actualStore: 53,
      mileage: { leg: { from: '53', to: 'home', miles: 3.4, source: 'store-to-home', warning: null } },
    });
    const matched = makeMatchedVisit();
    matched.prodVisit.actualStore = 53;
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: matched, opts: baseOpts() });
    assert.equal(result.status, 'ok');
    assert.equal(result.toHomeAssembled, true);
    assert.equal(result.workTime.minutes, 24);
    assert.equal(result.workTime.needsSpentTimeReason, true);
    assert.equal(result.mileageCorrection.direction, 'S-H');
    assert.equal(result.mileageCorrection.distance, '3.40');

    const methods = result.calls.map((c) => `${c.method} ${c.url.replace('https://prod.sasretail.com', '')}`);
    const startVisitIdx = methods.findIndex((m) => m === 'PATCH /api/v1/field-app/visits/27000510/');
    const toStoreIdx = methods.findIndex((m) => m.includes('/to_store/'));
    const firstShiftIdx = methods.findIndex((m) => m.startsWith('PATCH /api/v2/field-app/shifts/'));
    const teamCompleteIdx = result.calls.findIndex(
      (c) => c.payload?.category_completion === true && (c.url || '').includes('/category-resets/')
    );
    const surveyDoneIdx = methods.findIndex((m) => m.includes('/surveys/surveys/') && m.endsWith('/complete/'));
    const toHomeIdx = methods.findIndex((m) => m.includes('/to_home/'));
    const putIdx = methods.findIndex((m) => m.startsWith('PUT '));

    assert.ok(startVisitIdx >= 0, 'visit schedule start');
    // Start PATCH must carry the real prod completion.har body — an empty body 400s in PROD.
    const startVisitCall = result.calls[startVisitIdx];
    assert.equal(startVisitCall.payload.visit_id, 27000510);
    assert.match(startVisitCall.payload.actual_start_time, /^\d{1,2}:\d{2}\s?(AM|PM)$/, 'actual_start_time is 12h local');
    assert.match(startVisitCall.payload.actual_start_datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'actual_start_datetime is UTC');
    assert.equal(startVisitCall.payload.isMerchandiserStartingVisit, true);
    assert.equal(startVisitCall.payload.from_state, 'admin');
    assert.deepEqual(startVisitCall.payload.start_location, [-1, -1]);
    // kompass-netcap HAR 2026-07-21 order: start → survey → category_completion → to_store → punch → to_home → PUT
    assert.ok(startVisitIdx < surveyDoneIdx, 'start visit before survey');
    assert.ok(surveyDoneIdx < teamCompleteIdx, 'survey before category_completion');
    assert.ok(teamCompleteIdx < toStoreIdx, 'category_completion before to_store');
    assert.ok(toStoreIdx < toHomeIdx, 'to_store before to_home');
    assert.ok(toHomeIdx < firstShiftIdx, 'to_home before punch+mileage PATCH');
    assert.ok(firstShiftIdx < putIdx, 'punch before PUT complete');

    const punchShift = result.calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/api/v2/field-app/shifts/')
    );
    assert.equal(punchShift.payload.actual_start_time, '15:40:00');
    assert.equal(punchShift.payload.actual_end_time, '16:04:00');
    assert.equal(punchShift.payload.time_change_reason, 5);
    assert.equal(
      punchShift.payload.time_change_comment,
      'Entered from Stage 3 sealed record | Actual store 53 (scheduled placeholder 391)'
    );
    // S→H CHANGE rides on the same punch PATCH (HAR 00-54-51 combines legs)
    assert.ok(punchShift.payload.travel_records?.length >= 1);
    const sh = punchShift.payload.travel_records[0];
    assert.equal(sh.record_type, 'CHANGE');
    assert.equal(sh.start_location_type, 'S');
    assert.equal(sh.end_location_type, 'H');
    assert.equal(sh.distance, '3.40');
    assert.equal(sh.change_reason, 5);
    assert.equal(sh.id, null);

    const spentCall = result.calls.find(
      (c) => c.payload?.spent_time && c.payload?.spent_time_reason && (c.url || '').includes('/category-resets/')
    );
    assert.ok(spentCall, 'spent_time_reason on category reset');
    assert.equal(spentCall.payload.spent_time, '0h 24m');
    assert.equal(spentCall.payload.spent_time_reason.id, 3);

    const toHome = result.calls.find((c) => c.url.includes('/to_home/'));
    // HAR 00-54-51: to_home body is { end_time }, not start_time.
    assert.equal(toHome.payload.end_time, '2026-07-15T23:04:00.000Z');
    assert.equal(toHome.payload.start_time, undefined);
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(toHome.payload.end_time));

    const put = result.calls.find((c) => c.method === 'PUT' && c.url.includes('/shift-complete/'));
    assert.equal(put.payload.validate_geo, true);
    assert.deepEqual(put.payload.end_location, [-1, -1]);
    assert.equal(put.payload.allowed_missing_ques, false);
    assert.equal(put.payload.team_lead_feedback, 'this is for store 53');
  });

  it('last-stop with inbound S→S + outbound S→H seals both CHANGE rows on one punch', async () => {
    const sealed = makeSealedRecord({
      visitStart: { actual: '2026-07-20T18:56:00Z' },
      visitStop: { actual: '2026-07-20T20:26:00Z' },
      isLastStopOfDay: true,
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
      actualStore: 19,
      mileage: {
        leg: { from: '19', to: 'home', miles: 7.8, source: 'store-to-home', warning: null },
        legs: [
          { from: '111', to: '19', miles: 20, source: 'store-to-store', warning: null },
          { from: '19', to: 'home', miles: 7.8, source: 'store-to-home', warning: null },
        ],
      },
    });
    const matched = makeMatchedVisit();
    matched.prodVisit.actualStore = 19;
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: matched, opts: baseOpts() });
    assert.equal(result.status, 'ok');
    assert.equal(result.toHomeAssembled, true);
    assert.deepEqual(result.mileageCorrection.directions, ['S-S', 'S-H']);

    const toHome = result.calls.find((c) => (c.url || '').includes('/to_home/'));
    assert.equal(toHome.payload.end_time, '2026-07-20T20:26:00.000Z');

    const shiftPatches = result.calls.filter(
      (c) => c.method === 'PATCH' && c.url.includes('/api/v2/field-app/shifts/')
    );
    assert.equal(shiftPatches.length, 1);
    const records = shiftPatches[0].payload.travel_records || [];
    assert.equal(records.length, 2);
    assert.equal(records[0].start_location_type, 'S');
    assert.equal(records[0].end_location_type, 'S');
    assert.equal(records[0].distance, '20.00');
    assert.equal(records[1].start_location_type, 'S');
    assert.equal(records[1].end_location_type, 'H');
    assert.equal(records[1].distance, '7.80');

    const put = result.calls.find((c) => c.method === 'PUT' && c.url.includes('/shift-complete/'));
    assert.equal(put.payload.team_lead_feedback, 'this is for store 19');
  });

  it('does not assemble to_home when not last stop of day', async () => {
    const sealed = makeSealedRecord({
      isLastStopOfDay: false,
      beforePhotos: [tmpPhoto('before.jpg')],
      afterPhotos: [tmpPhoto('after.jpg')],
    });
    const result = await transmitVisit({ sealedRecord: sealed, matchedVisit: makeMatchedVisit(), opts: baseOpts() });
    assert.equal(result.status, 'ok');
    assert.equal(result.toHomeAssembled, false);
    assert.ok(!result.calls.some((c) => (c.url || '').includes('/to_home/')));
  });

  it('pickVisitRepResponder prefers rep sas email over arbitrary first row', () => {
    const rows = [
      { id: 1, name: 'tyson.gauthier@retailodyssey.com' },
      { id: 8336939, name: 'brian.campbell@sasretailservices.com' },
    ];
    const picked = pickVisitRepResponder(rows, { repKey: 'brian-campbell', repName: 'Brian Campbell' });
    assert.equal(picked.responder.id, 8336939);
    assert.ok(['email', 'name', 'sasretailservices_fallback'].includes(picked.matchedBy));
  });
});

