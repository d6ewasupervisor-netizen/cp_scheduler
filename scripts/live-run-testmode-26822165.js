'use strict';

/**
 * Supervised first LIVE testMode round-trip for visit 26822165
 * (scheduled 391 / decoded 111, 2026-07-13, Brian Campbell).
 *
 * 1) Build sealed draft + photos from golden export
 * 2) Assemble dry-run sequence (fixture pretends not completed)
 * 3) executeLiveTransmit testMode against real prod
 * 4) Caller re-exports + diffs
 */

const fs = require('fs');
const path = require('path');

process.env.LIVE_TRANSMIT = '1';

const { loadSasSession } = require('../src/lib/sas-session');
const { transmitVisit, defaultSasGet } = require('../src/lib/prod-transmitter');
const dryrunStore = require('../src/lib/dryrun-store');
const { generateRunId } = require('../src/lib/dryrun-runner');
const visitFlow = require('../src/lib/visit-flow');
const visitDraftStore = require('../src/lib/visit-draft-store');
const { executeLiveTransmit } = require('../src/lib/live-executor');
const { draftIdFromParts } = require('../src/lib/live-allowlist');
const writeReasons = require('../data/sas-write-reasons.json');

const REPO = path.join(__dirname, '..');
const GOLDEN = 'C:/Users/tgaut/Downloads/cp_tests/visit-26822165';
const VISIT_ID = 26822165;
const SHIFT_ID = 44391990;
const EMPLOYEE_ID = 354456;
const RESPONDER_ID = 8336947;
const SURVEY_ID = 115654;
const RESET_ID = 41531947;
const DATE = '2026-07-13';
const ACTUAL_STORE = 111;
const SCHEDULED_STORE = 391;
const REP = 'brian-campbell';
const WORKDAY = '800553343';

function copyPhoto(src, destRel) {
  const dest = path.join(REPO, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return destRel.split(path.sep).join('/');
}

function pickGoldenPhotos() {
  const photosRoot = path.join(GOLDEN, 'photos');
  const before = [];
  const after = [];
  const category = {
    clipstrips: [],
    'cp-serviced-section': [],
    'cat-litter-pan-liners': [],
  };

  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(jpe?g|png)$/i.test(name)) {
        if (/before/i.test(full) || /q01/i.test(full)) before.push(full);
        else if (/after/i.test(full) || /q12/i.test(full)) after.push(full);
        else if (/q05/i.test(full)) category.clipstrips.push(full);
        else if (/q03/i.test(full)) category['cp-serviced-section'].push(full);
        else if (/q07/i.test(full)) category['cat-litter-pan-liners'].push(full);
      }
    }
  }
  walk(photosRoot);

  const base = `data/visit-drafts/${REP}/${DATE}-${ACTUAL_STORE}-photos`;
  const beforePhotos = (before.slice(0, 2).length ? before.slice(0, 2) : before.slice(0, 1)).map((src, i) => {
    const rel = copyPhoto(src, `${base}/before-${i + 1}.jpg`);
    return { path: rel, store: ACTUAL_STORE, date: DATE, category: 'before', seq: i + 1 };
  });
  // ensure at least one before/after
  if (!beforePhotos.length) {
    const demo = path.join(REPO, 'data/dryrun-demo-photos/before-1.jpeg');
    const rel = copyPhoto(demo, `${base}/before-1.jpg`);
    beforePhotos.push({ path: rel, store: ACTUAL_STORE, date: DATE, category: 'before', seq: 1 });
  }
  const afterSrc = after[0] || before[0] || path.join(REPO, 'data/dryrun-demo-photos/after-1.jpg');
  const afterRel = copyPhoto(afterSrc, `${base}/after-1.jpg`);
  const afterPhotos = [{ path: afterRel, store: ACTUAL_STORE, date: DATE, category: 'after', seq: 1 }];

  const categoryPhotos = {};
  for (const [id, list] of Object.entries(category)) {
    const src = list[0] || afterSrc;
    const rel = copyPhoto(src, `${base}/${id}-1.jpg`);
    categoryPhotos[id] = [{ path: rel, store: ACTUAL_STORE, date: DATE, category: id, seq: 1 }];
  }
  // remaining category targets need ≥1 for seal/assembly completeness
  for (const cat of visitFlow.CATEGORY_PHOTO_TARGETS) {
    if (!categoryPhotos[cat.id]) {
      const rel = copyPhoto(afterSrc, `${base}/${cat.id}-1.jpg`);
      categoryPhotos[cat.id] = [{ path: rel, store: ACTUAL_STORE, date: DATE, category: cat.id, seq: 1 }];
    }
  }

  return { beforePhotos, afterPhotos, categoryPhotos };
}

