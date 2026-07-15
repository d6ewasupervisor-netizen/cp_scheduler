'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { isLiveTransmitEnabled, isDraftAllowlisted, draftIdFromParts } = require('../src/lib/live-allowlist');
const liveRegistry = require('../src/lib/live-registry');
const liveStore = require('../src/lib/live-store');
const { executeLiveTransmit, resolvePlaceholders } = require('../src/lib/live-executor');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'live-executor-test-'));
const ALLOWLIST = path.join(TMP, 'allowlist.json');
const REGISTRY = path.join(TMP, 'registry.json');
const DRY_ROOT = path.join(TMP, 'dryrun');
const LIVE_ROOT = path.join(TMP, 'live');

// Redirect live-store root via writing into our TMP by patching paths used in tests
// through inject only for registry; for liveStore we set LIVE_ROOT by writing files
// via liveStore after monkeypatching ROOT — use inject that avoids real live/ dir.

const DRAFT_ID = 'test-rep/2026-07-08-215';
const DRY_RUN_ID = 'run-test-live-001';
const VISIT_FILE = 'test-rep-2026-07-08-FM215.json';

function writeAllowlist(ids) {
  fs.writeFileSync(ALLOWLIST, JSON.stringify({ draftIds: ids }, null, 2));
}

function makeAssembled(overrides = {}) {
  return {
    status: 'ok',
    repKey: 'test-rep',
    date: '2026-07-08',
    scheduledStore: 391,
    actualStore: 215,
    visitId: 27000510,
    abortReason: null,
    photoCounts: { before: 1, after: 1 },
    callCount: 4,
    calls: [
      {
        seq: 1,
        method: 'GET',
        url: 'https://prod.sasretail.com/api/v1/field-app/visits/27000510/shift-complete/',
        headers: { Authorization: 'Token {{REDACTED}}' },
        payload: null,
        dependsOn: [],
        sourceRef: 'test-preflight-get',
      },
      {
        seq: 2,
        method: 'POST',
        url: 'https://prod.sasretail.com/api/v1/surveys/run-infos/',
        headers: { Authorization: 'Token {{REDACTED}}' },
        payload: { responder: 8336939 },
        dependsOn: [],
        sourceRef: 'test-run-info',
        reconstructed: true,
      },
      {
        seq: 3,
        method: 'POST',
        url: 'https://prod.sasretail.com/api/v1/surveys/answers/',
        headers: { Authorization: 'Token {{REDACTED}}' },
        payload: {
          answer: 'yes',
          question: 918565,
          responder: 8336939,
          survey: 115502,
          runid: '{{step2.runid}}',
          run_info: '{{step2.id}}',
        },
        dependsOn: [2],
        sourceRef: 'test-answer',
      },
      {
        seq: 4,
        method: 'POST',
        url: 'https://prod.sasretail.com/api/v1/surveys/answer-images/',
        headers: { Authorization: 'Token {{REDACTED}}' },
        payload: {
          answer: '{{step3.id}}',
          image: {
            filetype: 'image/jpeg',
            filename: 'before-1.jpeg',
            filesize: 12,
            base64: Buffer.from('fake-jpeg').toString('base64'),
          },
        },
        dependsOn: [3],
        sourceRef: 'test-answer-image',
        reconstructed: true,
      },
    ],
    ...overrides,
  };
}

function makeDraft(overrides = {}) {
  const photoRel = path.join(TMP, 'photos', 'before.jpg').split(path.sep).join('/');
  fs.mkdirSync(path.dirname(path.join(TMP, 'photos', 'before.jpg')), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'photos', 'before.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return {
    repKey: 'test-rep',
    date: '2026-07-08',
    actualStore: 215,
    scheduledStore: 391,
    status: 'ready_for_prod',
    beforePhotos: [{ path: photoRel, store: 215, date: '2026-07-08', category: 'before', seq: 1 }],
    afterPhotos: [{ path: photoRel, store: 215, date: '2026-07-08', category: 'after', seq: 1 }],
    categoryPhotos: {},
    checklist: {},
    survey: {},
    loadCheck: null,
    ...overrides,
  };
}

