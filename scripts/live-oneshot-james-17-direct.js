#!/usr/bin/env node
'use strict';

/**
 * Direct one-shot for James 2026-07-17 (visit 27071906, shift 44567128).
 * Bypasses the matcher (which won't match the already-started/in-progress visit)
 * by constructing matchedVisit explicitly. Assembles via transmitVisit, then
 * executeLiveTransmit. Verbose on failure so each iteration is fast to diagnose.
 *
 *   LIVE_TRANSMIT=1 node scripts/live-oneshot-james-17-direct.js --dry-only
 *   LIVE_TRANSMIT=1 node scripts/live-oneshot-james-17-direct.js
 */

process.env.LIVE_TRANSMIT = '1';

const fs = require('fs');
const path = require('path');
const visitDraftStore = require('../src/lib/visit-draft-store');
const { transmitVisit } = require('../src/lib/prod-transmitter');
const { executeLiveTransmit } = require('../src/lib/live-executor');
const dryrunStore = require('../src/lib/dryrun-store');
const liveRegistry = require('../src/lib/live-registry');
const { ALLOWLIST_PATH, draftIdFromParts } = require('../src/lib/live-allowlist');

const REP = 'james-duchene';
const DATE = '2026-07-17';
const STORE = 53;
const DRAFT_ID = draftIdFromParts(REP, DATE, STORE);
const CONFIRM_STORE = 53;

const matchedVisit = {
  status: 'matched',
  appShift: { id: 'james-2026-07-17', repKey: REP, date: DATE, actualStore: STORE },
  prodVisit: {
    visitId: 27071906,
    shiftId: 44567128,
    scheduledStore: 391,
    actualStore: 53,
    repKey: REP,
    workdayGivenId: '800627385',
    visitStatus: 'in-progress',
  },
};

function writeAllowlist(draftIds, notes) {
  fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify({ notes, draftIds }, null, 2));
}

async function main() {
  const dryOnly = process.argv.includes('--dry-only');
  const resume = process.argv.includes('--resume');

  const sealedRecord = visitDraftStore.getDraft(REP, DATE, STORE);
  if (!sealedRecord) throw new Error('sealed draft not found on volume');
  console.log('[direct] sealed status:', sealedRecord.status);

  const assembled = await transmitVisit({
    sealedRecord,
    matchedVisit,
    opts: { timeChangeComment: 'Entered from Stage 3 sealed record — James Duchene 2026-07-17' },
  });
  console.log(
    '[direct] assembly:', assembled.status,
    '| abortReason:', assembled.abortReason,
    '| calls:', (assembled.calls || []).length,
    '| skipStart:', !!assembled.visitAlreadyStarted
  );
  if (assembled.status !== 'ok') {
    console.log('[direct] ASSEMBLY ABORT:', assembled.abortReason);
    return;
  }

  if (dryOnly) {
    console.log('[direct] --- assembled sequence ---');
    for (const c of assembled.calls) {
      console.log(
        '  seq', String(c.seq).padStart(2), c.method,
        (c.url || '').replace('https://prod.sasretail.com', ''),
        c.payload && Object.keys(c.payload).length ? '| ' + JSON.stringify(c.payload).slice(0, 120) : ''
      );
    }
    return;
  }

  const runId = 'direct-' + Date.now();
  const file = dryrunStore.writeVisitFile(runId, { repKey: REP, date: DATE, store: STORE, assembled });
  writeAllowlist([DRAFT_ID], 'direct james 2026-07-17 live');

  const result = await executeLiveTransmit({
    dryRunId: runId,
    visitFile: path.basename(file),
    draftId: DRAFT_ID,
    confirmStore: CONFIRM_STORE,
    mode: resume ? 'resume' : 'start',
    testMode: false,
  });

  console.log('[direct] RESULT', JSON.stringify({
    status: result.status,
    abortReason: result.abortReason,
    lastSuccessfulSeq: result.lastSuccessfulSeq,
    failedSeq: result.failedSeq,
    callsSent: result.callsSent,
    transmittedAt: result.transmittedAt,
  }, null, 2));

  if (result.failedSeq) {
    const fc = (assembled.calls || []).find((c) => c.seq === result.failedSeq);
    console.log('[direct] FAILED CALL seq', result.failedSeq, fc && fc.method, fc && (fc.url || '').replace('https://prod.sasretail.com', ''));
    console.log('[direct] FAILED PAYLOAD:', JSON.stringify(fc && fc.payload).slice(0, 400));
    // Response body from the persisted partial
    try {
      const rec = liveRegistry.getTransmitRecord(DRAFT_ID);
      const le = (rec && rec.logEntries || []).find((l) => l.seq === result.failedSeq);
      if (le) console.log('[direct] FAILED RESPONSE status', le.status, 'body:', JSON.stringify(le.body).slice(0, 600));
    } catch (e) {
      console.log('[direct] (could not read partial response:', e.message + ')');
    }
  }

  writeAllowlist([], `cleared after direct ${result.status} ${new Date().toISOString()}`);
  if (result.status !== 'complete') process.exitCode = 2;
}

main().catch((e) => {
  console.error('[direct] FATAL', e && e.stack || e);
  try { writeAllowlist([], 'cleared after fatal'); } catch {}
  process.exit(1);
});