function writeSealedDraft(photos) {
  const leg = visitFlow.computeMileageLeg({
    workdayGivenId: WORKDAY,
    actualStore: ACTUAL_STORE,
    previousCompletedStore: null,
    isLastStopOfDay: false,
  });
  const draftId = draftIdFromParts(REP, DATE, ACTUAL_STORE);
  const draft = {
    id: draftId,
    repKey: REP,
    weekStart: '2026-07-13',
    shiftId: String(SHIFT_ID),
    date: DATE,
    scheduledStore: SCHEDULED_STORE,
    actualStore: ACTUAL_STORE,
    writeOrder: true,
    workLoad: true,
    picksDay: 'Wed',
    steps: visitFlow.buildStepSequence({ workLoad: true, writeOrder: true }),
    currentStep: 'review',
    status: 'ready_for_prod',
    startedAt: '2026-07-13T16:38:00Z',
    startedBy: 'live-run-testmode-26822165',
    visitStart: { actual: '2026-07-13T16:38:00Z', source: 'manual', note: null },
    visitStop: { actual: '2026-07-13T19:13:00Z', note: null },
    beforePhotos: photos.beforePhotos,
    afterPhotos: photos.afterPhotos,
    loadCheck: { status: 'no_escalated', photo: null, updatedAt: new Date().toISOString() },
    checklist: {},
    categoryPhotos: photos.categoryPhotos,
    survey: {
      q1: 'yes',
      q2: 'No',
      q3: 'Partially stocked with holes / OOS',
      q4: 'holes / OOS — live testMode re-write 26822165',
      q5: 'yes',
      q7: 'Yes',
      q9: 'yes',
      q11: 'O — Stage4 live testMode round-trip 26822165',
      q12: 'yes',
    },
    isLastStopOfDay: false,
    mileage: { leg, repNote: 'matrix decoded 111 (not SAS 391 trap 30.80)' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sealedAt: new Date().toISOString(),
  };
  // tick write-order checklist items for seal completeness (not all needed for assembly)
  for (const item of visitFlow.writeOrderChecklistItems()) {
    draft.checklist[item.id] = {
      checked: true,
      photo: item.photoRequired
        ? {
            path: photos.afterPhotos[0].path,
            store: ACTUAL_STORE,
            date: DATE,
            category: `checklist-${item.id}`,
            seq: 1,
          }
        : null,
      ackAt: new Date().toISOString(),
    };
  }

  const file = visitDraftStore.draftFilePath(REP, DATE, ACTUAL_STORE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(draft, null, 2));
  return draft;
}

function setAllowlist(draftId) {
  const p = path.join(REPO, 'data/live-allowlist.json');
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        notes: 'LIVE first run — single draft only. Clear after session.',
        draftIds: [draftId],
      },
      null,
      2
    )
  );
}

async function liveGet(token, urlPath, params = {}) {
  // defaultSasGet maps /v2/... incorrectly to /api/v1/v2/... — normalize first
  let p = String(urlPath);
  if (p.startsWith('/v2/')) p = `/api${p}`;
  else if (p.startsWith('v2/')) p = `/api/${p}`;
  else if (!p.startsWith('/api/')) p = p.startsWith('/') ? p : `/${p}`;
  return defaultSasGet(token, p, params);
}

