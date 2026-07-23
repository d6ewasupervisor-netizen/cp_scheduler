'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpFile = path.join(os.tmpdir(), `photo-shares-test-${process.pid}.json`);
process.env.PHOTO_SHARES_FILE = tmpFile;

const shareStore = require('../src/lib/photo-share-store');

test.beforeEach(() => {
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* fresh */
  }
});

test.after(() => {
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }
});

test('createShare mints a 24h token and is idempotent per visit', () => {
  const a = shareStore.createShare({ repKey: 'james-duchene', date: '2026-07-22', actualStore: 53, createdBy: 't@x' });
  assert.ok(a.token.length >= 24);
  const ttl = new Date(a.expiresAt) - new Date(a.createdAt);
  assert.strictEqual(ttl, shareStore.SHARE_TTL_MS);
  assert.strictEqual(a.viewCount, 0);

  // Same visit again → same active share, no second token
  const b = shareStore.createShare({ repKey: 'james-duchene', date: '2026-07-22', actualStore: 53 });
  assert.strictEqual(b.token, a.token);

  // Different visit → different token
  const c = shareStore.createShare({ repKey: 'james-duchene', date: '2026-07-22', actualStore: 281 });
  assert.notStrictEqual(c.token, a.token);
});

test('recordView tracks count, timestamp, ip and user agent', () => {
  const s = shareStore.createShare({ repKey: 'r', date: '2026-07-23', actualStore: 12 });
  shareStore.recordView(s.token, { ip: '1.2.3.4', userAgent: 'iPhone Safari' });
  const updated = shareStore.recordView(s.token, { ip: '5.6.7.8', userAgent: 'Chrome' });
  assert.strictEqual(updated.viewCount, 2);
  assert.strictEqual(updated.views.length, 2);
  assert.strictEqual(updated.views[1].ip, '5.6.7.8');
  assert.ok(updated.lastViewedAt);
});

test('expired and revoked shares stop resolving as active', () => {
  const s = shareStore.createShare({ repKey: 'r', date: '2026-07-23', actualStore: 99 });
  assert.ok(shareStore.getActiveShare(s.token));

  shareStore.revokeShare(s.token);
  assert.strictEqual(shareStore.getActiveShare(s.token), null);
  // Views on a dead link are not recorded
  assert.strictEqual(shareStore.recordView(s.token), null);

  // Expiry: rewrite the file with a past expiresAt
  const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  raw.shares[0].revokedAt = null;
  raw.shares[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(tmpFile, JSON.stringify(raw));
  assert.strictEqual(shareStore.getActiveShare(s.token), null);
  // Expired share is not treated as the idempotent target — a new one mints
  const again = shareStore.createShare({ repKey: 'r', date: '2026-07-23', actualStore: 99 });
  assert.notStrictEqual(again.token, s.token);
});

test('listShares filters and marks active, newest first', () => {
  shareStore.createShare({ repKey: 'a', date: '2026-07-23', actualStore: 1 });
  shareStore.createShare({ repKey: 'b', date: '2026-07-23', actualStore: 2 });
  const all = shareStore.listShares();
  assert.strictEqual(all.length, 2);
  assert.ok(all.every((s) => s.active === true));
  const onlyB = shareStore.listShares({ repKey: 'b' });
  assert.strictEqual(onlyB.length, 1);
  assert.strictEqual(String(onlyB[0].actualStore), '2');
});
