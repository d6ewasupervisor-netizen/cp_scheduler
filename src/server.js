'use strict';

const express = require('express');
const path = require('path');
const { initDb } = require('./db');
const { requireAuth, requireAdmin } = require('./auth-middleware');
const authRoutes = require('./routes/auth');
const schedulerRoutes = require('./routes/scheduler');

initDb();

const app = express();
const PORT = process.env.PORT || 3847;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'cp_scheduler' });
});

app.use('/api/auth', authRoutes);

app.use('/api/central-pet', requireAuth, schedulerRoutes);

app.use(express.static(path.join(__dirname, '../public')));

app.get('/rep.html', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/rep.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`cp_scheduler listening on http://127.0.0.1:${PORT}`);
});
