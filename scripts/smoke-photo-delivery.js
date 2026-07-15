'use strict';

/**
 * Single-photo smoke test for Stage 5 photo delivery.
 * Sends ONE JPEG via Resend → d6ewa.supervisor@gmail.com for the Gmail poller.
 *
 * Usage (from repo root):
 *   node scripts/smoke-photo-delivery.js
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
  buildCanonicalFilename,
  buildSubject,
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
  const photoSrc =
    process.env.SMOKE_PHOTO ||
    path.join(REPO, 'data/dryrun-demo-photos/after-1.jpg');

  if (!fs.existsSync(photoSrc)) {
    console.error('Smoke photo not found:', photoSrc);
    process.exit(1);
  }

  // Staging dir under visit-drafts so collectVisitPhotos resolves paths normally
  const relDir = `data/visit-drafts/_smoke/${date}-${store}-photos`;
  const absDir = path.join(REPO, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const relPhoto = `${relDir}/smoke-after-1.jpg`.replace(/\\/g, '/');
  const absPhoto = path.join(REPO, relPhoto);
  fs.copyFileSync(photoSrc, absPhoto);

  const draft = {
    id: `_smoke/${date}-${store}`,
    repKey: '_smoke',
    date,
    actualStore: store,
    beforePhotos: [],
    afterPhotos: [
      {
        path: relPhoto,
        store,
        date,
        category: 'after',
        seq: 1,
      },
    ],
    categoryPhotos: {},
    loadCheck: null,
  };

  const filename = buildCanonicalFilename({
    store,
    date,
    category: 'after',
    seq: 1,
  });
  const subject = buildSubject({ store, date, filename });

  console.log('=== Stage 5 smoke photo delivery ===');
  console.log('enabled:', isPhotoDeliveryEnabled());
  console.log('from:', photoSenderFrom());
  console.log('to:', photoDeliveryTo().join(', '));
  console.log('store:', padStore(store));
  console.log('date:', date);
  console.log('filename:', filename);
  console.log('subject:', subject);
  console.log('bytes:', fs.statSync(absPhoto).size);
  console.log('sending…');

  const result = await deliverVisitPhotos({
    draft,
    forceEnabled: true,
    sleepFn: async () => {},
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.summary?.sent !== 1) {
    console.error('SMOKE FAIL: expected 1 sent photo');
    process.exit(2);
  }

  const expectedOneDrive = path.join(
    process.env.CENTRAL_PET_SHIFT_PHOTO_ROOT ||
      String.raw`C:\Users\tgaut\OneDrive - Advantage Solutions\Central Pet Shift Data`,
    date,
    padStore(store),
    filename
  );
  console.log('expect OneDrive path (after Gmail poller):', expectedOneDrive);
  console.log('SMOKE SEND OK — wait for poller (~60s) then check folder');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
