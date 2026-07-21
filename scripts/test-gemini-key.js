'use strict';

/**
 * Secret-safe Gemini key smoke test.
 * Never prints the API key — only pass/fail + short error hints.
 *
 * Usage:
 *   node scripts/test-gemini-key.js              # local env / .env
 *   node scripts/test-gemini-key.js --railway     # production /health + live classify probe
 *   node scripts/test-gemini-key.js --local-only  # skip live Gemini call; presence check only
 */

const fs = require('fs');
const path = require('path');

const RAILWAY_HEALTH = 'https://cpscheduler-production.up.railway.app/health';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

function loadDotEnv() {
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
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

function maskHint(key) {
  if (!key) return '(missing)';
  const t = String(key).trim();
  if (t.length < 12) return `(too short: ${t.length} chars)`;
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
}

async function checkRailwayHealth() {
  const res = await fetch(RAILWAY_HEALTH);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, detail: `HTTP ${res.status}` };
  }
  const enabled = !!body?.photoAi?.classifyEnabled;
  return {
    ok: enabled,
    detail: enabled
      ? `classifyEnabled=true model=${body.photoAi?.model || '?'}`
      : `classifyEnabled=false (GEMINI_API_KEY not live on Railway yet — wait for redeploy)`,
    body,
  };
}

async function pingGemini(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    MODEL
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8 },
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = payload?.error?.message || payload?.message || `HTTP ${res.status}`;
    return { ok: false, detail: msg };
  }
  const text =
    payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return {
    ok: true,
    detail: text.trim() ? `model responded (${text.trim().slice(0, 40)})` : 'model responded (empty text)',
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const wantRailway = args.has('--railway');
  const localOnly = args.has('--local-only');

  loadDotEnv();

  console.log('Gemini key smoke test (secret-safe)\n');

  let failed = 0;

  if (wantRailway) {
    process.stdout.write('Railway /health … ');
    try {
      const r = await checkRailwayHealth();
      console.log(r.ok ? `OK — ${r.detail}` : `FAIL — ${r.detail}`);
      if (!r.ok) failed += 1;
    } catch (err) {
      console.log(`FAIL — ${err.message}`);
      failed += 1;
    }
  }

  const key = process.env.GEMINI_API_KEY;
  process.stdout.write('Local GEMINI_API_KEY … ');
  if (!key || !String(key).trim()) {
    console.log('FAIL — not set in environment or .env');
    console.log('  Tip: run scripts/set-gemini-key.ps1 -LocalEnv');
    failed += 1;
  } else {
    console.log(`OK — present ${maskHint(key)}`);
    if (!localOnly) {
      process.stdout.write(`Live Gemini ping (${MODEL}) … `);
      try {
        const r = await pingGemini(String(key).trim());
        console.log(r.ok ? `OK — ${r.detail}` : `FAIL — ${r.detail}`);
        if (!r.ok) failed += 1;
      } catch (err) {
        console.log(`FAIL — ${err.message}`);
        failed += 1;
      }
    }
  }

  // If --railway and no local key, still useful; if both, both ran.
  if (!wantRailway && !key) {
    process.stdout.write('\nOptional Railway check: node scripts/test-gemini-key.js --railway\n');
  }

  console.log('');
  if (failed) {
    console.log(`RESULT: ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('RESULT: all checks passed');
}

main().catch((err) => {
  console.error('FAIL —', err.message);
  process.exit(1);
});
