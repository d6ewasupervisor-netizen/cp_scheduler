'use strict';

/**
 * Stage 5 — Central Pet shift photo delivery via Resend.
 *
 * After a visit is transmitted (or on admin re-send), emails one JPEG per photo
 * to d6ewa.supervisor@gmail.com. flow-automation files them into OneDrive.
 *
 * CONFIG-GATED OFF by default (PHOTO_DELIVERY_ENABLED=0). Building this module
 * does not enable sending.
 *
 * Subject contract (stable): [Central Pet Shift] FM<store#> <YYYY-MM-DD> <filename>.jpg
 * Filename contract: FM<store#>_<YYYY-MM-DD>_<category>_<seq>.jpg
 */

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

const REPO_ROOT = path.join(__dirname, '../..');

const DEFAULT_TO = 'd6ewa.supervisor@gmail.com';
const DEFAULT_FROM = 'centralpet@retail-odyssey.com';
const SUBJECT_PREFIX = '[Central Pet Shift]';
const HEADER_STORE = 'X-Central-Pet-Store';

/** Internal draft category id → canonical filename slug. */
const CATEGORY_SLUG = {
  before: 'before',
  after: 'after',
  endcaps: 'endcaps',
  clipstrips: 'clipstrips',
  'wing-panels': 'wingpanels',
  wingpanels: 'wingpanels',
  'cat-litter-pan-liners': 'litterliners',
  litterliners: 'litterliners',
  'butcher-block-rack': 'butcherblock',
  butcherblock: 'butcherblock',
  'cp-serviced-section': 'section',
  section: 'section',
  load: 'load',
};

const CANONICAL_CATEGORIES = new Set([
  'before',
  'after',
  'endcaps',
  'clipstrips',
  'wingpanels',
  'litterliners',
  'butcherblock',
  'section',
  'load',
]);

const SUBJECT_RE =
  /^\[Central Pet Shift\]\s+FM(\d{1,3})\s+(\d{4}-\d{2}-\d{2})\s+(.+\.jpe?g)\s*$/i;
const FILENAME_RE =
  /^FM(\d{1,3})_(\d{4}-\d{2}-\d{2})_([a-z0-9-]+)_(\d+)\.jpe?g$/i;