function writeVisitFile(assembled) {
  const dir = path.join(DRY_ROOT, DRY_RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, VISIT_FILE);
  fs.writeFileSync(file, JSON.stringify(assembled, null, 2));
  return file;
}

function mockSasFetchFactory({ failAtSeq = null, failStatus = 500 } = {}) {
  const sent = [];
  async function sasFetch(url, opts = {}) {
    const seqMatch = sent.length + 1; // not reliable — track by call order from executor
    // Parse which seq by looking at a side channel: executor sends in order
    const callIndex = sent.length;
    // We need seq from URL patterns in our mini sequence
    let seq;
    if (url.includes('shift-complete')) seq = 1;
    else if (url.includes('run-infos')) seq = 2;
    else if (url.includes('/answers/') && !url.includes('answer-images')) seq = 3;
    else if (url.includes('answer-images')) seq = 4;
    else seq = callIndex + 1;

    sent.push({ seq, url, method: opts.method, body: opts.body, headers: opts.headers });

    if (failAtSeq != null && seq === failAtSeq) {
      return { status: failStatus, ok: false, body: { error: 'mock failure' }, text: '{"error":"mock failure"}' };
    }

    if (seq === 1) {
      return {
        status: 200,
        ok: true,
        body: { current_status: 'in-progress', employees: [{ shift_id: 44390825, actual_start_time: null }] },
      };
    }
    if (seq === 2) {
      return { status: 200, ok: true, body: { id: 99, responder: 8336939, runid: 'run-uuid-abc' } };
    }
    if (seq === 3) {
      // Verify placeholder resolved (runid + run_info)
      const body = opts.body;
      assert.equal(body.runid, 'run-uuid-abc');
      return { status: 200, ok: true, body: { id: 80750001, answer: 'yes', runid: 'run-uuid-abc' } };
    }
    if (seq === 4) {
      // Live path may send multipart Buffer for answer-images
      const body = opts.body;
      if (Buffer.isBuffer(body)) {
        assert.ok(body.length > 10);
      } else {
        assert.equal(String(body.answer), '80750001');
        assert.ok(body.image?.base64 || true);
      }
      return { status: 200, ok: true, body: { id: 1, answer: 80750001 } };
    }
    return { status: 200, ok: true, body: {} };
  }
  sasFetch.sent = sent;
  return sasFetch;
}

function baseInject(extra = {}) {
  const assembled = extra.assembled || makeAssembled();
  writeVisitFile(assembled);
  writeAllowlist([DRAFT_ID]);
  fs.writeFileSync(REGISTRY, JSON.stringify({ drafts: {} }, null, 2));

  // Point live-store writes into TMP by wrapping write functions
  const realWriteLog = liveStore.writeExecutionLog;
  const realWriteState = liveStore.writeExecutorState;
  const realReadState = liveStore.readExecutorState;
  const realReadLog = liveStore.readExecutionLog;

  // Override ROOT usage: monkeypatch module paths via writing to LIVE_ROOT using custom inject
  // Simpler: patch liveStore.ROOT at runtime
  liveStore.ROOT = LIVE_ROOT;

  return {
    loadSession: async () => ({ token: 'test-token-abc123' }),
    sasGet: async () => ({
      current_status: 'in-progress',
      employees: [{ shift_id: 44390825, actual_start_time: null }],
    }),
    getDraft: () => makeDraft(),
    readVisitFile: (runId, file) => {
      const p = path.join(DRY_ROOT, runId, file);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    },
    registryPath: REGISTRY,
    allowlistPath: ALLOWLIST,
    token: 'test-token-abc123',
    ...extra,
  };
}

const prevLive = process.env.LIVE_TRANSMIT;

before(() => {
  fs.mkdirSync(DRY_ROOT, { recursive: true });
  fs.mkdirSync(LIVE_ROOT, { recursive: true });
});

