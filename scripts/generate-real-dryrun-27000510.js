'use strict';

/**
 * Stage 4 — generates ONE real dry run for Brian Campbell's P06W3 visit
 * (prod visit 27000510, scheduled store 391, decoded store 215) so the
 * assembled sequence can be diffed against the actual HAR recording
 * (central pet shifts.json / data/har-evidence-27000510.json).
 *
 * This visit already ran (and completed) before Stage 3 existed, so there is
 * no captured local sealed draft for it. Every field below is sourced from
 * the real HAR evidence:
 *  - times: HAR entry #137 (actual_start 2026-07-08T13:01:00Z) / #353
 *    (corrected stop, executed_datetime 2026-07-08T18:01:00Z)
 *  - survey answers: HAR entry #220-area GET /surveys/answers/ response dump
 *    (the actual 8 answers this rep submitted — verbatim)
 *  - before/after photos: the REAL category-reset images from this visit,
 *    downloaded from their still-live CloudFront URLs (HAR entry #158/#167)
 *    into data/dryrun-demo-photos/
 *  - ids: visitId 27000510, shiftId 44390825, workdayGivenId 800553343,
 *    survey 115502, responder 8336939, category-reset row 41384408 — all
 *    from data/har-evidence-27000510.json
 *
 * ONE known gap, flagged per T's 2026-07-13 sign-off (see AskQuestion log):
 * the real HAR shows ZERO /surveys/answer-images/ calls, even though the
 * live prod schema requires an image for q3='Fully stocked' and q7='Yes'
 * (this was a supervisor admin-backfill submission, referer
 * .../survey/admin, which apparently didn't enforce it client-side). No
 * such per-answer photo exists in the real evidence. T approved reusing the
 * two real category-reset photos as flagged stand-ins so a complete
 * sequence assembles for full diffing — this is NOT the actual q3/q7 answer
 * evidence, just the closest real photographic evidence from this visit.
 *
 * sasGet is a fixture replaying REAL HAR response bodies (this visit
 * completed long ago in prod; a live GET would immediately hit the
 * already_completed_in_prod idempotency guard and abort before assembling
 * anything useful for diffing).
 */

const path = require('path');
const { transmitVisit } = require('../src/lib/prod-transmitter');
const dryrunStore = require('../src/lib/dryrun-store');
const { generateRunId } = require('../src/lib/dryrun-runner');
const writeReasons = require('../data/sas-write-reasons.json');
const visitFlow = require('../src/lib/visit-flow');

const REPO_ROOT = path.join(__dirname, '..');
const photo = (file, category, seq) => ({
  path: `data/dryrun-demo-photos/${file}`,
  store: 215,
  date: '2026-07-08',
  category,
  seq,
});

/* Real HAR response bodies (data/har-evidence-27000510.json), replayed as
 * the read-only GETs transmitVisit() performs during assembly. This visit
 * is historical/completed, so these are the pre-write-sequence snapshots
 * (before any of the assembled calls below actually ran in the real HAR),
 * not a live prod session. */
