'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { initDb } = require('./db');
const { requireAuth } = require('./auth-middleware');
const authRoutes = require('./routes/auth');
const schedulerRoutes = require('./routes/scheduler');
const shareRoutes = require('./routes/share');
const shiftEventLog = require('./lib/shift-event-log');
const {
  isPhotoDeliveryEnabled,
  photoSenderFrom,
  photoDeliveryTo,
} = require('./lib/photo-delivery');

initDb();
// Idempotent — creates shift_events + store_notes when a DB is configured,
// no-ops (JSON fallback) otherwise. Best-effort: never blocks boot.
shiftEventLog.ensureTables().catch((err) =>
  console.error('[boot] ensureTables failed:', err.message)
);

const app = express();
const PORT = process.env.PORT || 3847;
const PUBLIC_DIR = path.join(__dirname, '../public');

function readAppVersion() {
  try {
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'app-version.json'), 'utf8');
    const data = JSON.parse(raw);
    return data && data.version ? String(data.version) : null;
  } catch {
    return null;
  }
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  let photoAi = { classifyEnabled: false, model: null };
  try {
    const photoClassifier = require('./lib/photo-classifier');
    photoAi = {
      classifyEnabled: photoClassifier.isClassifyEnabled(),
      model: photoClassifier.geminiModel(),
      signup: 'https://aistudio.google.com/apikey',
    };
  } catch {
    /* optional module */
  }
  res.json({
    ok: true,
    service: 'cp_scheduler',
    appVersion: readAppVersion(),
    photoDelivery: {
      enabled: isPhotoDeliveryEnabled(),
      from: photoSenderFrom(),
      to: photoDeliveryTo(),
      // Sends only fire on transmit completion or admin re-send — never on boot.
      trigger: 'event-driven (transmit complete | admin resend)',
    },
    photoAi,
  });
});

// Hotfix manifest — never cache so open tabs see Railway deploys quickly.
app.get('/app-version.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.type('application/json');
  res.sendFile(path.join(PUBLIC_DIR, 'app-version.json'));
});

app.use('/api/auth', authRoutes);

// Public 24-hour photo share boards — token-gated, no sign-in.
app.use('/api/share', shareRoutes);

app.use('/api/central-pet', requireAuth, schedulerRoutes);

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      const base = path.basename(filePath).toLowerCase();
      if (base === 'app-version.json' || base.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
      } else if (/\.(js|css)$/i.test(base)) {
        // Revalidate on each navigation/hotfix reload so devices don't keep stale modules.
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.get('/rep.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'rep.html'));
});

app.get('/shiftday.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'shiftday.html'));
});

app.get('/photo-training.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'photo-training.html'));
});

app.get('/share.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'share.html'));
});

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Bind 0.0.0.0 so Railway's edge proxy can reach the process (not only loopback).
app.listen(PORT, '0.0.0.0', () => {
  // Load photo-delivery at boot for config visibility only — does not scan visits or send.
  const photoEnabled = isPhotoDeliveryEnabled();
  console.log(`cp_scheduler listening on http://0.0.0.0:${PORT}`);
  console.log(`[hotfix] app version ${readAppVersion() || 'unknown'}`);
  console.log(
    `[photo-delivery] module loaded · PHOTO_DELIVERY_ENABLED=${photoEnabled ? '1' : '0'} · PHOTO_SENDER_FROM=${photoSenderFrom()} · trigger=event-driven (no boot send)`
  );
});
