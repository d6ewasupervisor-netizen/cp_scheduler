'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pd = require('../src/lib/photo-delivery');
const visitDraftStore = require('../src/lib/visit-draft-store');

const REP = 'test-photo-delivery-rep';
const DATE = '2026-07-13';
const STORE = 53;

function cleanup() {
  const dir = path.join(visitDraftStore.ROOT, REP);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('photo-delivery subject/filename contract', () => {
  it('pads store to 3 digits (FM053, FM111)', () => {
    assert.equal(pd.padStore(53), '053');
    assert.equal(pd.padStore(111), '111');
    assert.equal(pd.padStore('FM19'), '019');
  });

  it('maps internal category ids to canonical slugs', () => {
    assert.equal(pd.canonicalCategory('wing-panels'), 'wingpanels');
    assert.equal(pd.canonicalCategory('cat-litter-pan-liners'), 'litterliners');
    assert.equal(pd.canonicalCategory('butcher-block-rack'), 'butcherblock');
    assert.equal(pd.canonicalCategory('cp-serviced-section'), 'section');
    assert.equal(pd.canonicalCategory('survey-q3'), 'survey-q3');
  });

  it('builds canonical filename and legacy + batch subjects', () => {
    const filename = pd.buildCanonicalFilename({
      store: 53,
      date: '2026-07-13',
      category: 'endcaps',
      seq: 1,
    });
    assert.equal(filename, 'FM053_2026-07-13_endcaps_1.jpg');
    const legacy = pd.buildSubject({ store: 53, date: '2026-07-13', filename });
    assert.equal(legacy, '[Central Pet Shift] FM053 2026-07-13 FM053_2026-07-13_endcaps_1.jpg');
    const batch = pd.buildBatchSubject({
      store: 53,
      date: '2026-07-13',
      batchIndex: 1,
      batchTotal: 2,
      count: 12,
    });
    assert.equal(batch, '[Central Pet Shift] FM053 2026-07-13 batch 1/2 (12 photos)');
  });

  it('parseSubject accepts legacy and batch forms', () => {
    const legacy = pd.parseSubject(
      '[Central Pet Shift] FM053 2026-07-13 FM053_2026-07-13_endcaps_1.jpg'
    );
    assert.equal(legacy.kind, 'legacy');
    assert.equal(legacy.store, '053');
    assert.equal(legacy.filename, 'FM053_2026-07-13_endcaps_1.jpg');

    const batch = pd.parseSubject('[Central Pet Shift] FM111 2026-07-14 batch 2/3 (8 photos)');
    assert.equal(batch.kind, 'batch');
    assert.equal(batch.store, '111');
    assert.equal(batch.date, '2026-07-14');
    assert.equal(batch.batchIndex, 2);
    assert.equal(batch.batchTotal, 3);
    assert.equal(batch.photoCount, 8);
  });

  it('round-trips filename parse (byte-identical store/date/category/seq)', () => {
    const cases = [
      { store: 53, date: '2026-07-13', category: 'before', seq: 1 },
      { store: 111, date: '2026-07-08', category: 'wing-panels', seq: 2 },
      { store: 19, date: '2026-06-01', category: 'survey-q12', seq: 1 },
      { store: 215, date: '2026-07-14', category: 'litterliners', seq: 3 },
    ];
    for (const c of cases) {
      const filename = pd.buildCanonicalFilename(c);
      const parsedFile = pd.parseFilename(filename);
      const wantStore = pd.padStore(c.store);
      const wantCat = pd.canonicalCategory(c.category);
      assert.equal(parsedFile.store, wantStore);
      assert.equal(parsedFile.date, c.date);
      assert.equal(parsedFile.category, wantCat);
      assert.equal(parsedFile.seq, c.seq);
    }
  });
});

describe('photo-delivery batch packing', () => {
  it('respects budget and never splits a photo', () => {
    const photos = [
      { key: 'a', byteSize: 4 },
      { key: 'b', byteSize: 4 },
      { key: 'c', byteSize: 4 },
      { key: 'd', byteSize: 3 },
    ];
    const batches = pd.packPhotoBatches(photos, 10);
    assert.equal(batches.length, 2);
    assert.deepEqual(
      batches[0].map((p) => p.key),
      ['a', 'b']
    );
    assert.deepEqual(
      batches[1].map((p) => p.key),
      ['c', 'd']
    );
    assert.equal(batches[0].reduce((s, p) => s + p.byteSize, 0), 8);
    assert.equal(batches[1].reduce((s, p) => s + p.byteSize, 0), 7);
  });

  it('oversized photo gets its own batch and warning', () => {
    const warnings = [];
    const photos = [
      { key: 'small', byteSize: 2 },
      { key: 'huge', byteSize: 100, filename: 'huge.jpg' },
      { key: 'tail', byteSize: 2 },
    ];
    const batches = pd.packPhotoBatches(photos, 10, { warnings });
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.map((b) => b.map((p) => p.key)),
      [['small'], ['huge'], ['tail']]
    );
    assert.ok(warnings.some((w) => /huge/.test(w)));
  });

  it('assigns correct n/total via buildBatchSubject', () => {
    const photos = Array.from({ length: 5 }, (_, i) => ({
      key: `p${i}`,
      byteSize: 3,
    }));
    const batches = pd.packPhotoBatches(photos, 10);
    assert.equal(batches.length, 2);
    assert.equal(
      pd.buildBatchSubject({
        store: 53,
        date: '2026-07-13',
        batchIndex: 1,
        batchTotal: batches.length,
        count: batches[0].length,
      }),
      '[Central Pet Shift] FM053 2026-07-13 batch 1/2 (3 photos)'
    );
    assert.equal(
      pd.buildBatchSubject({
        store: 53,
        date: '2026-07-13',
        batchIndex: 2,
        batchTotal: batches.length,
        count: batches[1].length,
      }),
      '[Central Pet Shift] FM053 2026-07-13 batch 2/2 (2 photos)'
    );
  });
});

