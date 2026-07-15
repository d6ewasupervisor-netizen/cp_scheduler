'use strict';
/**
 * One-off manual smoke test for Stage 3 report — exercises the real HTTP
 * routes end to end (order-only, load-only, both) using local dev auth
 * bypass. Not part of the automated test suite; safe to delete after use.
 */

const BASE = 'http://127.0.0.1:3847/api/central-pet';
const REP = 'brian-campbell';
const WEEK_START = '2026-07-05';

const fs = require('fs');
const path = require('path');

const FAKE_JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64'
);

function form(fields, filePart) {
  const boundary = '----wt' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  if (filePart) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filePart.filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
    );
  }
  const head = Buffer.from(parts.join(''), 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = filePart ? Buffer.concat([head, filePart.buffer, tail]) : Buffer.concat([head, tail]);
  return { boundary, body };
}

async function postJson(path_, body) {
  const res = await fetch(`${BASE}${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path_} -> ${res.status}: ${data.error}`);
  return data;
}

async function postPhoto(fields) {
  const { boundary, body } = form(fields, { filename: 'photo.jpg', buffer: FAKE_JPG });
  const res = await fetch(`${BASE}/shift-day/visit/photo`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`photo -> ${res.status}: ${data.error}`);
  return data;
}

async function getJson(path_) {
  const res = await fetch(`${BASE}${path_}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path_} -> ${res.status}: ${data.error}`);
  return data;
}

const log = [];
function say(s) {
  log.push(s);
  console.log(s);
}

async function runVisit({ label, shiftId, date, actualStore, loadBranch, includeChecklist, startHour = 13, stopHour = 15 }) {
  say(`\n=== ${label} (shift ${shiftId}, store ${actualStore}, ${date}) ===`);
  let draft = await postJson('/shift-day/visit/start', { repKey: REP, weekStart: WEEK_START, shiftId });
  say(`start -> steps=[${draft.steps.join(', ')}] currentStep=${draft.currentStep}`);

  draft = await postPhoto({ repKey: REP, date, actualStore: String(actualStore), target: 'before' });
  say(`before photo -> beforePhotos=${draft.beforePhotos.length}, tag=${JSON.stringify(draft.beforePhotos[0])}`);
  say(`  auto-fill check: survey.q1=${draft.survey.q1 || '(unset)'} (should be yes now that a before photo exists)`);

  if (draft.currentStep === 'load_check' || draft.loadCheck) {
    draft = await postJson('/shift-day/visit/step', { repKey: REP, date, actualStore, step: 'load_check' });
    if (loadBranch === 'yes') {
      draft = await postPhoto({ repKey: REP, date, actualStore: String(actualStore), target: 'load', status: 'yes' });
      say(`load check YES -> status=${draft.loadCheck.status}, photo tagged store=${draft.loadCheck.photo.store}`);
    } else if (loadBranch === 'escalate') {
      draft = await postJson('/shift-day/visit/load-check', { repKey: REP, date, actualStore, status: 'no_found_later' });
      say(`load check NO -> "${'check the racks...'}" status=${draft.loadCheck.status}`);
      draft = await postJson('/shift-day/visit/load-check', { repKey: REP, date, actualStore, status: 'no_escalated' });
      say(`still not found -> ESCALATED, status=${draft.loadCheck.status} (contact-me instruction fires client-side, names store ${actualStore})`);
    }
  }

  if (includeChecklist) {
    draft = await postJson('/shift-day/visit/step', { repKey: REP, date, actualStore, step: 'write_order_checklist' });
    const checklist = await getJson('/shift-day/visit-flow/scope-checklist');
    const orderItems = checklist.sections.flatMap((s) => s.items).filter((i) => i.appliesTo !== 'load');
    for (const item of orderItems.slice(0, 3)) {
      draft = await postJson('/shift-day/visit/checklist', { repKey: REP, date, actualStore, itemId: item.id, checked: true });
    }
    say(`checklist -> ticked ${Object.values(draft.checklist).filter((c) => c.checked).length} of ${orderItems.length} order/both items`);
  }

  draft = await postJson('/shift-day/visit/step', { repKey: REP, date, actualStore, step: 'category_photos' });
  const categories = await getJson('/shift-day/visit-flow/category-targets');
  draft = await postPhoto({ repKey: REP, date, actualStore: String(actualStore), target: 'category', categoryId: categories[0].id });
  say(`category photo (${categories[0].label}) -> ${draft.categoryPhotos[categories[0].id].length} photo(s)`);

  draft = await postJson('/shift-day/visit/step', { repKey: REP, date, actualStore, step: 'survey' });
  draft = await postJson('/shift-day/visit/survey', { repKey: REP, date, actualStore, answers: { q3: 'Fully stocked', q5: 'yes', q7: 'Yes', q9: 'yes', q11: 'All good' } });
  say(`survey -> answers so far: ${JSON.stringify(draft.survey)}`);

  draft = await postJson('/shift-day/visit/step', { repKey: REP, date, actualStore, step: 'after_photos' });
  draft = await postPhoto({ repKey: REP, date, actualStore: String(actualStore), target: 'after' });
  say(`after photo -> afterPhotos=${draft.afterPhotos.length}`);
  say(`  auto-fill check: survey.q12=${draft.survey.q12 || '(unset)'} (should be yes now that an after photo exists)`);

  draft = await postJson('/shift-day/visit/step', { repKey: REP, date, actualStore, step: 'time' });
  draft = await postJson('/shift-day/visit/time', {
    repKey: REP,
    date,
    actualStore,
    startActual: `${date}T${String(startHour).padStart(2, '0')}:00:00.000Z`,
    stopActual: `${date}T${String(stopHour).padStart(2, '0')}:00:00.000Z`,
  });
  draft = await postJson('/shift-day/visit/mileage', { repKey: REP, date, actualStore });
  say(`mileage -> ${JSON.stringify(draft.mileage.leg)}`);

  draft = await postJson('/shift-day/visit/step', { repKey: REP, date, actualStore, step: 'review' });
  draft = await postJson('/shift-day/visit/finish', { repKey: REP, date, actualStore });
  say(`FINISHED -> status=${draft.status}, sealedAt=${draft.sealedAt}`);
  return draft;
}