function harReplaySasGet() {
  return async (_token, urlPath) => {
    const p = urlPath.replace(/^\//, '');
    switch (p) {
      case 'field-app/visits/27000510/shift-complete/':
        // HAR entry #81 pre-state — current_status in-progress, no actual_start yet.
        return {
          current_status: 'in-progress',
          employees: [{ id: 354456, shift_id: 44390825, actual_start_time: null, no_show: true }],
        };
      case 'v2/field-app/shifts/44390825/':
        // HAR entry #128
        return { home_to_store: true, store_to_store: true, store_to_home: true, calculate_mileage: true };
      case 'field-app/visits/27000510/category-resets/':
        // HAR entry #158 (row id/name; before/after image counts irrelevant to row resolution)
        return { category_resets: [{ id: 41384408, name: 'PET CARE SUPPLIES', category_id: 986 }] };
      case 'v2/field-app/survey-visits/':
        // HAR entry #194
        return [{ id: 25760350, visit: 27000510, survey: { id: 115502, name: 'Central Pet Service Survey' } }];
      case 'surveys/questions/':
        // HAR entry #198 — real, complete prod question set for survey 115502
        return [
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
            answer_image_required: true,
            choices: [
              { text: 'Fully stocked', is_image_required: true },
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
      case 'field-app/spent-time-reasons/':
        // data/sas-write-reasons.json, sourced from HAR entry #142
        return [writeReasons.categorySpentTimeReason.selected];
      case 'operations/time-change-reason/':
        // data/sas-write-reasons.json, sourced from HAR entry #108
        return [writeReasons.shiftTimeChangeReason.selected];
      case 'surveys/responders/':
        // HAR entry #193 — an existing responder for this visit
        return [{ id: 8336939, name: 'brian.campbell@sasretailservices.com', visit_id: 27000510 }];
      default:
        throw new Error(`harReplaySasGet: no recorded HAR evidence for GET ${p} — refusing to invent a response`);
    }
  };
}

async function main() {
  const leg = visitFlow.computeMileageLeg({
    workdayGivenId: '800553343',
    actualStore: 215,
    previousCompletedStore: null,
    isLastStopOfDay: false,
  });

  const sealedRecord = {
    repKey: 'brian-campbell',
    date: '2026-07-08',
    scheduledStore: 391,
    actualStore: 215,
    status: 'ready_for_prod',
    visitStart: { actual: '2026-07-08T13:01:00Z' }, // HAR entry #137
    visitStop: { actual: '2026-07-08T18:01:00Z' }, // HAR entry #353 (executed_datetime)
    beforePhotos: [photo('before-1.jpeg', 'before', 1), photo('before-2.jpeg', 'before', 2)],
    afterPhotos: [photo('after-1.jpg', 'after', 1)],
    categoryPhotos: {
      clipstrips: [
        {
          ...photo('after-1.jpg', 'clipstrips', 1),
          _standIn: true,
          _standInNote:
            "STAND-IN for q5's required image: same gap/approval as q3/q7 below (no /surveys/answer-images/ call exists in the real HAR for this admin-backfilled visit).",
        },
      ],
      'cp-serviced-section': [
        {
          ...photo('before-2.jpeg', 'cp-serviced-section', 1),
          _standIn: true,
          _standInNote:
            "STAND-IN for q3's required image: the real HAR has no /surveys/answer-images/ call for this admin-backfilled visit. Reusing the real before-2 category-reset photo per T's 2026-07-13 sign-off so the full sequence assembles for diffing.",
        },
      ],
      'cat-litter-pan-liners': [
        {
          ...photo('after-1.jpg', 'cat-litter-pan-liners', 1),
          _standIn: true,
          _standInNote:
            "STAND-IN for q7's required image: same gap/approval as q3 above.",
        },
      ],
    },
    // Real answers this rep submitted (GET /surveys/answers/ response dump,
    // HAR ~entry #220 area) — verbatim, including the en dash question (q7)
    // which was answered "Yes" here (no en dash in the answer itself; the en
    // dash only appears in the *unselected* choice text for this visit).
    survey: {
      q1: 'yes',
      q2: 'Yes',
      q3: 'Fully stocked',
      q5: 'yes',
      q7: 'Yes',
      q9: 'yes',
      q11: '3 Endcaps, 3 Wing Panels, Six Endcap Clipstrips',
      q12: 'yes',
    },
    mileage: { leg },
  };

  const matchedVisit = {
    status: 'matched',
    appShift: { id: 'p06w3-brian-215', repKey: 'brian-campbell', date: '2026-07-08', actualStore: 215 },
    prodVisit: {
      visitId: 27000510,
      scheduledStore: 391,
      actualStore: 215,
      workdayGivenId: '800553343',
      repKey: 'brian-campbell',
      shiftId: 44390825,
      visitStatus: 'in-progress',
    },
  };

  const result = await transmitVisit({
    sealedRecord,
    matchedVisit,
    opts: {
      sasGet: harReplaySasGet(),
      loadSession: async () => ({ token: 'unused-fixture-token-never-in-output' }),
      timeChangeComment: 'Entered by supervisor — Stage 4 real dry-run replay for HAR diffing (2026-07-13)',
    },
  });

  const runId = generateRunId();
  console.log(`status: ${result.status}`);
  if (result.status === 'ok') {
    console.log(`calls assembled: ${result.calls.length}`);
    console.log('photoCounts:', JSON.stringify(result.photoCounts));
    const file = dryrunStore.writeVisitFile(runId, {
      repKey: sealedRecord.repKey,
      date: sealedRecord.date,
      store: sealedRecord.actualStore,
      assembled: result,
    });
    const manifest = {
      runId,
      generatedAt: new Date().toISOString(),
      note:
        'Real dry run for one historical, already-completed visit (Brian/27000510/decoded 215, P06W3), replayed from real HAR evidence per T request — not a scan of current sealed drafts.',
      visits: [
        {
          repKey: sealedRecord.repKey,
          date: sealedRecord.date,
          store: sealedRecord.actualStore,
          visitId: result.visitId,
          callCount: result.callCount,
          photoCounts: result.photoCounts,
          file: path.basename(file),
        },
      ],
      aborted: [],
      summary: { eligible: 1, assembled: 1, aborted: 0 },
    };
    dryrunStore.writeManifest(runId, manifest);
    console.log(`\nWrote:\n  ${path.relative(REPO_ROOT, dryrunStore.runDir(runId))}\\manifest.json\n  ${path.relative(REPO_ROOT, file)}`);
  } else {
    console.log(`abortReason: ${result.abortReason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
