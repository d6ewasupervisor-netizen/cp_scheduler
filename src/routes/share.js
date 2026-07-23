'use strict';

/**
 * Public (no sign-in) photo share board — token-gated, 24-hour expiry.
 * Mounted at /api/share BEFORE the auth middleware.
 *
 *   GET /api/share/:token         → board JSON (records a tracked view)
 *   GET /api/share/:token/photo   → one photo file (?file=basename)
 */

const express = require('express');
const path = require('path');
const shareStore = require('../lib/photo-share-store');
const visitDraftStore = require('../lib/visit-draft-store');
const { collectVisitPhotos } = require('../lib/photo-delivery');

const router = express.Router();

const CATEGORY_LABELS = {
  before: 'Before',
  after: 'After',
  load: 'Load / order',
  endcaps: 'End caps',
  clipstrips: 'Clip strips',
  'wing-panels': 'Wing panels',
  wingpanels: 'Wing panels',
  'cat-litter-pan-liners': 'Cat litter pan liners',
  litterliners: 'Cat litter pan liners',
  'butcher-block-rack': 'Butcher Block rack',
  butcherblock: 'Butcher Block rack',
  'cp-serviced-section': 'CP-serviced section',
  section: 'CP-serviced section',
};

function shareGone(res, share) {
  const reason = share?.revokedAt ? 'This link was turned off.' : 'This link has expired.';
  return res.status(410).json({ ok: false, error: `${reason} Ask your supervisor for a new one.` });
}

router.get('/:token', (req, res) => {
  const token = String(req.params.token || '');
  const share = shareStore.getShare(token);
  if (!share) return res.status(404).json({ ok: false, error: 'Share link not found.' });
  if (!shareStore.isActive(share)) return shareGone(res, share);

  const draft = visitDraftStore.getDraft(share.repKey, share.date, share.actualStore);
  if (!draft) return res.status(404).json({ ok: false, error: 'Visit no longer exists.' });

  // Tracking: every board open is recorded with ip + user agent.
  shareStore.recordView(token, {
    ip: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
  });

  const inventory = collectVisitPhotos(draft);
  const groups = new Map();
  for (const p of inventory) {
    const label = CATEGORY_LABELS[p.category] || p.category;
    if (!groups.has(label)) groups.set(label, []);
    const file = path.basename(String(p.path));
    groups.get(label).push({
      seq: p.seq,
      filename: p.filename,
      url: `/api/share/${encodeURIComponent(token)}/photo?file=${encodeURIComponent(file)}`,
    });
  }

  return res.json({
    ok: true,
    store: draft.actualStore,
    date: draft.date,
    repKey: draft.repKey,
    status: draft.status,
    expiresAt: share.expiresAt,
    photoCount: inventory.length,
    groups: [...groups.entries()].map(([label, photos]) => ({ label, photos })),
  });
});

router.get('/:token/photo', (req, res) => {
  const token = String(req.params.token || '');
  const share = shareStore.getShare(token);
  if (!share) return res.status(404).json({ ok: false, error: 'Share link not found.' });
  if (!shareStore.isActive(share)) return shareGone(res, share);

  const file = String(req.query.file || '');
  if (!file) return res.status(400).json({ ok: false, error: 'file required' });
  try {
    const resolved = visitDraftStore.resolvePhotoFile(share.repKey, share.date, share.actualStore, file);
    if (!resolved) return res.status(404).json({ ok: false, error: 'Photo not found' });
    const ext = path.extname(resolved.filename).toLowerCase();
    const type =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/jpeg';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(resolved.absPath);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
