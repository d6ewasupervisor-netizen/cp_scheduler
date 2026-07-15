'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

  it('builds canonical filename and subject', () => {
    const filename = pd.buildCanonicalFilename({
      store: 53,
      date: '2026-07-13',
      category: 'endcaps',
      seq: 1,
    });
    assert.equal(filename, 'FM053_2026-07-13_endcaps_1.jpg');
    const subject = pd.buildSubject({ store: 53, date: '2026-07-13', filename });
    assert.equal(subject, '[Central Pet Shift] FM053 2026-07-13 FM053_2026-07-13_endcaps_1.jpg');
  });

  it('round-trips subject and filename parse (byte-identical store/date/category/seq)', () => {
    const cases = [
      { store: 53, date: '2026-07-13', category: 'before', seq: 1 },
      { store: 111, date: '2026-07-08', category: 'wing-panels', seq: 2 },
      { store: 19, date: '2026-06-01', category: 'survey-q12', seq: 1 },
      { store: 215, date: '2026-07-14', category: 'litterliners', seq: 3 },
    ];
    for (const c of cases) {
      const filename = pd.buildCanonicalFilename(c);
      const subject = pd.buildSubject({ store: c.store, date: c.date, filename });
      const parsedSub = pd.parseSubject(subject);
      const parsedFile = pd.parseFilename(filename);
      const wantStore = pd.padStore(c.store);
      const wantCat = pd.canonicalCategory(c.category);
      assert.equal(parsedSub.store, wantStore);
      assert.equal(parsedSub.date, c.date);
      assert.equal(parsedSub.filename, filename);
      assert.equal(parsedFile.store, wantStore);
      assert.equal(parsedFile.date, c.date);
      assert.equal(parsedFile.category, wantCat);
      assert.equal(parsedFile.seq, c.seq);
    }
  });
});

describe('photo-delivery collect + delivery state', () => {
  let photoDir;
  let beforePath;
  let afterPath;

  before(() => {
    cleanup();
    photoDir = path.join(visitDraftStore.ROOT, REP, `${DATE}-${STORE}-photos`);
    fs.mkdirSync(photoDir, { recursive: true });
    beforePath = path.join(photoDir, 'before-1.jpg');
    afterPath = path.join(photoDir, 'after-1.jpg');
    fs.writeFileSync(beforePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    fs.writeFileSync(afterPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));

    visitDraftStore.startVisit({
      repKey: REP,
      date: DATE,
      actualStore: STORE,
      scheduledStore: 391,
      workLoad: false,
      writeOrder: false,
    });
    const relBefore = path.relative(path.join(__dirname, '..'), beforePath).replace(/\\/g, '/');
    const relAfter = path.relative(path.join(__dirname, '..'), afterPath).replace(/\\/g, '/');
    visitDraftStore.recordBeforePhoto(REP, DATE, STORE, { photoPath: relBefore });
    visitDraftStore.recordAfterPhoto(REP, DATE, STORE, { photoPath: relAfter });
  });

  after(() => cleanup());

  it('collectVisitPhotos builds inventory with decoded store', () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
    const photos = pd.collectVisitPhotos(draft);
    assert.equal(photos.length, 2);
    assert.equal(photos[0].store, '053');
    assert.equal(photos[0].filename, 'FM053_2026-07-13_before_1.jpg');
    assert.equal(photos[0].subject, '[Central Pet Shift] FM053 2026-07-13 FM053_2026-07-13_before_1.jpg');
    assert.equal(photos[1].category, 'after');
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
    assert.equal(result.summary.skipped, 2);
    assert.equal(result.photos['before-1'].status, 'skipped');
  });

  it('pending → sent when enabled and Resend succeeds', async () => {
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
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.summary.sent, 2);
    assert.equal(result.photos['before-1'].status, 'sent');
    assert.equal(result.photos['after-1'].status, 'sent');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].subject, '[Central Pet Shift] FM053 2026-07-13 FM053_2026-07-13_before_1.jpg');
    assert.equal(sent[0].headers['X-Central-Pet-Store'], '053');
    assert.equal(sent[0].attachments[0].filename, 'FM053_2026-07-13_before_1.jpg');
  });

  it('failure → failed → re-send only missing (keeps sent)', async () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
    let n = 0;
    const flaky = {
      emails: {
        send: async (payload) => {
          n += 1;
          if (n === 1) return { data: { id: 'ok1' }, error: null };
          if (n === 2) return { data: null, error: { message: 'rate limited' } };
          return { data: { id: `ok${n}` }, error: null };
        },
      },
    };
    const first = await pd.deliverVisitPhotos({
      draft,
      forceEnabled: true,
      resendClient: flaky,
      sleepFn: async () => {},
    });
    assert.equal(first.summary.sent, 1);
    assert.equal(first.summary.failed, 1);
    assert.equal(first.status, 'partial');
    assert.equal(first.photos['after-1'].status, 'failed');

    const second = await pd.deliverVisitPhotos({
      draft,
      existingDelivery: first,
      onlyFailed: true,
      forceEnabled: true,
      resendClient: flaky,
      sleepFn: async () => {},
    });
    assert.equal(second.photos['before-1'].status, 'sent');
    assert.equal(second.photos['before-1'].resendId, 'ok1');
    assert.equal(second.photos['after-1'].status, 'sent');
    assert.equal(second.summary.sent, 2);
    assert.equal(second.status, 'complete');
  });

  it('setPhotoDelivery persists on sealed-like draft', () => {
    const draft = visitDraftStore.getDraft(REP, DATE, STORE);
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
