'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { escapeCsvValue, toCsv, rowFromShiftEvent, shiftEventsCsv, hoursBetween } = require('../src/lib/shift-csv');

describe('shift-csv escaping (RFC-4180)', () => {
  it('leaves plain values untouched', () => {
    assert.equal(escapeCsvValue('215'), '215');
    assert.equal(escapeCsvValue('Worked load'), 'Worked load');
  });
  it('quotes and doubles quotes when value has comma/quote/newline', () => {
    assert.equal(escapeCsvValue('a,b'), '"a,b"');
    assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvValue('line1\nline2'), '"line1\nline2"');
  });
  it('renders null/undefined as empty string', () => {
    assert.equal(escapeCsvValue(null), '');
    assert.equal(escapeCsvValue(undefined), '');
  });
});

describe('toCsv', () => {
  it('emits a header row then one row per record, CRLF-terminated', () => {
    const cols = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ];
    const csv = toCsv([{ a: '1', b: 'x,y' }], cols);
    assert.equal(csv, 'A,B\r\n1,"x,y"\r\n');
  });
});

describe('hoursBetween', () => {
  it('computes decimal hours', () => {
    assert.equal(hoursBetween('2026-07-08T13:00:00Z', '2026-07-08T18:30:00Z'), '5.50');
  });
  it('returns empty when either bound missing or non-positive', () => {
    assert.equal(hoursBetween(null, '2026-07-08T18:00:00Z'), '');
    assert.equal(hoursBetween('2026-07-08T18:00:00Z', '2026-07-08T13:00:00Z'), '');
  });
});

describe('rowFromShiftEvent', () => {
  const ev = {
    shift_date: '2026-07-08',
    rep_key: 'brian-campbell',
    scheduled_store: 391,
    actual_store: 215,
    redirected: true,
    processes: 'workLoad,writeOrder',
    start_actual: '2026-07-08T13:00:00Z',
    stop_actual: '2026-07-08T18:00:00Z',
    mileage_miles: 3.6,
    outcome_summary: 'Worked load and wrote order',
    variance_summary: 'Load was unusually large',
    custom_note: 'freezer flooded',
    next_visit_note: 'order more X',
    stage_notes: { load_check: { text: 'receiver slow' }, survey: 'n/a' },
    survey: { q1: 'yes', q3: 'Fully stocked' },
    visit_id: 27000510,
    shift_id: 44390825,
    event_type: 'transmitted',
    sealed_at: '2026-07-08T18:05:00Z',
    transmitted_at: '2026-07-08T18:10:00Z',
  };

  it('flattens the redirected flag, hours, notes and survey', () => {
    const row = rowFromShiftEvent(ev);
    assert.equal(row.redirected, 'yes');
    assert.equal(row.hours, '5.00');
    assert.equal(row.actual_store, 215);
    assert.equal(row.scheduled_store, 391);
    assert.match(row.stage_notes, /\[load_check\] receiver slow/);
    assert.match(row.survey_summary, /q1=yes/);
    assert.equal(row.visit_id, 27000510);
  });

  it('parses JSON-string JSONB fields (pg text form)', () => {
    const row = rowFromShiftEvent({ ...ev, stage_notes: JSON.stringify(ev.stage_notes), survey: JSON.stringify(ev.survey) });
    assert.match(row.stage_notes, /receiver slow/);
    assert.match(row.survey_summary, /q3=Fully stocked/);
  });

  it('date-only shift_date even when a full timestamp comes back', () => {
    const row = rowFromShiftEvent({ ...ev, shift_date: '2026-07-08T00:00:00.000Z' });
    assert.equal(row.shift_date, '2026-07-08');
  });
});

describe('shiftEventsCsv end-to-end', () => {
  it('produces a header + one line per event', () => {
    const csv = shiftEventsCsv([
      { shift_date: '2026-07-08', rep_key: 'r', actual_store: 215, scheduled_store: 391, redirected: true },
    ]);
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Date,Rep,Scheduled Store,Actual Store,Redirected,/);
    assert.match(lines[1], /2026-07-08,r,391,215,yes/);
  });
});
