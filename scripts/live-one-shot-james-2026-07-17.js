#!/usr/bin/env node
'use strict';

/**
 * One-shot dry-run + LIVE transmit for James Duchene 2026-07-17 (store 53, decoded
 * from placeholder 391). Run ON the production container:
 *
 *   LIVE_TRANSMIT=1 node scripts/live-one-shot-james-2026-07-17.js
 *   LIVE_TRANSMIT=1 node scripts/live-one-shot-james-2026-07-17.js --dry-only
 *
 * Scoped: sets LIVE_TRANSMIT for this process only, writes a one-draft allowlist,
 * transmits with two-tap confirm (store 53), and clears the allowlist after.
 * Mirrors live-one-shot-james-fm53.js (the proven 2026-07-15 path).
 */

process.env.LIVE_TRANSMIT = '1';

const fs = require('fs');
const path = require('path');

const { runDryRun } = require('../src/lib/dryrun-runner');
const { executeLiveTransmit } = require('../src/lib/live-executor');
const { ALLOWLIST_PATH } = require('../src/lib/live-allowlist');

const DRAFT_ID = 'james-duchene/2026-07-17-53';
const CONFIRM_STORE = 53;

async function main() {
  const dryOnly = process.argv.includes('--dry-only');

  fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
  fs.writeFileSync(
    ALLOWLIST_PATH,
    JSON.stringify(
      { notes: 'One-shot James 2026-07-17 live T&E — clear after session', draftIds: [DRAFT_ID] },
      null,
      2
    )
  );
  console.log('[one-shot] allowlist written:', DRAFT_ID);
  console.log('[one-shot] LIVE_TRANSMIT=', process.env.LIVE_TRANSMIT);

  console.log('[one-shot] running dry-run…');
  const manifest = await runDryRun({
    startDate: '2026-07-17',
    endDate: '2026-07-17',
    weekStart: '2026-07-12',
    supervisorId: 800175315,
    repKeys: ['james-duchene'],
    transmitOpts: {
      timeChangeComment: 'Entered from Stage 3 sealed record — James Duchene 2026-07-17',
    },
  });

  console.log(
    JSON.stringify(
      { runId: manifest.runId, visits: manifest.visits, aborted: manifest.aborted, summary: manifest.summary },
      null,
      2
    )
  );

  const visit = (manifest.visits || []).find(
    (v) => v.repKey === 'james-duchene' && v.date === '2026-07-17' && Number(v.store) === 53
  );
  if (!visit) {
    throw new Error(
      'Dry-run did not assemble james-duchene 2026-07-17 store 53: ' + JSON.stringify(manifest.aborted || [])
    );
  }

  if (dryOnly) {
    console.log('[one-shot] --dry-only: stopping before LIVE transmit');
    fs.writeFileSync(
      ALLOWLIST_PATH,
      JSON.stringify({ notes: 'cleared after dry-only', draftIds: [] }, null, 2)
    );
    return;
  }

  console.log('[one-shot] LIVE transmit starting…', {
    dryRunId: manifest.runId,
    visitFile: visit.file,
    visitId: visit.visitId,
    callCount: visit.callCount,
  });

  const result = await executeLiveTransmit({
    dryRunId: manifest.runId,
    visitFile: visit.file,
    draftId: DRAFT_ID,
    confirmStore: CONFIRM_STORE,
    mode: 'start',
    testMode: false,
  });

  console.log(
    '[one-shot] RESULT',
    JSON.stringify(
      {
        status: result.status,
        abortReason: result.abortReason,
        visitId: result.visitId,
        draftId: result.draftId,
        lastSuccessfulSeq: result.lastSuccessfulSeq,
        failedSeq: result.failedSeq,
        callsSent: result.callsSent,
        transmittedAt: result.transmittedAt,
        photoDelivery: result.photoDelivery,
        preflight: result.preflight,
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    ALLOWLIST_PATH,
    JSON.stringify(
      { notes: `cleared after one-shot ${result.status} ${new Date().toISOString()}`, draftIds: [] },
      null,
      2
    )
  );
  console.log('[one-shot] allowlist cleared');

  if (result.status !== 'complete') {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('[one-shot] FATAL', err);
  try {
    fs.writeFileSync(
      ALLOWLIST_PATH,
      JSON.stringify({ notes: 'cleared after one-shot fatal', draftIds: [] }, null, 2)
    );
  } catch {
    /* ignore */
  }
  process.exit(1);
});