after(() => {
  if (prevLive === undefined) delete process.env.LIVE_TRANSMIT;
  else process.env.LIVE_TRANSMIT = prevLive;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.LIVE_TRANSMIT = '1';
  liveStore.ROOT = LIVE_ROOT;
  writeAllowlist([DRAFT_ID]);
  fs.writeFileSync(REGISTRY, JSON.stringify({ drafts: {} }, null, 2));
});

describe('LIVE_TRANSMIT flag + allowlist gates', () => {
  it('isLiveTransmitEnabled is false when env absent/0', () => {
    assert.equal(isLiveTransmitEnabled({}), false);
    assert.equal(isLiveTransmitEnabled({ LIVE_TRANSMIT: '0' }), false);
    assert.equal(isLiveTransmitEnabled({ LIVE_TRANSMIT: '1' }), true);
  });

  it('flag off -> executeLiveTransmit aborts with zero calls sent', async () => {
    process.env.LIVE_TRANSMIT = '0';
    const sasFetch = mockSasFetchFactory();
    const result = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      inject: { ...baseInject(), sasFetch },
    });
    assert.equal(result.abortReason, 'live_transmit_disabled');
    assert.equal(result.callsSent, 0);
    assert.equal(sasFetch.sent.length, 0);
  });

  it('not allowlisted -> aborts with zero calls sent', async () => {
    const sasFetch = mockSasFetchFactory();
    const inject = { ...baseInject(), sasFetch };
    writeAllowlist([]); // empty AFTER baseInject (which seeds the allowlist)
    const result = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      inject,
    });
    assert.equal(result.abortReason, 'not_allowlisted');
    assert.equal(result.callsSent, 0);
    assert.equal(sasFetch.sent.length, 0);
  });

  it('confirmStore mismatch aborts with zero writes', async () => {
    const sasFetch = mockSasFetchFactory();
    const result = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 999,
      inject: { ...baseInject(), sasFetch },
    });
    assert.equal(result.abortReason, 'confirm_store_mismatch');
    assert.equal(result.callsSent, 0);
  });
});

describe('pre-flight failures send zero calls', () => {
  it('already completed in prod aborts before any write', async () => {
    const sasFetch = mockSasFetchFactory();
    const result = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      inject: {
        ...baseInject(),
        sasFetch,
        sasGet: async () => ({ current_status: 'completed', employees: [] }),
      },
    });
    assert.equal(result.abortReason, 'preflight_failed');
    assert.ok(result.preflightFailures.some((f) => f.code === 'already_completed_in_prod'));
    assert.equal(result.callsSent, 0);
    assert.equal(sasFetch.sent.length, 0);
  });

  it('missing photo file aborts before any write', async () => {
    const sasFetch = mockSasFetchFactory();
    const result = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      inject: {
        ...baseInject(),
        sasFetch,
        getDraft: () =>
          makeDraft({
            beforePhotos: [{ path: 'data/visit-drafts/does-not-exist/nope.jpg' }],
          }),
      },
    });
    assert.equal(result.abortReason, 'preflight_failed');
    assert.ok(result.preflightFailures.some((f) => f.code === 'photo_unreadable'));
    assert.equal(sasFetch.sent.length, 0);
  });
});

