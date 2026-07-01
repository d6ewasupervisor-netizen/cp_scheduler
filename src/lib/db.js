'use strict';

const { Pool } = require('pg');

function resolveSsl() {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  return false;
}

let pool = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: resolveSsl(),
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not configured');
  return p.query(text, params);
}

module.exports = { query, getPool };
