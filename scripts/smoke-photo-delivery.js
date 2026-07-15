'use strict';

/**
 * Smoke test for Stage 5 batched photo delivery.
 * Sends a multi-photo batch via Resend → d6ewa.supervisor@gmail.com.
 *
 * Usage (from repo root):
 *   node scripts/smoke-photo-delivery.js
 *   SMOKE_PHOTO_COUNT=3 node scripts/smoke-photo-delivery.js
 *
 * Requires RESEND_API_KEY (from env, cp .env, or flow-automation .env).
 * Forces PHOTO_DELIVERY_ENABLED for this process only.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}

loadEnvFile(path.join(REPO, '.env'));
loadEnvFile(path.join(REPO, '../flow-automation/.env'));

process.env.PHOTO_DELIVERY_ENABLED = '1';
if (!process.env.PHOTO_SENDER_FROM) {
  process.env.PHOTO_SENDER_FROM = 'centralpet@retail-odyssey.com';
}

const {
  deliverVisitPhotos,
  buildBatchSubject,
  collectVisitPhotos,
  padStore,
  isPhotoDeliveryEnabled,
  photoSenderFrom,
  photoDeliveryTo,
} = require('../src/lib/photo-delivery');

async function main() {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY missing — set it or put it in .env / flow-automation/.env');
    process.exit(1);
  }
  if (!isPhotoDeliveryEnabled()) {
    console.error('PHOTO_DELIVERY_ENABLED is still off');
    process.exit(1);
  }

  const store = Number(process.env.SMOKE_STORE || 53);
  const date =
    process.env.SMOKE_DATE ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const count = Math.max(1, parseInt(process.env.SMOKE_PHOTO_COUNT || '3', 10) || 3);
  const photoSrc =
    process.env.SMOKE_PHOTO ||
    path.join(REPO, 'data/dryrun-demo-photos/after-1.jpg');
  const altSrc = path.join(REPO, 'data/dryrun-demo-photos/before-1.jpeg');

  if (!fs.existsSync(photoSrc)) {
    console.error('Smoke photo not found:', photoSrc);
    process.exit(1);
  }

  const relDir = `data/visit-drafts/_smoke/${date}-${store}-photos`;
  const absDir = path.join(REPO, relDir);
  fs.mkdirSync(absDir, { recursive: true });

  const categories = ['before', 'after', 'endcaps', 'clipstrips', 'wing-panels'];
  const beforePhotos = [];
  const afterPhotos = [];
  const categoryPhotos = {};

  for (let i = 0; i < count; i++) {
    const cat = categories[i % categories.length];
    const seq = Math.floor(i / categories.length) + 1;
    const src = i % 2 === 0 || !fs.existsSync(altSrc) ? photoSrc : altSrc;
    const relPhoto = `${relDir}/smoke-${cat}-${seq}.jpg`.replace(/\\/g, '/');
    fs.copyFileSync(src, path.join(REPO, relPhoto));
    const rec = { path: relPhoto, store, date, category: cat, seq };
    if (cat === 'before') beforePhotos.push(rec);
    else if (cat === 'after') afterPhotos.push(rec);
    else {
      if (!categoryPhotos[cat]) categoryPhotos[cat] = [];
      categoryPhotos[cat].push(rec);
    }
  }

  const draft = {
    id: `_smoke/${date}-${store}`,
    repKey: '_smoke',
    date,
    actualStore: store,
    beforePhotos,
    afterPhotos,
    categoryPhotos,
    loadCheck: null,
  };

  const inventory = collectVisitPhotos(draft);

  console.log('=== Stage 5 smoke photo delivery (batched) ===');
  console.log('enabled:', isPhotoDeliveryEnabled());
  console.log('from:', photoSenderFrom());
  console.log('to:', photoDeliveryTo().join(', '));
  console.log('store:', padStore(store));
  console.log('date:', date);
  console.log('photoCount:', inventory.length);
  console.log(
    'expected subject:',
    buildBatchSubject({
      store,
      date,
      batchIndex: 1,
      batchTotal: 1,
      count: inventory.length,
    })
  );
  console.log('sending…');

  const result = await deliverVisitPhotos({
    draft,
    forceEnabled: true,
    sleepFn: async () => {},
  });

  console.log(
    JSON.stringify(
      {
        status: result.status,
        summary: result.summary,
        batches: result.batches,
        photos: Object.fromEntries(
          Object.entries(result.photos || {}).map(([k, v]) => [
            k,
            { status: v.status, filename: v.filename, batchIndex: v.batchIndex, resendId: v.resendId },
          ])
        ),
      },
      null,
      2
    )
  );

  if (result.summary?.sent !== inventory.length) {
    console.error(`SMOKE FAIL: expected ${inventory.length} sent photos`);
    process.exit(2);
  }
  if ((result.batches || []).length !== 1) {
    console.error(`SMOKE FAIL: expected 1 batch email, got ${result.batches?.length}`);
    process.exit(2);
  }

  const root =
    process.env.CENTRAL_PET_SHIFT_PHOTO_ROOT ||
    String.raw`C:\Users\tgaut\OneDrive - Advantage Solutions\Central Pet Shift Data`;
  console.log('expect OneDrive folder (after Gmail poller):', path.join(root, date, padStore(store)));
  for (const p of inventory) {
    console.log('  ', path.join(root, date, padStore(store), p.filename));
  }
  console.log('SMOKE SEND OK — wait for poller (~60s) then confirm all files land from one email');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
