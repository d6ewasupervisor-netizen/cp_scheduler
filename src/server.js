'use strict';

const express = require('express');
const path = require('path');
const { initDb } = require('./db');
const schedulerRoutes = require('./routes/scheduler');

initDb();

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'cp_scheduler' });
});

app.use('/api/central-pet', schedulerRoutes);

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`cp_scheduler listening on http://127.0.0.1:${PORT}`);
});