describe('photo-delivery collect + delivery state', () => {
  let photoDir;
  let beforePath;
  let afterPath;
  let endcapPath;

  before(() => {
    cleanup();
    photoDir = path.join(visitDraftStore.ROOT, REP, `${DATE}-${STORE}-photos`);
    fs.mkdirSync(photoDir, { recursive: true });
    beforePath = path.join(photoDir, 'before-1.jpg');
    afterPath = path.join(photoDir, 'after-1.jpg');
    endcapPath = path.join(photoDir, 'endcaps-1.jpg');
    fs.writeFileSync(beforePath, Buffer.alloc(100, 0x11));
    fs.writeFileSync(afterPath, Buffer.alloc(100, 0x22));
    fs.writeFileSync(endcapPath, Buffer.alloc(100, 0x33));

    visitDraftStore.startVisit({
      repKey: REP,
      date: DATE,
      actualStore: STORE,
      scheduledStore: 391,
      workLoad: false,
      writeOrder: false,
    });
    const rel = (p) => path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/');
    visitDraftStore.recordBeforePhoto(REP, DATE, STORE, { photoPath: rel(beforePath) });
    visitDraftStore.recordAfterPhoto(REP, DATE, STORE, { photoPath: rel(afterPath) });
    visitDraftStore.recordCategoryPhoto(REP, DATE, STORE, 'endcaps', {
      photoPath: rel(endcapPath),
    });
  });

  after(() => cleanup());

  it('collectVisitPhotos builds inventory with decoded store', () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
    const photos = pd.collectVisitPhotos(draft);
    assert.equal(photos.length, 3);
    assert.equal(photos[0].store, '053');
    assert.equal(photos[0].filename, 'FM053_2026-07-13_before_1.jpg');
    assert.equal(photos[1].category, 'after');
    assert.equal(photos[2].category, 'endcaps');
  });

  it('gated off marks non-sent as skipped (does not call Resend)', async () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
    let sendCalls = 0;
    const fakeResend = {
      emails: {
        send: async () => {
          sendCalls += 1;
          return { data: { id: 'x' }, error: null };
        },
      },
    };
    const result = await pd.deliverVisitPhotos({
      draft,
      forceEnabled: false,
      resendClient: fakeResend,
    });
    assert.equal(sendCalls, 0);
    assert.equal(result.enabled, false);
    assert.equal(result.status, 'disabled');
    assert.equal(result.summary.skipped, 3);
  });

  it('batches multiple photos into one email under budget', async () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
    const sent = [];
    const fakeResend = {
      emails: {
        send: async (payload) => {
          sent.push(payload);
          return { data: { id: `re_${sent.length}` }, error: null };
        },
      },
    };
    const result = await pd.deliverVisitPhotos({
      draft,
      forceEnabled: true,
      resendClient: fakeResend,
      sleepFn: async () => {},
      maxRawBytes: 15 * 1024 * 1024,
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.summary.sent, 3);
    assert.equal(sent.length, 1, '3 small photos → one batch email');
    assert.equal(sent[0].subject, '[Central Pet Shift] FM053 2026-07-13 batch 1/1 (3 photos)');
    assert.equal(sent[0].headers['X-Central-Pet-Store'], '053');
    assert.equal(sent[0].attachments.length, 3);
    assert.equal(sent[0].attachments[0].filename, 'FM053_2026-07-13_before_1.jpg');
    assert.equal(result.photos['before-1'].batchIndex, 1);
    assert.equal(result.photos['before-1'].batchTotal, 1);
  });

  it('tiny budget forces multiple batches with correct n/total', async () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
    // reset delivery state by not passing existing
    const sent = [];
    const fakeResend = {
      emails: {
        send: async (payload) => {
          sent.push(payload);
          return { data: { id: `re_${sent.length}` }, error: null };
        },
      },
    };
    // 100-byte photos, budget 150 → 1 per batch? 100+100=200>150 so pairs of 1
    const result = await pd.deliverVisitPhotos({
      draft,
      forceEnabled: true,
      resendClient: fakeResend,
      sleepFn: async () => {},
      maxRawBytes: 150,
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.summary.sent, 3);
    assert.equal(sent.length, 3);
    assert.equal(sent[0].subject, '[Central Pet Shift] FM053 2026-07-13 batch 1/3 (1 photo)');
    assert.equal(sent[2].subject, '[Central Pet Shift] FM053 2026-07-13 batch 3/3 (1 photo)');
    assert.equal(result.photos['endcaps-1'].batchTotal, 3);
  });

  it('batch failure marks only that batch failed; rebatch resend succeeds', async () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
    let n = 0;
    const flaky = {
      emails: {
        send: async () => {
          n += 1;
          if (n === 1) return { data: { id: 'ok1' }, error: null };
          if (n === 2) return { data: null, error: { message: 'rate limited' } };
          return { data: { id: `ok${n}` }, error: null };
        },
      },
    };
    // budget 150 → 3 batches of 1; first ok, second fails, third ok if called...
    // Actually after batch 2 fails, batch 3 still runs in same deliver call
    const first = await pd.deliverVisitPhotos({
      draft,
      forceEnabled: true,
      resendClient: flaky,
      sleepFn: async () => {},
      maxRawBytes: 150,
    });
    assert.equal(first.summary.sent, 2);
    assert.equal(first.summary.failed, 1);
    assert.equal(first.status, 'partial');
    const failedKey = Object.keys(first.photos).find((k) => first.photos[k].status === 'failed');
    assert.ok(failedKey);

    const second = await pd.deliverVisitPhotos({
      draft,
      existingDelivery: first,
      onlyFailed: true,
      forceEnabled: true,
      resendClient: flaky,
      sleepFn: async () => {},
      maxRawBytes: 150,
    });
    assert.equal(second.photos[failedKey].status, 'sent');
    assert.equal(second.summary.sent, 3);
    assert.equal(second.status, 'complete');
    // only one additional send for the failed batch
    assert.equal(n, 4);
  });

  it('setPhotoDelivery persists on sealed-like draft', () => {
    const delivery = {
      status: 'complete',
      enabled: true,
      lastRunAt: '2026-07-14T00:00:00.000Z',
      photos: { 'before-1': { status: 'sent' } },
      summary: { total: 1, pending: 0, sent: 1, failed: 0, skipped: 0 },
    };
    visitDraftStore.setPhotoDelivery(REP, DATE, STORE, delivery);
    const reloaded = visitDraftStore.getDraft(REP, DATE, STORE);
    assert.equal(reloaded.photoDelivery.status, 'complete');
    const sum = visitDraftStore.summarize(reloaded);
    assert.equal(sum.photoDelivery.status, 'complete');
    assert.equal(sum.photoDelivery.summary.sent, 1);
  });
});

describe('photo-delivery is gated off by default', () => {
  it('isPhotoDeliveryEnabled is false without env', () => {
    const prev = process.env.PHOTO_DELIVERY_ENABLED;
    delete process.env.PHOTO_DELIVERY_ENABLED;
    try {
      assert.equal(pd.isPhotoDeliveryEnabled(), false);
    } finally {
      if (prev !== undefined) process.env.PHOTO_DELIVERY_ENABLED = prev;
      else delete process.env.PHOTO_DELIVERY_ENABLED;
    }
  });
});
