'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the JSON fallback at a temp dir BEFORE requiring the module, and ensure
// no DATABASE_URL so hasDb() is false (pure JSON-fallback path under test).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-event-log-'));
process.env.SHIFT_EVENTS_JSON = path.join(tmpDir, 'shift-events.json');
process.env.STORE_NOTES_JSON = path.join(tmpDir, 'store-notes.json');
delete process.env.DATABASE_URL;
delete require.cache[require.resolve('../src/lib/db')];
delete require.cache[require.resolve('../src/lib/shift-event-log')];
const log = require('../src/lib/shift-event-log');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makeDraft(overrides = {}) {
  return {
    id: 'brian/2026-07-08-215',
    repKey: 'brian-campbell',
    date: '2026-07-08',
    scheduledStore: 391,
    actualStore: 215,
    workLoad: true,
    writeOrder: true,
    picksDay: null,
    visitStart: { actual: '2026-07-08T13:00:00Z' },
    visitStop: { actual: '2026-07-08T18:00:00Z' },
    mileage: { leg: { miles: 3.6 } },
    survey: { q1: 'yes' },
    stageNotes: { load_check: { text: 'slow receiver' } },
    shiftLog: {
      outcomes: [
        { optionId: 'worked_load_wrote_order', kind: 'outcome', label: 'Worked load and wrote order' },
        { optionId: 'huge_load', kind: 'variance', label: 'Load was unusually large' },
      ],
      custom: 'freezer flooded',
    },
    nextVisitNote: 'order more X next time',
    sealedAt: '2026-07-08T18:05:00Z',
    ...overrides,
  };
}

describe('shift-event-log — draft mapping', () => {
  it('splitOutcomes separates outcome vs variance labels', () => {
    const { outcome_summary, variance_summary } = log.splitOutcomes([
      { kind: 'outcome', label: 'A' },
      { kind: 'variance', label: 'B' },
      { kind: 'outcome', label: 'C' },
    ]);
    assert.equal(outcome_summary, 'A; C');
    assert.equal(variance_summary, 'B');
  });

  it('processesOf joins active processes', () => {
    assert.equal(log.processesOf({ workLoad: true, writeOrder: true }), 'workLoad,writeOrder');
    assert.equal(log.processesOf({ picksDay: 'Tue' }), 'picks');
    assert.equal(log.processesOf({}), '');
  });

  it('eventFromDraft flags redirect and carries summaries + notes', () => {
    const ev = log.eventFromDraft(makeDraft(), { eventType: 'sealed', repEmail: 'b@x.com' });
    assert.equal(ev.redirected, true);
    assert.equal(ev.actual_store, 215);
    assert.equal(ev.scheduled_store, 391);
    assert.equal(ev.processes, 'workLoad,writeOrder');
    assert.equal(ev.outcome_summary, 'Worked load and wrote order');
    assert.equal(ev.variance_summary, 'Load was unusually large');
    assert.equal(ev.custom_note, 'freezer flooded');
    assert.equal(ev.next_visit_note, 'order more X next time');
    assert.equal(ev.mileage_miles, 3.6);
  });

  it('not redirected when actual === scheduled', () => {
    const ev = log.eventFromDraft(makeDraft({ scheduledStore: 215 }), {});
    assert.equal(ev.redirected, false);
  });
});

describe('shift-event-log — JSON fallback store', () => {
  it('recordShiftEvent then queryShiftEvents (range-filtered) round-trips', async () => {
    await log.recordShiftEvent(makeDraft(), { eventType: 'sealed' });
    await log.recordShiftEvent(makeDraft({ id: 'brian/2026-07-10-111', date: '2026-07-10', actualStore: 111 }), {
      eventType: 'sealed',
    });
    const all = await log.queryShiftEvents({});
    assert.equal(all.length, 2);
    const inRange = await log.queryShiftEvents({ start: '2026-07-08', end: '2026-07-08' });
    assert.equal(inRange.length, 1);
    assert.equal(inRange[0].actual_store, 215);
  });

  it('transmitted event upserts the same draft_id (enriches, does not duplicate)', async () => {
    await log.recordShiftEvent(makeDraft(), { eventType: 'transmitted', visitId: 27000510, shiftId: 44390825 });
    const all = await log.queryShiftEvents({ start: '2026-07-08', end: '2026-07-08' });
    assert.equal(all.length, 1); // still one row for that draft_id
    assert.equal(all[0].event_type, 'transmitted');
    assert.equal(all[0].visit_id, 27000510);
  });

  it('store notes: add, list active, resolve', async () => {
    const n = await log.addStoreNote({ store: 215, note: 'extra pads on top stock', rep: 'brian' });
    let active = await log.listActiveStoreNotes(215);
    assert.ok(active.some((x) => x.note === 'extra pads on top stock'));
    await log.resolveStoreNote(n.id, 'kim');
    active = await log.listActiveStoreNotes(215);
    assert.ok(!active.some((x) => String(x.id) === String(n.id)));
  });

  it('store notes are store-scoped', async () => {
    await log.addStoreNote({ store: 999, note: 'store 999 note' });
    const forOther = await log.listActiveStoreNotes(215);
    assert.ok(!forOther.some((x) => x.note === 'store 999 note'));
  });
});