function makeAssemblySasGet(token) {
  return async (_tok, urlPath, params = {}) => {
    const p = String(urlPath).replace(/^\//, '');
    // Pretend startable so assembly does not abort on completed visit
    if (p.includes(`field-app/visits/${VISIT_ID}/shift-complete`)) {
      return {
        current_status: 'in-progress',
        employees: [{ id: EMPLOYEE_ID, shift_id: SHIFT_ID, actual_start_time: null, no_show: false }],
      };
    }
    return liveGet(token, urlPath, params);
  };
}

async function main() {
  console.log('=== LIVE testMode 26822165 — supervised first run ===');
  console.log('LIVE_TRANSMIT=', process.env.LIVE_TRANSMIT);

  const session = await loadSasSession();
  console.log('session', session.generatedAt, session.source);

  const photos = pickGoldenPhotos();
  const sealed = writeSealedDraft(photos);
  const draftId = sealed.id;
  setAllowlist(draftId);
  console.log('draft', draftId, 'matrix leg', sealed.mileage.leg);

  const matchedVisit = {
    status: 'matched',
    appShift: { id: `live-${VISIT_ID}`, repKey: REP, date: DATE, actualStore: ACTUAL_STORE },
    prodVisit: {
      visitId: VISIT_ID,
      scheduledStore: SCHEDULED_STORE,
      actualStore: ACTUAL_STORE,
      workdayGivenId: WORKDAY,
      repKey: REP,
      shiftId: SHIFT_ID,
      visitStatus: 'in-progress',
    },
  };

  console.log('Assembling…');
  const assembled = await transmitVisit({
    sealedRecord: sealed,
    matchedVisit,
    opts: {
      sasGet: makeAssemblySasGet(session.token),
      loadSession: async () => session,
      timeChangeComment: 'Stage 4 live testMode round-trip — visit 26822165 decoded 111 (2026-07-14 supervised)',
      categorySpentTimeReasonText: writeReasons.categorySpentTimeReason.selected.text,
      timeChangeReasonText: writeReasons.shiftTimeChangeReason.selected.text,
    },
  });

  if (assembled.status !== 'ok') {
    console.error('ASSEMBLY FAILED', assembled.abortReason);
    process.exitCode = 1;
    return;
  }
  console.log('assembled calls', assembled.callCount, 'visitId', assembled.visitId);

  // Rewrite assembled URLs/ids already correct from live GETs
  const runId = generateRunId();
  const visitFile = path.basename(
    dryrunStore.writeVisitFile(runId, {
      repKey: REP,
      date: DATE,
      store: ACTUAL_STORE,
      assembled,
    })
  );
  dryrunStore.writeManifest(runId, {
    runId,
    generatedAt: new Date().toISOString(),
    note: 'LIVE testMode supervised first run — visit 26822165',
    visits: [
      {
        repKey: REP,
        date: DATE,
        store: ACTUAL_STORE,
        visitId: VISIT_ID,
        callCount: assembled.callCount,
        photoCounts: assembled.photoCounts,
        file: visitFile,
      },
    ],
    aborted: [],
    summary: { eligible: 1, assembled: 1, aborted: 0 },
  });
  console.log('dryrun', runId, visitFile);

  console.log('Executing LIVE transmit (testMode)…');
  const result = await executeLiveTransmit({
    dryRunId: runId,
    visitFile,
    draftId,
    confirmStore: ACTUAL_STORE,
    mode: 'start',
    testMode: true,
    goldenExportPath: GOLDEN,
    inject: {
      loadSession: async () => session,
      token: session.token,
      // real network for all calls including writes
    },
  });

  console.log('\n=== EXECUTOR RESULT ===');
  console.log(
    JSON.stringify(
      {
        status: result.status,
        abortReason: result.abortReason,
        callsSent: result.callsSent,
        lastSuccessfulSeq: result.lastSuccessfulSeq,
        failedSeq: result.failedSeq,
        recompleteAppended: result.recompleteAppended,
        nextStep: result.nextStep,
        preflightFailures: result.preflightFailures,
        transmittedAt: result.transmittedAt,
      },
      null,
      2
    )
  );

  const outPath = path.join(REPO, 'live', runId, 'live-run-result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        runId,
        visitFile,
        draftId,
        visitId: VISIT_ID,
        result,
      },
      null,
      2
    )
  );
  console.log('wrote', outPath);

  if (result.status !== 'complete') {
    process.exitCode = 2;
    console.error('LIVE RUN DID NOT COMPLETE — inspect live/', runId);
  } else {
    console.log('\nNEXT: re-export visit 26822165 via export-cp-shift-full.js, then run roundtrip-diff.');
    console.log('Golden:', GOLDEN);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
