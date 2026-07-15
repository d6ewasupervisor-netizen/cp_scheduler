'use strict';

const express = require('express');
const path = require('path');
const { initDb } = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const authRoutes = require('./routes/auth');
const schedulerRoutes = require('./routes/scheduler');
const {
  isPhotoDeliveryEnabled,
  photoSenderFrom,
  photoDeliveryTo,
} = require('./lib/photo-delivery');

initDb();

const app = express();
const PORT = process.env.PORT || 3847;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'cp_scheduler',
    photoDelivery: {
      enabled: isPhotoDeliveryEnabled(),
      from: photoSenderFrom(),
      to: photoDeliveryTo(),
      // Sends only fire on transmit completion or admin re-send — never on boot.
      trigger: 'event-driven (transmit complete | admin resend)',
    },
  });
});

app.use('/api/auth', authRoutes);

app.use('/api/central-pet', requireAuth, schedulerRoutes);

app.use(express.static(path.join(__dirname, '../public')));

app.get('/rep.html', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/rep.html'));
});

app.get('/shiftday.html', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/shiftday.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  // Load photo-delivery at boot for config visibility only — does not scan visits or send.
  const photoEnabled = isPhotoDeliveryEnabled();
  console.log(`cp_scheduler listening on http://127.0.0.1:${PORT}`);
  console.log(
    `[photo-delivery] module loaded · PHOTO_DELIVERY_ENABLED=${photoEnabled ? '1' : '0'} · PHOTO_SENDER_FROM=${photoSenderFrom()} · trigger=event-driven (no boot send)`
  );
});
