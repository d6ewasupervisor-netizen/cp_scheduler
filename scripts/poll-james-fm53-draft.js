#!/usr/bin/env node
/**
 * Poll production for james-duchene/2026-07-15-53 draft readiness.
 * Does NOT arm LIVE_TRANSMIT. Prints status every interval until ready_for_prod
 * or --once.
 *
 *   node scripts/poll-james-fm53-draft.js
 *   node scripts/poll-james-fm53-draft.js --once
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const BASE = 'https://cpscheduler-production.up.railway.app';
const REP = 'james-duchene';
const DATE = '2026-07-15';
const STORE = 53;
const DRAFT_ID = `${REP}/${DATE}-${STORE}`;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(m) {
  require('fs').writeSync(1, `[${ts()}] ${m}\n`);
}

function railwayVars() {
  // Prefer cached JWT from env for long-running pollers (avoids CLI every tick).
  if (process.env.CP_JWT_SECRET) {
    return { JWT_SECRET: process.env.CP_JWT_SECRET };
  }
  const bin = process.env.RAILWAY_CLI || path.join(process.env.APPDATA || '', 'npm', 'railway.cmd');
  const r = spawnSync(
    bin,
    ['variable', 'list', '--service', 'cp_scheduler', '--json'],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      shell: false,
      env: {
        ...process.env,
        RAILWAY_CALLER: process.env.RAILWAY_CALLER || 'skill:use-railway@1.2.1',
        RAILWAY_AGENT_SESSION: process.env.RAILWAY_AGENT_SESSION || 'cp-live-poll',
      },
    },
  );
  if (r.status !== 0 || !r.stdout) {
    throw new Error((r.stderr || r.stdout || `exit ${r.status}`).toString().slice(0, 300));
  }
  return JSON.parse(r.stdout.replace(/^\uFEFF/, '').trim());
}

function adminToken(secret) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ email: 'tyson.gauthier@retailodyssey.com', typ: 'session' }, secret);
}

async function get(token, p) {
  const r = await fetch(`${BASE}${p}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

async function snapshot(token) {
  const [live, visit, drafts, dryruns] = await Promise.all([
    get(token, '/api/central-pet/shift-day/live/status'),
    get(token, `/api/central-pet/shift-day/visit?rep=${REP}&date=${DATE}&store=${STORE}`),
    get(token, '/api/central-pet/shift-day/visit/drafts'),
    get(token, '/api/central-pet/shift-day/dryrun'),
  ]);

  const draft =
    visit.status === 200
      ? visit.data
      : (drafts.data || []).find((d) => d.draftId === DRAFT_ID || (d.repKey === REP && String(d.date) === DATE && Number(d.actualStore) === STORE));

  return {
    live: live.data,
    visitStatus: visit.status,
    draft,
    draftCount: Array.isArray(drafts.data) ? drafts.data.length : 0,
    dryrunCount: dryruns.data?.runs?.length ?? (Array.isArray(dryruns.data) ? dryruns.data.length : 0),
  };
}

function summarizeDraft(d) {
  if (!d) return 'no draft yet';
  const unmet = d.unmet || d.unmetRequirements || [];
  const writeOrder = d.writeOrder;
  const workLoad = d.workLoad;
  return [
    `status=${d.status}`,
    `writeOrder=${writeOrder}`,
    `workLoad=${workLoad}`,
    `mileage=${d.mileage?.miles ?? d.mileageMiles ?? d.computedMileage ?? '?'}`,
    `photos before=${(d.beforePhotos || d.photos?.before || []).length} after=${(d.afterPhotos || d.photos?.after || []).length}`,
    unmet.length ? `unmet=${JSON.stringify(unmet).slice(0, 120)}` : 'unmet=none',
  ].join(' ');
}

async function main() {
  const once = process.argv.includes('--once');
  const intervalMs = 15000;
  log(`Polling ${DRAFT_ID} on ${BASE}`);
  log(`LIVE arm will stay OFF until you say go after seal + dry-run eyeball.`);

  const vars = railwayVars();
  const token = adminToken(vars.JWT_SECRET);

  for (;;) {
    try {
      const snap = await snapshot(token);
      log(
        `LIVE_TRANSMIT=${snap.live?.liveTransmitEnabled ? 'ON' : 'off'} allowlist=${JSON.stringify(snap.live?.draftIds || [])} drafts=${snap.draftCount} dryruns=${snap.dryrunCount}`,
      );
      log(`  visit GET ${snap.visitStatus}: ${summarizeDraft(snap.draft)}`);
      if (snap.draft?.status === 'ready_for_prod') {
        log(`*** SEALED ready_for_prod — draftId=${DRAFT_ID} ***`);
        log(JSON.stringify({
          draftId: DRAFT_ID,
          status: snap.draft.status,
          writeOrder: snap.draft.writeOrder,
          workLoad: snap.draft.workLoad,
          mileage: snap.draft.mileage,
          times: { start: snap.draft.actualStart || snap.draft.times?.stopActual, end: snap.draft.times },
          survey: snap.draft.surveyAnswers || snap.draft.survey,
        }, null, 2));
        if (once) process.exit(0);
        // keep polling so we can see later state unless --once
        log('Seal detected. Waiting for dry-run / arm instructions (still not arming).');
      }
    } catch (e) {
      log(`poll error: ${e.message}`);
    }
    if (once) process.exit(0);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
