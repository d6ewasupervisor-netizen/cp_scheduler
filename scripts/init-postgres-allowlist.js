#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const sqlPath = path.join(__dirname, 'init-allowed-emails.sql');
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

if (!url) {
  console.error('Set DATABASE_PUBLIC_URL or DATABASE_URL');
  process.exit(1);
}

(async () => {
  const client = new Client({
    connectionString: url,
    ssl: url.includes('railway.internal') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query(fs.readFileSync(sqlPath, 'utf8'));
  const { rows } = await client.query('SELECT email FROM allowed_emails ORDER BY email');
  console.log(`allowed_emails: ${rows.length} rows`);
  for (const row of rows) console.log(`  - ${row.email}`);
  await client.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
