'use strict';

/**
 * Stage 5 — Central Pet shift photo delivery via Resend.
 *
 * After a visit is transmitted (or on admin re-send), emails visit JPEGs in
 * size-budgeted batches to d6ewa.supervisor@gmail.com. flow-automation files
 * each attachment into OneDrive by canonical filename.
 *
 * CONFIG-GATED OFF by default (PHOTO_DELIVERY_ENABLED=0) unless env arms it.
 *
 * Subject contracts (both accepted by the receiver):
 *   Legacy: [Central Pet Shift] FM<store#> <YYYY-MM-DD> <filename>.jpg
 *   Batch:  [Central Pet Shift] FM<store#> <YYYY-MM-DD> batch <n>/<total> (<count> photos)
 * Filename contract: FM<store#>_<YYYY-MM-DD>_<category>_<seq>.jpg
 *
 * Base64 inflates ~37%; BATCH_RAW_BYTES_MAX default 15MB leaves headroom under
 * Resend's ~25MB encoded limit.
 */

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

const REPO_ROOT = path.join(__dirname, '../..');

const DEFAULT_TO = 'd6ewa.supervisor@gmail.com';
const DEFAULT_FROM = 'centralpet@retail-odyssey.com';
const SUBJECT_PREFIX = '[Central Pet Shift]';
const HEADER_STORE = 'X-Central-Pet-Store';
/** Default raw (pre-base64) budget per email. */
const DEFAULT_BATCH_RAW_BYTES_MAX = 15 * 1024 * 1024;

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

const SUBJECT_LEGACY_RE =
  /^\[Central Pet Shift\]\s+FM(\d{1,3})\s+(\d{4}-\d{2}-\d{2})\s+(.+\.jpe?g)\s*$/i;
const SUBJECT_BATCH_RE =
  /^\[Central Pet Shift\]\s+FM(\d{1,3})\s+(\d{4}-\d{2}-\d{2})\s+batch\s+(\d+)\/(\d+)\s+\((\d+)\s+photos?\)\s*$/i;
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

function batchRawBytesMax() {
  const raw =
    process.env.BATCH_RAW_BYTES_MAX ||
    process.env.PHOTO_BATCH_RAW_BYTES_MAX ||
    String(DEFAULT_BATCH_RAW_BYTES_MAX);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BATCH_RAW_BYTES_MAX;
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

/** Legacy single-photo subject (still valid for re-sends / tests). */
function buildSubject({ store, date, filename }) {
  const storePad = padStore(store);
  if (!storePad) throw new Error('buildSubject: store required');
  if (!date) throw new Error('buildSubject: date required');
  if (!filename) throw new Error('buildSubject: filename required');
  return `${SUBJECT_PREFIX} FM${storePad} ${date} ${filename}`;
}

/** Batch subject — metadata rides on attachment filenames. */
function buildBatchSubject({ store, date, batchIndex, batchTotal, count }) {
  const storePad = padStore(store);
  if (!storePad) throw new Error('buildBatchSubject: store required');
  if (!date) throw new Error('buildBatchSubject: date required');
  const n = Number(batchIndex) || 1;
  const total = Number(batchTotal) || 1;
  const c = Number(count) || 0;
  return `${SUBJECT_PREFIX} FM${storePad} ${date} batch ${n}/${total} (${c} photo${c === 1 ? '' : 's'})`;
}

function parseSubject(subject) {
  const s = String(subject || '').trim();
  const batch = SUBJECT_BATCH_RE.exec(s);
  if (batch) {
    return {
      kind: 'batch',
      store: padStore(batch[1]),
      date: batch[2],
      batchIndex: parseInt(batch[3], 10),
      batchTotal: parseInt(batch[4], 10),
      photoCount: parseInt(batch[5], 10),
      filename: null,
    };
  }
  const legacy = SUBJECT_LEGACY_RE.exec(s);
  if (legacy) {
    return {
      kind: 'legacy',
      store: padStore(legacy[1]),
      date: legacy[2],
      filename: legacy[3].trim(),
      batchIndex: null,
      batchTotal: null,
      photoCount: null,
    };
  }
  return null;
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
 * One visit = one store/date; never mix visits in a batch.
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
      // Legacy single-photo subject kept for inventory/debug; batches use buildBatchSubject.
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
      batchIndex: null,
      batchTotal: null,
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
      status: 'pending',
      resendId: old?.status === 'sent' ? old.resendId : null,
      error: null,
      sentAt: old?.status === 'sent' ? old.sentAt : null,
      attempts: old?.attempts || 0,
      batchIndex: null,
      batchTotal: null,
    };
    if (onlyFailed && old?.status === 'sent') {
      next[p.key] = { ...old };
    }
  }
  return next;
}

