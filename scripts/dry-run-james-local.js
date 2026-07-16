/**
 * Local dry-run assemble for James FM53 sealed draft (no LIVE writes).
 * Forces assembly even if PROD visit is already completed so we can eyeball
 * the HAR-hardened call sequence.
 *
 *   node scripts/dry-run-james-local.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { transmitVisit, defaultSasGet } = require('../src/lib/prod-transmitter');
const { loadSasSession } = require('../src/lib/sas-session');

const ROOT = path.join(__dirname, '..');
const DRAFT = path.join(ROOT, 'data/visit-drafts/james-duchene/2026-07-15-53.json');
const OUT_DIR = path.join(ROOT, 'output', 'dryrun-james-local');

async function main() {
  if (!fs.existsSync(DRAFT)) {
    console.error('Missing draft', DRAFT);
    process.exit(1);
  }
  const sealedRecord = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
  if (sealedRecord.status !== 'ready_for_prod') {
    console.error('Draft not sealed:', sealedRecord.status);
    process.exit(1);
  }

  const matchedVisit = {
    status: 'matched',
    appShift: {
      id: sealedRecord.shiftId || 'export-11',
      repKey: sealedRecord.repKey,
      date: sealedRecord.date,
      actualStore: sealedRecord.actualStore,
    },
    prodVisit: {
      visitId: 27000977,
      shiftId: 44392384,
      scheduledStore: sealedRecord.scheduledStore,
      actualStore: sealedRecord.actualStore,
      workdayGivenId: '800627385',
      repKey: sealedRecord.repKey,
      visitStatus: 'in-progress',
    },
  };

  // Real morning auth for live GETs; force not-completed so assemble can run
  const session = await loadSasSession();
  const realGet = defaultSasGet;
  const sasGet = async (token, urlPath, params = {}) => {
    const body = await realGet(token, urlPath, params);
    if (String(urlPath).includes('/shift-complete/') && body && typeof body === 'object') {
      return {
        ...body,
        current_status: 'in-progress',
        employees: (body.employees || []).map((e) =>
          String(e.shift_id) === '44392384'
            ? { ...e, actual_start_time: null, actual_end_time: null, no_show: true, work_time: null }
            : e
        ),
      };
    }
    return body;
  };

  const result = await transmitVisit({
    sealedRecord,
    matchedVisit,
    opts: {
      sasGet,
      loadSession: async () => session,
      timeChangeComment: 'Dry-run review — James FM53 sealed record (not LIVE)',
      isAlreadyTransmitted: () => false,
    },
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `assembled-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  const summary = {
    status: result.status,
    abortReason: result.abortReason,
    visitId: result.visitId,
    shiftId: result.shiftId,
    callCount: result.callCount || result.calls?.length,
    workTime: result.workTime,
    mileageCorrection: result.mileageCorrection,
    toHomeAssembled: result.toHomeAssembled,
    reasonIds: result.reasonIds,
    photoCounts: result.photoCounts,
    outFile,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (result.status !== 'ok') process.exit(2);

  const lines = ['# James local dry-run call spine', '', `File: \`${outFile}\``, ''];
  lines.push('| Seq | Method | Path | Notes |');
  lines.push('|----:|--------|------|-------|');
  for (const c of result.calls || []) {
    if (c.method === 'GET') continue;
    const p = (c.url || '').replace('https://prod.sasretail.com', '');
    let note = '';
    if (c.payload?.time_change_reason != null) note += `tcr=${c.payload.time_change_reason} `;
    if (c.payload?.travel_records?.length) {
      const tr = c.payload.travel_records[0];
      note += `travel ${tr.start_location_type}→${tr.end_location_type} ${tr.distance}mi chg=${tr.change_reason} `;
    } else if (Array.isArray(c.payload?.travel_records)) {
      note += 'travel=[] ';
    }
    if (c.payload?.team?.[0]?.spent_time_reason != null) {
      note += `spent=${c.payload.team[0].spent_time} reason=${c.payload.team[0].spent_time_reason} `;
    }
    if (c.payload?.spent_time_reason != null || p.includes('validate-spent')) {
      note += 'spent-validate ';
    }
    if (p.includes('/to_home/')) note += 'to_home ';
    if (p.includes('/to_store/')) note += 'to_store ';
    if (c.method === 'PUT' && p.includes('shift-complete')) note += 'FIRST_TIME_COMPLETE ';
    lines.push(`| ${c.seq} | ${c.method} | \`${p}\` | ${note.trim()} |`);
  }
  const md = path.join(OUT_DIR, 'SPINE.md');
  fs.writeFileSync(md, lines.join('\n'));
  console.log('\n' + lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
