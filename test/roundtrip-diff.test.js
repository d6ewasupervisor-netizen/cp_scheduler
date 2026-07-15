'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { validateGoldenExport } = require('../src/lib/golden-export');
const {
  leafDiffs,
  classifyDiff,
  expectedHintsFromTransmitted,
  diffExports,
  formatRoundtripReport,
} = require('../src/lib/roundtrip-diff');
const { appendRecompleteCall, executeLiveTransmit } = require('../src/lib/live-executor');
const liveStore = require('../src/lib/live-store');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtrip-test-'));
const GOLDEN = path.join(TMP, 'visit-golden');
const POST = path.join(TMP, 'visit-post');
const ALLOWLIST = path.join(TMP, 'allowlist.json');
const REGISTRY = path.join(TMP, 'registry.json');
const DRY_ROOT = path.join(TMP, 'dryrun');
const LIVE_ROOT = path.join(TMP, 'live');
const DRY_RUN_ID = 'run-roundtrip-001';
const VISIT_FILE = 'test-rep-2026-07-08-FM215.json';
const DRAFT_ID = 'test-rep/2026-07-08-215';

function writeExport(root, { allChecksPassed = true, shiftStart = '06:01:00', extra = {} } = {}) {
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(root, 'photos', 'category-reset-1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'photos', 'category-reset-1', 'before-01.jpg'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(root, 'photos', 'category-reset-1', 'after-01.jpg'), Buffer.from([4, 5, 6]));
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify(
      {
        visitId: 26822165,
        allChecksPassed,
        identity: { store: '391', date: '2026-07-13' },
        checks: [{ id: 'store', pass: true }],
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(root, 'raw', '10-field-app-shift-v2.json'),
    JSON.stringify(
      {
        _meta: { path: '/api/v2/field-app/shifts/1/' },
        data: {
          actual_start_time: shiftStart,
          actual_end_time: '11:01:00',
          time_change_reason: 5,
          time_change_comment: 'test',
          travel_records: [{ distance: '3.60', end_time: '2026-07-08T13:01:00Z' }],
          total_work_time: '5h 00m',
          store_timezone: 'America/Los_Angeles',
          ...extra.shift,
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(root, 'raw', '08-surveys.json'),
    JSON.stringify(
      {
        _meta: {},
        data: [
          {
            id: 115502,
            name: 'Central Pet Service Survey',
            questions_details: [
              { number: 1, answer: 'yes', answer_images: [{ url: 'https://djttbrw0ufia8.cloudfront.net/a.jpg', id: 1 }] },
              { number: 2, answer: 'Yes' },
            ],
          },
        ],
      },
      null,
      2
    )
  );
}

const prevLive = process.env.LIVE_TRANSMIT;

before(() => {
  writeExport(GOLDEN, { shiftStart: '06:01:00' });
  writeExport(POST, {
    shiftStart: '06:05:00',
    extra: { shift: { rogue_field: 'should-flag' } },
  });
  // Unexpected: post has rogue_field not in golden; expected: actual_start_time change
  liveStore.ROOT = LIVE_ROOT;
  process.env.LIVE_TRANSMIT = '1';
});

after(() => {
  if (prevLive === undefined) delete process.env.LIVE_TRANSMIT;
  else process.env.LIVE_TRANSMIT = prevLive;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('validateGoldenExport', () => {
  it('accepts a complete allChecksPassed export folder', () => {
    const v = validateGoldenExport(GOLDEN);
    assert.equal(v.ok, true);
    assert.equal(v.manifest.visitId, 26822165);
  });

  it('refuses arm without golden export / allChecksPassed', () => {
    const bad = path.join(TMP, 'bad-export');
    fs.mkdirSync(path.join(bad, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(bad, 'photos'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'raw', 'x.json'), '{}');
    fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({ visitId: 1, allChecksPassed: false }));
    const v = validateGoldenExport(bad);
    assert.equal(v.ok, false);
    assert.ok(v.failures.some((f) => /allChecksPassed/i.test(f)));
  });

  it('refuses missing path', () => {
    const v = validateGoldenExport(path.join(TMP, 'nope'));
    assert.equal(v.ok, false);
  });
});

describe('diff classification expected vs unexpected', () => {
  it('classifies transmitted time fields as EXPECTED and unknown fields as UNEXPECTED', () => {
    const calls = [
      {
        method: 'PATCH',
        url: 'https://prod.sasretail.com/api/v2/field-app/shifts/1/',
        payload: { actual_start_time: '06:05:00', time_change_reason: 5 },
      },
    ];
    const hints = expectedHintsFromTransmitted(calls);
    assert.equal(classifyDiff({ path: '10.json.actual_start_time', kind: 'value' }, hints), 'EXPECTED');
    assert.equal(classifyDiff({ path: '10.json.rogue_field', kind: 'added' }, hints), 'UNEXPECTED');
  });

  it('diffExports reports PASS only when no unexpected leaves', () => {
    // Two identical exports
    const a = path.join(TMP, 'same-a');
    const b = path.join(TMP, 'same-b');
    writeExport(a, { shiftStart: '06:01:00' });
    writeExport(b, { shiftStart: '06:01:00' });
    // photo bytes differ but counts match
    fs.writeFileSync(path.join(b, 'photos', 'category-reset-1', 'before-01.jpg'), Buffer.from([9, 9, 9]));
    const d = diffExports(a, b, {
      transmittedCalls: [
        { method: 'PATCH', url: '.../shifts/1/', payload: { actual_start_time: '06:01:00' } },
      ],
    });
    assert.equal(d.verdict, 'PASS', JSON.stringify(d.unexpected, null, 2));
  });

  it('flags unexpected added fields as FAIL', () => {
    const d = diffExports(GOLDEN, POST, {
      transmittedCalls: [
        {
          method: 'PATCH',
          url: 'https://prod.sasretail.com/api/v2/field-app/shifts/1/',
          payload: { actual_start_time: '06:05:00' },
        },
      ],
    });
    assert.equal(d.verdict, 'FAIL');
    assert.ok(d.expected.some((x) => /actual_start_time/.test(x.path)));
    assert.ok(d.unexpected.some((x) => /rogue_field/.test(x.path)));
  });

  it('formatRoundtripReport includes verdict', () => {
    const d = diffExports(GOLDEN, POST, { transmittedCalls: [] });
    const md = formatRoundtripReport(d, { dryRunId: 'run-x', visitId: 1 });
    assert.match(md, /Verdict/);
    assert.match(md, /Unexpected diffs/);
  });
});

describe('recomplete auto-append', () => {
  it('appendRecompleteCall adds POST …/recomplete/ (not PUT shift-complete) as final seq', () => {
    const calls = [
      { seq: 1, method: 'GET', url: 'https://prod.sasretail.com/api/v1/field-app/visits/1/shift-complete/' },
      { seq: 39, method: 'PATCH', url: 'https://prod.sasretail.com/api/v1/field-app/visits/1/shift-complete/', payload: null },
    ];
    const out = appendRecompleteCall(calls, 26822165);
    assert.equal(out.length, 3);
    const last = out[out.length - 1];
    assert.equal(last.method, 'POST');
    assert.match(last.url, /\/field-app\/visits\/26822165\/recomplete\/$/);
    assert.ok(!/shift-complete/.test(last.url), 'must not use PUT shift-complete for re-close');
    assert.deepEqual(last.payload, {});
    assert.equal(last.testModeAppended, true);
    assert.equal(last.seq, 40);
    assert.match(last.sourceRef, /recomplete/);
    assert.match(last.sourceRef, /har-evidence-recomplete|486_2\.har/i);
  });
});

describe('testMode arming requires golden export', () => {
  function makeAssembled() {
    return {
      status: 'ok',
      repKey: 'test-rep',
      date: '2026-07-08',
      actualStore: 215,
      visitId: 26822165,
      calls: [
        {
          seq: 1,
          method: 'GET',
          url: 'https://prod.sasretail.com/api/v1/field-app/visits/26822165/shift-complete/',
          payload: null,
          dependsOn: [],
          sourceRef: 't',
        },
        {
          seq: 2,
          method: 'PUT',
          url: 'https://prod.sasretail.com/api/v1/field-app/visits/26822165/shift-complete/',
          payload: {},
          dependsOn: [],
          sourceRef: 'complete',
        },
      ],
    };
  }

  function injectBase(sasFetch) {
    fs.mkdirSync(path.join(DRY_ROOT, DRY_RUN_ID), { recursive: true });
    fs.writeFileSync(path.join(DRY_ROOT, DRY_RUN_ID, VISIT_FILE), JSON.stringify(makeAssembled(), null, 2));
    fs.writeFileSync(ALLOWLIST, JSON.stringify({ draftIds: [DRAFT_ID] }));
    fs.writeFileSync(REGISTRY, JSON.stringify({ drafts: {} }));
    const photo = path.join(TMP, 'p.jpg');
    fs.writeFileSync(photo, Buffer.from([0xff, 0xd8]));
    liveStore.ROOT = LIVE_ROOT;
    return {
      sasFetch,
      loadSession: async () => ({ token: 'tok' }),
      token: 'tok',
      sasGet: async () => ({ current_status: 'completed', employees: [{ actual_start_time: '06:00:00' }] }),
      getDraft: () => ({
        repKey: 'test-rep',
        date: '2026-07-08',
        actualStore: 215,
        status: 'ready_for_prod',
        beforePhotos: [{ path: photo }],
        afterPhotos: [{ path: photo }],
        categoryPhotos: {},
        checklist: {},
      }),
      readVisitFile: (runId, file) =>
        JSON.parse(fs.readFileSync(path.join(DRY_ROOT, runId, file), 'utf8')),
      registryPath: REGISTRY,
      allowlistPath: ALLOWLIST,
    };
  }

  it('refuses testMode without golden export (zero calls)', async () => {
    process.env.LIVE_TRANSMIT = '1';
    const sent = [];
    const result = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      testMode: true,
      goldenExportPath: null,
      inject: injectBase(async () => {
        sent.push(1);
        return { status: 200, ok: true, body: {} };
      }),
    });
    assert.equal(result.abortReason, 'golden_export_required');
    assert.equal(result.callsSent, 0);
    assert.equal(sent.length, 0);
  });

  it('testMode with golden runs sequence, appends recomplete, bypasses completed check', async () => {
    process.env.LIVE_TRANSMIT = '1';
    const sent = [];
    const result = await executeLiveTransmit({
      dryRunId: DRY_RUN_ID,
      visitFile: VISIT_FILE,
      confirmStore: 215,
      testMode: true,
      goldenExportPath: GOLDEN,
      inject: injectBase(async (url, opts) => {
        sent.push({ url, method: opts.method });
        return { status: 200, ok: true, body: { ok: true } };
      }),
    });
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.recompleteAppended, true);
    assert.ok(result.nextStep?.action === 're_export_then_diff');
    // 2 assembled + 1 recomplete append
    assert.equal(sent.length, 3);
    assert.equal(sent[2].method, 'POST');
    assert.match(sent[2].url, /\/recomplete\/$/);
    assert.ok(!/shift-complete/.test(sent[2].url));
  });
});

describe('leafDiffs unit', () => {
  it('detects nested value changes', () => {
    const d = leafDiffs({ a: { b: 1 } }, { a: { b: 2 } });
    assert.equal(d.length, 1);
    assert.equal(d[0].path, 'a.b');
  });
});
