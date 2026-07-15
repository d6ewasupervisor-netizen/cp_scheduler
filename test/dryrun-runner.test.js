'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runDryRun } = require('../src/lib/dryrun-runner');
const dryrunStore = require('../src/lib/dryrun-store');

const TEST_RUN_IDS = [];

function makeSummary(overrides = {}) {
  return {
    id: 'brian-campbell_2026-07-08_215',
    repKey: 'brian-campbell',
    date: '2026-07-08',
    actualStore: 215,
    scheduledStore: 391,
    status: 'ready_for_prod',
    ...overrides,
  };
}

function makeMatchResult({ matched = [], ambiguous = [], unmatched = [] } = {}) {
  return { matched, ambiguous, unmatched, orphaned: [], summary: {} };
}

function stubTransmitOk(seqLen = 3) {
  return async ({ sealedRecord }) => ({
    status: 'ok',
    repKey: sealedRecord.repKey,
    date: sealedRecord.date,
    visitId: 27000510,
    calls: Array.from({ length: seqLen }, (_, i) => ({
      seq: i + 1,
      method: 'GET',
      url: 'https://prod.sasretail.com/api/v1/x/',
      headers: { Authorization: 'Token {{REDACTED}}' },
      payload: null,
      dependsOn: [],
      sourceRef: 'fixture',
    })),
    photoCounts: { before: 1, after: 1 },
    callCount: seqLen,
  });
}