async function main() {
  // ORDER-ONLY: store 19, 2026-07-07 (writeOrder true, workLoad false)
  await runVisit({
    label: 'ORDER-ONLY visit',
    shiftId: 'p06w3-brian-0707-19',
    date: '2026-07-07',
    actualStore: 19,
    loadBranch: null,
    includeChecklist: true,
  });

  // LOAD-ONLY with escalation: store 682, 2026-07-10 (writeOrder false, workLoad true)
  await runVisit({
    label: 'LOAD-ONLY visit (escalation path)',
    shiftId: 'p06w3-brian-0710-682',
    date: '2026-07-10',
    actualStore: 682,
    loadBranch: 'escalate',
    includeChecklist: false,
  });

  // BOTH, two stops same day to show mid-day mileage: 111 first (load found=yes), then 215
  await runVisit({
    label: 'BOTH visit — stop 1 of day',
    shiftId: 'p06w3-brian-0706-111',
    date: '2026-07-06',
    actualStore: 111,
    loadBranch: 'yes',
    includeChecklist: true,
    startHour: 6,
    stopHour: 9,
  });
  await runVisit({
    label: 'BOTH visit — stop 2 of day (mid-day mileage from store 111)',
    shiftId: 'p06w3-brian-0706-215',
    date: '2026-07-06',
    actualStore: 215,
    loadBranch: 'yes',
    includeChecklist: true,
    startHour: 10,
    stopHour: 13,
  });

  say('\n=== Admin read-only view ===');
  const all = await getJson('/shift-day/visit/drafts');
  say(`listAllDrafts -> ${all.length} records: ${all.map((d) => `${d.repKey}/${d.date}/${d.actualStore}:${d.status}`).join(', ')}`);

  fs.writeFileSync(path.join(__dirname, '../docs/stage3-walkthrough.log.txt'), log.join('\n'));
}

main().catch((err) => {
  console.error('WALKTHROUGH FAILED:', err);
  process.exit(1);
});