/**
 * Pack photos into batches under a raw-byte budget.
 * Never splits a single photo; oversized photos get their own batch.
 *
 * @param {Array<{ key: string, byteSize: number }>} photos
 * @param {number} maxRawBytes
 * @param {{ warnings?: string[] }} [opts]
 * @returns {Array<Array>}
 */
function packPhotoBatches(photos, maxRawBytes, opts = {}) {
  const warnings = opts.warnings || [];
  const batches = [];
  let current = [];
  let currentBytes = 0;

  for (const photo of photos) {
    const size = Number(photo.byteSize) || 0;
    if (size > maxRawBytes) {
      if (current.length) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      warnings.push(
        `photo ${photo.key || photo.filename} is ${size} bytes (> batch budget ${maxRawBytes}); sending alone`
      );
      batches.push([photo]);
      continue;
    }
    if (current.length && currentBytes + size > maxRawBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(photo);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function loadPhotoBuffer(photo) {
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
  return buffer;
}

async function sendPhotoBatch({ resend, photos, store, date, batchIndex, batchTotal, from, to }) {
  const subject = buildBatchSubject({
    store,
    date,
    batchIndex,
    batchTotal,
    count: photos.length,
  });

  const attachments = photos.map((p) => ({
    filename: p.filename,
    content: p.buffer.toString('base64'),
  }));

  const fileList = photos
    .map((p) => `<li>${p.filename} (${p.category} #${p.seq})</li>`)
    .join('');

  const payload = {
    from,
    to,
    subject,
    html: `<p>Central Pet shift photos (batch ${batchIndex}/${batchTotal}).</p>
<p><strong>Store:</strong> FM${store}<br/>
<strong>Date:</strong> ${date}<br/>
<strong>Photos:</strong> ${photos.length}</p>
<ul>${fileList}</ul>
<p>X-Central-Pet-Store and attachment filenames carry routing metadata for flow-automation.</p>`,
    headers: {
      [HEADER_STORE]: store,
    },
    attachments,
  };

  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message || String(error));
  return { resendId: data?.id || null, subject };
}

/**
 * Deliver photos for a visit draft. Per-photo pending/sent/failed state.
 * Photos are packed into size-budgeted multi-attachment emails.
 */
async function deliverVisitPhotos({
  draft,
  existingDelivery = null,
  onlyFailed = false,
  resendClient = null,
  sleepFn = sleep,
  forceEnabled = null,
  maxRawBytes = null,
} = {}) {
  const enabled = forceEnabled != null ? !!forceEnabled : isPhotoDeliveryEnabled();
  const photos = collectVisitPhotos(draft);
  const prevPhotos = existingDelivery?.photos || {};
  let map = mergeDeliveryMap(prevPhotos, photos, { onlyFailed });
  const budget = maxRawBytes != null ? maxRawBytes : batchRawBytesMax();

  if (!photos.length) {
    return {
      ...emptyDeliveryState(),
      status: 'empty',
      enabled,
      lastRunAt: new Date().toISOString(),
      photos: {},
      summary: { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 },
      message: 'No deliverable photos on visit',
      batches: [],
    };
  }

  if (!enabled) {
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
      batches: [],
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
      batches: [],
    };
  }

  // Photos still needing a send (failed/pending; keep sent)
  const toSend = [];
  for (const photo of photos) {
    const entry = map[photo.key];
    if (!entry) continue;
    if (entry.status === 'sent') continue;
    if (onlyFailed && entry.status !== 'failed' && entry.status !== 'pending') continue;

    try {
      const buffer = loadPhotoBuffer(photo);
      toSend.push({
        ...photo,
        buffer,
        byteSize: buffer.length,
      });
    } catch (err) {
      map[photo.key] = {
        ...entry,
        status: 'failed',
        error: err.message || String(err),
        attempts: (entry.attempts || 0) + 1,
        sentAt: null,
      };
    }
  }

  const packWarnings = [];
  const batches = packPhotoBatches(toSend, budget, { warnings: packWarnings });
  for (const w of packWarnings) {
    console.warn(`[photo-delivery] ${w}`);
  }

  const resend = resendClient || new Resend(process.env.RESEND_API_KEY);
  const from = photoSenderFrom();
  const to = photoDeliveryTo();
  const delay = throttleMs();
  const batchLog = [];
  let first = true;
  const batchTotal = batches.length;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchIndex = i + 1;
    if (!first && delay > 0) await sleepFn(delay);
    first = false;

    const store = batch[0].store;
    const date = batch[0].date;

    for (const p of batch) {
      const entry = map[p.key];
      map[p.key] = {
        ...entry,
        attempts: (entry.attempts || 0) + 1,
        batchIndex,
        batchTotal,
      };
    }

    try {
      const { resendId, subject } = await sendPhotoBatch({
        resend,
        photos: batch,
        store,
        date,
        batchIndex,
        batchTotal,
        from,
        to,
      });
      const sentAt = new Date().toISOString();
      for (const p of batch) {
        map[p.key] = {
          ...map[p.key],
          status: 'sent',
          resendId,
          error: null,
          sentAt,
          batchIndex,
          batchTotal,
          subject,
        };
      }
      batchLog.push({
        batchIndex,
        batchTotal,
        count: batch.length,
        bytes: batch.reduce((s, p) => s + p.byteSize, 0),
        resendId,
        subject,
        status: 'sent',
        keys: batch.map((p) => p.key),
      });
    } catch (err) {
      const msg = err.message || String(err);
      for (const p of batch) {
        map[p.key] = {
          ...map[p.key],
          status: 'failed',
          error: msg,
          sentAt: null,
          batchIndex,
          batchTotal,
        };
      }
      batchLog.push({
        batchIndex,
        batchTotal,
        count: batch.length,
        bytes: batch.reduce((s, p) => s + p.byteSize, 0),
        resendId: null,
        subject: buildBatchSubject({
          store,
          date,
          batchIndex,
          batchTotal,
          count: batch.length,
        }),
        status: 'failed',
        error: msg,
        keys: batch.map((p) => p.key),
      });
    }
  }

  const { summary, status } = summarizeDelivery(map);
  return {
    status,
    enabled: true,
    lastRunAt: new Date().toISOString(),
    photos: map,
    summary,
    message: packWarnings.length ? packWarnings.join('; ') : null,
    batches: batchLog,
    batchBudgetBytes: budget,
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
  DEFAULT_BATCH_RAW_BYTES_MAX,
  CATEGORY_SLUG,
  CANONICAL_CATEGORIES,
  isPhotoDeliveryEnabled,
  photoSenderFrom,
  photoDeliveryTo,
  batchRawBytesMax,
  padStore,
  canonicalCategory,
  buildCanonicalFilename,
  buildSubject,
  buildBatchSubject,
  parseSubject,
  parseFilename,
  collectVisitPhotos,
  packPhotoBatches,
  deliverVisitPhotos,
  getDeliveryStatus,
  initDeliveryEntries,
  mergeDeliveryMap,
  summarizeDelivery,
  emptyDeliveryState,
};
