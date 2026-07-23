'use strict';

/**
 * 24-hour shareable photo boards for visit drafts.
 *
 * A share is an admin-created, token-gated public view of one visit's photos
 * (before / after / categories / load). Links expire 24 hours after creation
 * and every board open is tracked (timestamp, ip, user agent).
 *
 * Storage: data/photo-shares.json — same data volume as visit drafts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE =
  process.env.PHOTO_SHARES_FILE || path.join(__dirname, '../../data/photo-shares.json');

const SHARE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TRACKED_VIEWS = 300;

function readStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return { shares: [] };
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!Array.isArray(data.shares)) return { shares: [] };
    return data;
  } catch {
    return { shares: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function newToken() {
  // URL-safe, unguessable
  return crypto.randomBytes(24).toString('base64url');
}

function isActive(share, now = Date.now()) {
  if (!share) return false;
  if (share.revokedAt) return false;
  return new Date(share.expiresAt).getTime() > now;
}

/**
 * Create a share for one visit draft — idempotent: an existing active share
 * for the same rep/date/store is returned instead of minting a second link.
 */
function createShare({ repKey, date, actualStore, createdBy = null }) {
  if (!repKey || !date || actualStore == null) {
    throw new Error('repKey, date, actualStore required');
  }
  const store = readStore();
  const existing = store.shares.find(
    (s) =>
      s.repKey === repKey &&
      s.date === String(date) &&
      String(s.actualStore) === String(actualStore) &&
      isActive(s)
  );
  if (existing) return existing;

  const now = new Date();
  const share = {
    token: newToken(),
    repKey,
    date: String(date),
    actualStore: String(actualStore),
    createdBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHARE_TTL_MS).toISOString(),
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    views: [],
  };
  store.shares.push(share);
  writeStore(store);
  return share;
}

function getShare(token) {
  if (!token) return null;
  const store = readStore();
  return store.shares.find((s) => s.token === token) || null;
}

/** Get a share only if it is still viewable (not expired / revoked). */
function getActiveShare(token) {
  const share = getShare(token);
  return isActive(share) ? share : null;
}

/** Record a board open (tracking). Returns updated share or null. */
function recordView(token, { ip = null, userAgent = null } = {}) {
  const store = readStore();
  const share = store.shares.find((s) => s.token === token);
  if (!share || !isActive(share)) return null;
  share.viewCount = (share.viewCount || 0) + 1;
  share.lastViewedAt = new Date().toISOString();
  share.views = share.views || [];
  share.views.push({
    at: share.lastViewedAt,
    ip: ip ? String(ip).slice(0, 64) : null,
    userAgent: userAgent ? String(userAgent).slice(0, 200) : null,
  });
  if (share.views.length > MAX_TRACKED_VIEWS) {
    share.views = share.views.slice(-MAX_TRACKED_VIEWS);
  }
  writeStore(store);
  return share;
}

function revokeShare(token) {
  const store = readStore();
  const share = store.shares.find((s) => s.token === token);
  if (!share) return null;
  if (!share.revokedAt) {
    share.revokedAt = new Date().toISOString();
    writeStore(store);
  }
  return share;
}

/** All shares, newest first — for the admin tracking list. */
function listShares({ repKey = null, date = null, actualStore = null } = {}) {
  const store = readStore();
  return store.shares
    .filter((s) => {
      if (repKey && s.repKey !== repKey) return false;
      if (date && s.date !== String(date)) return false;
      if (actualStore != null && String(s.actualStore) !== String(actualStore)) return false;
      return true;
    })
    .map((s) => ({ ...s, active: isActive(s) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  SHARE_TTL_MS,
  createShare,
  getShare,
  getActiveShare,
  recordView,
  revokeShare,
  listShares,
  isActive,
  STORE_FILE,
};