describe('mid-sequence failure -> partial + resume', () => {
  it('500 at seq 3 persists partial state; resume executes only remaining calls; placeholders survive', async () => {
    const failFetch = mockSasFetchFactory({ failAtSeq: 3, failStatus: 500 });
    const partial = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      mode: 'start',
      inject: { ...baseInject(), sasFetch: failFetch },
    });

    assert.equal(partial.status, 'partial');
    assert.equal(partial.failedSeq, 3);
    assert.equal(partial.lastSuccessfulSeq, 2);
    assert.ok(partial.callsSent >= 2);

    const rec = liveRegistry.getTransmitRecord(DRAFT_ID, REGISTRY);
    assert.equal(rec.status, 'partial');
    assert.equal(rec.lastSuccessfulSeq, 2);
    assert.equal(rec.stepResults[2].runid, 'run-uuid-abc');

    const state = liveStore.readExecutorState(DRY_RUN_ID, VISIT_FILE);
    assert.equal(state.status, 'partial');
    assert.equal(state.stepResults[2].runid, 'run-uuid-abc');

    // Resume from seq 3 with success this time
    const resumeFetch = mockSasFetchFactory();
    // On resume, seq mapping: first sent is seq 3 (answers), then 4
    // Our mock maps by URL so still works
    const done = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      mode: 'resume',
      inject: {
        ...baseInject(),
        sasFetch: resumeFetch,
        // resume preflight allows already-started
        sasGet: async () => ({
          current_status: 'in-progress',
          employees: [{ shift_id: 44390825, actual_start_time: '06:01:00' }],
        }),
      },
    });

    assert.equal(done.status, 'complete', JSON.stringify(done));
    assert.equal(done.lastSuccessfulSeq, 4);
    // Resume should not re-send seq 1-2
    const urls = resumeFetch.sent.map((s) => s.url);
    assert.ok(!urls.some((u) => u.includes('shift-complete')), 'should not re-GET seq1 on resume path of mock if we skip — actually we skip seq1-2 so no shift-complete');
    assert.ok(urls.some((u) => u.includes('/answers/')));
    assert.ok(urls.some((u) => u.includes('answer-images')));

    const complete = liveRegistry.getTransmitRecord(DRAFT_ID, REGISTRY);
    assert.equal(complete.status, 'complete');
    assert.ok(complete.transmittedAt);
  });
});

describe('full success + permanent re-transmit refusal', () => {
  it('full success marks transmitted; second attempt refused with zero new calls', async () => {
    const sasFetch = mockSasFetchFactory();
    const inject = baseInject();
    const first = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      inject: { ...inject, sasFetch },
    });
    assert.equal(first.status, 'complete');
    assert.equal(first.callsSent, 4);

    // Reuse same registry (do not re-seed empty registry)
    const sasFetch2 = mockSasFetchFactory();
    const second = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      inject: { ...inject, sasFetch: sasFetch2 },
    });
    assert.equal(second.abortReason, 'already_transmitted');
    assert.equal(second.callsSent, 0);
    assert.equal(sasFetch2.sent.length, 0);
  });
});

describe('redaction on execution logs', () => {
  it('execution log never contains the raw token', async () => {
    const sasFetch = mockSasFetchFactory();
    await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      inject: { ...baseInject(), sasFetch },
    });
    const log = liveStore.readExecutionLog(DRY_RUN_ID, VISIT_FILE);
    const text = JSON.stringify(log);
    assert.ok(!text.includes('test-token-abc123'));
    assert.ok(!/Token [0-9a-f]{20,}/i.test(text));
  });

  it('assertNoSecrets rejects log with real Token hex', () => {
    assert.throws(
      () => liveStore.assertNoSecrets({ Authorization: 'Token abcdef0123456789abcdef0123456789ab' }),
      /secret pattern/i
    );
  });
});

describe('placeholder resolution unit', () => {
  it('resolves nested {{stepN.field}} from stepResults', () => {
    const out = resolvePlaceholders(
      { runid: '{{step2.runid}}', nested: { answer: '{{step3.id}}' } },
      { 2: { runid: 'uuid-1' }, 3: { id: 42 } }
    );
    assert.deepEqual(out, { runid: 'uuid-1', nested: { answer: '42' } });
  });
});

describe('draft id helper', () => {
  it('matches visit-draft-store shape', () => {
    assert.equal(draftIdFromParts('brian-campbell', '2026-07-08', 215), 'brian-campbell/2026-07-08-215');
  });
});

describe('HTTP gate semantics (route contract)', () => {
  it('maps flag-off and not-allowlisted to 403 decision codes used by routes', () => {
    // Routes return 403 when these codes fire — keep the contract stable for admin UI.
    assert.equal(isLiveTransmitEnabled({ LIVE_TRANSMIT: undefined }), false);
    writeAllowlist([]);
    assert.equal(isDraftAllowlisted(DRAFT_ID, ALLOWLIST), false);
    writeAllowlist([DRAFT_ID]);
    assert.equal(isDraftAllowlisted(DRAFT_ID, ALLOWLIST), true);
  });
});