after(() => {
  for (const runId of TEST_RUN_IDS) {
    const dir = dryrunStore.runDir(runId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function trackRun(runId) {
  TEST_RUN_IDS.push(runId);
  return runId;
}

describe('runDryRun — matcher gate + sealed-only (Part C)', () => {
  it('assembles only sealed (ready_for_prod) + uniquely-matched visits, excludes the rest with reasons', async () => {
    const runId = trackRun('test-run-gate-1');
    const summaries = [
      makeSummary({ id: 'a', repKey: 'brian-campbell', actualStore: 215, status: 'ready_for_prod' }),
      makeSummary({ id: 'b', repKey: 'james-duchene', actualStore: 19, status: 'in_progress' }), // not sealed
      makeSummary({ id: 'c', repKey: 'unmatched-rep', actualStore: 28, status: 'ready_for_prod' }), // no match
      makeSummary({ id: 'd', repKey: 'ambiguous-rep', actualStore: 53, status: 'ready_for_prod' }), // ambiguous
    ];
    const matchResult = makeMatchResult({
      matched: [
        {
          status: 'matched',
          appShift: { id: 'x1', repKey: 'brian-campbell', date: '2026-07-08', actualStore: 215 },
          prodVisit: { visitId: 27000510, shiftId: 44390825 },
        },
      ],
      ambiguous: [
        {
          status: 'ambiguous',
          appShift: { id: 'x2', repKey: 'ambiguous-rep', date: '2026-07-08', actualStore: 53 },
          candidates: [],
        },
      ],
      unmatched: [
        {
          status: 'unmatched',
          appShift: { id: 'x3', repKey: 'unmatched-rep', date: '2026-07-08', actualStore: 28 },
        },
      ],
    });

    const manifest = await runDryRun({
      startDate: '2026-07-06',
      endDate: '2026-07-12',
      supervisorId: '999',
      runId,
      listAllDraftsFn: () => summaries,
      getDraftFn: (repKey, date, store) => ({ repKey, date, actualStore: store, status: 'ready_for_prod' }),
      matchVisitsFn: async () => matchResult,
      transmitVisitFn: stubTransmitOk(),
    });

    assert.equal(manifest.summary.eligible, 3); // 'b' filtered before matching (not sealed)
    assert.equal(manifest.summary.assembled, 1);
    assert.equal(manifest.summary.aborted, 2);
    assert.equal(manifest.visits.length, 1);
    assert.equal(manifest.visits[0].repKey, 'brian-campbell');

    const abortedReasons = manifest.aborted.map((a) => a.reason).sort();
    assert.deepEqual(abortedReasons, ['ambiguous', 'unmatched']);
  });

  it('excludes drafts outside ready_for_prod before matching is even attempted', async () => {
    const runId = trackRun('test-run-gate-2');
    const summaries = [makeSummary({ status: 'in_progress' }), makeSummary({ status: 'sealed_pending' })];
    let matchCalled = false;
    const manifest = await runDryRun({
      startDate: '2026-07-06',
      endDate: '2026-07-12',
      supervisorId: '999',
      runId,
      listAllDraftsFn: () => summaries,
      getDraftFn: () => ({ status: 'ready_for_prod' }),
      matchVisitsFn: async () => {
        matchCalled = true;
        return makeMatchResult();
      },
      transmitVisitFn: stubTransmitOk(),
    });
    assert.equal(manifest.summary.eligible, 0);
    assert.equal(manifest.visits.length, 0);
    assert.ok(matchCalled, 'matchVisits still runs even with zero eligible drafts (read-only, harmless)');
  });

  it('propagates transmitVisit abort reasons (e.g. idempotency refusals) into the manifest', async () => {
    const runId = trackRun('test-run-gate-3');
    const summaries = [makeSummary()];
    const matchResult = makeMatchResult({
      matched: [
        {
          status: 'matched',
          appShift: { id: 'x1', repKey: 'brian-campbell', date: '2026-07-08', actualStore: 215 },
          prodVisit: { visitId: 27000510, shiftId: 44390825 },
        },
      ],
    });
    const manifest = await runDryRun({
      startDate: '2026-07-06',
      endDate: '2026-07-12',
      supervisorId: '999',
      runId,
      listAllDraftsFn: () => summaries,
      getDraftFn: () => ({ status: 'ready_for_prod' }),
      matchVisitsFn: async () => matchResult,
      transmitVisitFn: async () => ({ status: 'aborted', abortReason: 'already_completed_in_prod' }),
    });
    assert.equal(manifest.visits.length, 0);
    assert.equal(manifest.aborted[0].reason, 'already_completed_in_prod');
  });
});

describe('runDryRun — output files (Part B)', () => {
  it('writes a per-visit file and a manifest with per-visit call counts + photo counts', async () => {
    const runId = trackRun('test-run-output-1');
    const summaries = [makeSummary()];
    const matchResult = makeMatchResult({
      matched: [
        {
          status: 'matched',
          appShift: { id: 'x1', repKey: 'brian-campbell', date: '2026-07-08', actualStore: 215 },
          prodVisit: { visitId: 27000510, shiftId: 44390825 },
        },
      ],
    });

    const manifest = await runDryRun({
      startDate: '2026-07-06',
      endDate: '2026-07-12',
      supervisorId: '999',
      runId,
      listAllDraftsFn: () => summaries,
      getDraftFn: () => ({ repKey: 'brian-campbell', date: '2026-07-08', actualStore: 215, status: 'ready_for_prod' }),
      matchVisitsFn: async () => matchResult,
      transmitVisitFn: stubTransmitOk(5),
    });

    assert.equal(manifest.visits[0].callCount, 5);
    assert.deepEqual(manifest.visits[0].photoCounts, { before: 1, after: 1 });

    const dir = dryrunStore.runDir(runId);
    const files = fs.readdirSync(dir);
    assert.ok(files.includes('manifest.json'));
    assert.ok(files.some((f) => f.includes('brian-campbell') && f.includes('2026-07-08') && f.includes('FM215')));

    const readBack = dryrunStore.readManifest(runId);
    assert.equal(readBack.runId, runId);
    assert.equal(readBack.visits.length, 1);
  });
});

describe('dryrun-store — redaction', () => {
  it('never allows a real-looking token/session cookie into a written dry-run file', () => {
    const runId = trackRun('test-run-redact-1');
    assert.throws(() => {
      dryrunStore.writeVisitFile(runId, {
        repKey: 'x',
        date: '2026-07-08',
        store: 215,
        assembled: { calls: [{ headers: { Authorization: 'Token abcdef0123456789abcdef0123456789' } }] },
      });
    }, /Refusing to write dry-run output/);
  });

  it('allows the {{REDACTED}} placeholder through untouched', () => {
    const runId = trackRun('test-run-redact-2');
    const file = dryrunStore.writeVisitFile(runId, {
      repKey: 'x',
      date: '2026-07-08',
      store: 215,
      assembled: { calls: [{ headers: { Authorization: 'Token {{REDACTED}}' } }] },
    });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('{{REDACTED}}'));
  });
});