function isPhotoDeliveryEnabled() {
  const raw = String(process.env.PHOTO_DELIVERY_ENABLED || '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function photoSenderFrom() {
  return (process.env.PHOTO_SENDER_FROM || DEFAULT_FROM).trim();
}

function photoDeliveryTo() {
  const raw = process.env.PHOTO_DELIVERY_TO || DEFAULT_TO;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function throttleMs() {
  const n = parseInt(process.env.PHOTO_DELIVERY_THROTTLE_MS || '250', 10);
  return Number.isFinite(n) && n >= 0 ? n : 250;
}

function padStore(store) {
  const digits = String(store ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(3, '0');
}

function canonicalCategory(raw) {
  const key = String(raw || '').trim();
  if (!key) return null;
  if (/^survey-q\d{1,2}$/i.test(key)) return key.toLowerCase();
  const mapped = CATEGORY_SLUG[key] || CATEGORY_SLUG[key.toLowerCase()];
  if (mapped) return mapped;
  const lower = key.toLowerCase().replace(/_/g, '-');
  if (CATEGORY_SLUG[lower]) return CATEGORY_SLUG[lower];
  return null;
}

function buildCanonicalFilename({ store, date, category, seq }) {
  const storePad = padStore(store);
  const cat = canonicalCategory(category);
  if (!storePad) throw new Error('buildCanonicalFilename: store required');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error('buildCanonicalFilename: date must be YYYY-MM-DD');
  }
  if (!cat) throw new Error(`buildCanonicalFilename: unknown category ${category}`);
  const n = Number(seq) || 1;
  return `FM${storePad}_${date}_${cat}_${n}.jpg`;
}

function buildSubject({ store, date, filename }) {
  const storePad = padStore(store);
  if (!storePad) throw new Error('buildSubject: store required');
  if (!date) throw new Error('buildSubject: date required');
  if (!filename) throw new Error('buildSubject: filename required');
  return `${SUBJECT_PREFIX} FM${storePad} ${date} ${filename}`;
}

function parseSubject(subject) {
  const m = SUBJECT_RE.exec(String(subject || '').trim());
  if (!m) return null;
  return {
    store: padStore(m[1]),
    date: m[2],
    filename: m[3].trim(),
  };
}

function parseFilename(name) {
  const m = FILENAME_RE.exec(String(name || '').trim());
  if (!m) return null;
  const category = m[3].toLowerCase();
  const isSurvey = /^survey-q\d{1,2}$/i.test(category);
  if (!isSurvey && !CANONICAL_CATEGORIES.has(category)) return null;
  return {
    store: padStore(m[1]),
    date: m[2],
    category,
    seq: parseInt(m[4], 10),
  };
}

function photoKey(category, seq) {
  return `${category}-${Number(seq) || 1}`;
}

function resolvePhotoAbsPath(photoRecord) {
  if (!photoRecord?.path) return null;
  const p = photoRecord.path;
  if (path.isAbsolute(p)) return p;
  return path.join(REPO_ROOT, p);
}

/**
 * Collect deliverable photos from a sealed (or sealed-like) visit draft.
 * Checklist-only photos are omitted; survey answers reuse other buckets.
 */
function collectVisitPhotos(draft) {
  if (!draft) return [];
  const store = draft.actualStore;
  const date = draft.date;
  const out = [];

  function push(categoryRaw, photoRecord) {
    if (!photoRecord?.path) return;
    const category = canonicalCategory(categoryRaw || photoRecord.category);
    if (!category) return;
    const seq = Number(photoRecord.seq) || out.filter((x) => x.category === category).length + 1;
    const filename = buildCanonicalFilename({ store, date, category, seq });
    out.push({
      key: photoKey(category, seq),
      category,
      seq,
      path: photoRecord.path,
      absPath: resolvePhotoAbsPath(photoRecord),
      filename,
      subject: buildSubject({ store, date, filename }),
      store: padStore(store),
      date: String(date),
    });
  }

  for (const p of draft.beforePhotos || []) push('before', p);
  for (const p of draft.afterPhotos || []) push('after', p);

  if (draft.loadCheck?.photo) push('load', draft.loadCheck.photo);

  const cats = draft.categoryPhotos || {};
  for (const [catId, list] of Object.entries(cats)) {
    for (const p of list || []) push(catId, p);
  }

  // Optional free-form survey image slots if ever stored under surveyPhotos
  for (const [qId, list] of Object.entries(draft.surveyPhotos || {})) {
    const cat = /^q\d+/i.test(qId) ? `survey-${qId.toLowerCase()}` : null;
    if (!cat) continue;
    for (const p of list || []) push(cat, p);
  }

  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyDeliveryState() {
  return {
    status: 'idle',
    enabled: isPhotoDeliveryEnabled(),
    lastRunAt: null,
    photos: {},
    summary: { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 },
  };
}

function summarizeDelivery(photosMap) {
  const entries = Object.values(photosMap || {});
  const summary = { total: entries.length, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const e of entries) {
    if (e.status === 'sent') summary.sent += 1;
    else if (e.status === 'failed') summary.failed += 1;
    else if (e.status === 'skipped') summary.skipped += 1;
    else summary.pending += 1;
  }
  let status = 'idle';
  if (summary.total === 0) status = 'empty';
  else if (summary.failed > 0 && summary.sent + summary.skipped + summary.pending > 0) status = 'partial';
  else if (summary.failed > 0 && summary.sent === 0 && summary.pending === 0) status = 'failed';
  else if (summary.sent === summary.total) status = 'complete';
  else if (summary.pending === summary.total) status = 'pending';
  else if (summary.sent > 0) status = 'partial';
  else status = 'pending';
  return { summary, status };
}

function initDeliveryEntries(photos) {
  const map = {};
  for (const p of photos) {
    map[p.key] = {
      key: p.key,
      category: p.category,
      seq: p.seq,
      filename: p.filename,
      subject: p.subject,
      path: p.path,
      status: 'pending',
      resendId: null,
      error: null,
      sentAt: null,
      attempts: 0,
    };
  }
  return map;
}

/**
 * Merge new inventory into existing delivery map, keeping sent entries,
 * re-pending only missing/new keys, and leaving failed as failed unless
 * forceResendFailed.
 */
function mergeDeliveryMap(existing, photos, { onlyFailed = false } = {}) {
  const prev = existing || {};
  const next = {};
  for (const p of photos) {
    const old = prev[p.key];
    if (onlyFailed) {
      if (old?.status === 'sent') {
        next[p.key] = { ...old };
        continue;
      }
      if (old?.status !== 'failed' && old?.status !== 'pending' && old?.status !== 'skipped') {
        // brand-new key after onlyFailed re-send of a partial set — treat as pending
      }
    } else if (old?.status === 'sent') {
      next[p.key] = { ...old };
      continue;
    }
    next[p.key] = {
      key: p.key,
      category: p.category,
      seq: p.seq,
      filename: p.filename,
      subject: p.subject,
      path: p.path,
      status: onlyFailed && old?.status === 'sent' ? 'sent' : 'pending',
      resendId: old?.status === 'sent' ? old.resendId : null,
      error: null,
      sentAt: old?.status === 'sent' ? old.sentAt : null,
      attempts: old?.attempts || 0,
    };
    if (onlyFailed && old?.status === 'sent') {
      next[p.key] = { ...old };
    }
  }
  return next;
}

async function sendOnePhoto({ resend, photo, from, to }) {
  const abs = photo.absPath;
  if (!abs || !fs.existsSync(abs)) {
    const err = new Error(`photo file missing: ${photo.path}`);
    err.code = 'photo_missing';
    throw err;
  }
  const buffer = fs.readFileSync(abs);
  if (!buffer.length) {
    const err = new Error(`photo file empty: ${photo.path}`);
    err.code = 'photo_empty';
    throw err;
  }

  const payload = {
    from,
    to,
    subject: photo.subject,
    html: `<p>Central Pet shift photo.</p>
<p><strong>Store:</strong> FM${photo.store}<br/>
<strong>Date:</strong> ${photo.date}<br/>
<strong>Category:</strong> ${photo.category}<br/>
<strong>File:</strong> ${photo.filename}</p>
<p>Subject and X-Central-Pet-Store header carry routing metadata for flow-automation.</p>`,
    headers: {
      [HEADER_STORE]: photo.store,
    },
    attachments: [
      {
        filename: photo.filename,
        content: buffer.toString('base64'),
      },
    ],
  };

  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message || String(error));
  return { resendId: data?.id || null };
}

/**
 * Deliver photos for a visit draft. Per-photo pending/sent/failed state.
 * When PHOTO_DELIVERY_ENABLED is off, inventories photos as pending/skipped
 * and does not call Resend.
 *
 * @param {object} opts
 * @param {object} opts.draft - visit draft record
 * @param {object} [opts.existingDelivery] - previous draft.photoDelivery
 * @param {boolean} [opts.onlyFailed] - re-send only failed/pending, keep sent
 * @param {object} [opts.resendClient] - injectable Resend-like client
 * @param {Function} [opts.sleepFn]
 * @param {boolean} [opts.forceEnabled] - test override for enabled gate
 */
async function deliverVisitPhotos({
  draft,
  existingDelivery = null,
  onlyFailed = false,
  resendClient = null,
  sleepFn = sleep,
  forceEnabled = null,
} = {}) {
  const enabled = forceEnabled != null ? !!forceEnabled : isPhotoDeliveryEnabled();
  const photos = collectVisitPhotos(draft);
  const prevPhotos = existingDelivery?.photos || {};
  let map = mergeDeliveryMap(prevPhotos, photos, { onlyFailed });

  if (!photos.length) {
    const state = {
      ...emptyDeliveryState(),
      status: 'empty',
      enabled,
      lastRunAt: new Date().toISOString(),
      photos: {},
      summary: { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 },
      message: 'No deliverable photos on visit',
    };
    return state;
  }

  if (!enabled) {
    // Inventory only — mark non-sent as skipped while gated off
    for (const key of Object.keys(map)) {
      if (map[key].status !== 'sent') {
        map[key] = {
          ...map[key],
          status: 'skipped',
          error: 'PHOTO_DELIVERY_ENABLED is off',
        };
      }
    }
    const { summary, status } = summarizeDelivery(map);
    return {
      status: status === 'complete' ? 'complete' : 'disabled',
      enabled: false,
      lastRunAt: new Date().toISOString(),
      photos: map,
      summary,
      message: 'Photo delivery gated off (PHOTO_DELIVERY_ENABLED=0)',
    };
  }

  if (!process.env.RESEND_API_KEY && !resendClient) {
    for (const key of Object.keys(map)) {
      if (map[key].status === 'sent') continue;
      map[key] = {
        ...map[key],
        status: 'failed',
        error: 'RESEND_API_KEY is not configured',
        attempts: (map[key].attempts || 0) + 1,
      };
    }
    const { summary, status } = summarizeDelivery(map);
    return {
      status,
      enabled: true,
      lastRunAt: new Date().toISOString(),
      photos: map,
      summary,
      message: 'RESEND_API_KEY is not configured',
    };
  }

  const resend = resendClient || new Resend(process.env.RESEND_API_KEY);
  const from = photoSenderFrom();
  const to = photoDeliveryTo();
  const delay = throttleMs();
  let first = true;

  for (const photo of photos) {
    const entry = map[photo.key];
    if (!entry) continue;
    if (entry.status === 'sent') continue;
    if (onlyFailed && entry.status !== 'failed' && entry.status !== 'pending') continue;

    if (!first && delay > 0) await sleepFn(delay);
    first = false;

    entry.attempts = (entry.attempts || 0) + 1;
    try {
      const { resendId } = await sendOnePhoto({ resend, photo, from, to });
      map[photo.key] = {
        ...entry,
        status: 'sent',
        resendId,
        error: null,
        sentAt: new Date().toISOString(),
      };
    } catch (err) {
      map[photo.key] = {
        ...entry,
        status: 'failed',
        error: err.message || String(err),
        sentAt: null,
      };
    }
  }

  const { summary, status } = summarizeDelivery(map);
  return {
    status,
    enabled: true,
    lastRunAt: new Date().toISOString(),
    photos: map,
    summary,
    message: null,
  };
}

function getDeliveryStatus(draft) {
  const photos = collectVisitPhotos(draft);
  const existing = draft?.photoDelivery || null;
  if (!existing) {
    const map = initDeliveryEntries(photos);
    const { summary, status } = summarizeDelivery(map);
    return {
      status: photos.length ? 'pending' : 'empty',
      enabled: isPhotoDeliveryEnabled(),
      lastRunAt: null,
      photos: map,
      summary: { ...summary, total: photos.length, pending: photos.length },
      inventory: photos.map((p) => ({
        key: p.key,
        filename: p.filename,
        subject: p.subject,
        category: p.category,
        seq: p.seq,
      })),
    };
  }
  return {
    ...existing,
    enabled: isPhotoDeliveryEnabled(),
    inventory: photos.map((p) => ({
      key: p.key,
      filename: p.filename,
      subject: p.subject,
      category: p.category,
      seq: p.seq,
    })),
  };
}

module.exports = {
  SUBJECT_PREFIX,
  HEADER_STORE,
  DEFAULT_FROM,
  DEFAULT_TO,
  CATEGORY_SLUG,
  CANONICAL_CATEGORIES,
  isPhotoDeliveryEnabled,
  photoSenderFrom,
  photoDeliveryTo,
  padStore,
  canonicalCategory,
  buildCanonicalFilename,
  buildSubject,
  parseSubject,
  parseFilename,
  collectVisitPhotos,
  deliverVisitPhotos,
  getDeliveryStatus,
  initDeliveryEntries,
  mergeDeliveryMap,
  summarizeDelivery,
  emptyDeliveryState,
};
