'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { calcDayMileage, parseShiftTime } = require('../src/lib/day-mileage');

const JAMES = '800627385';
const BRIAN = '800553343';
const ALEX = '800619482';

function visit(store, start, status = 'completed', extra = {}) {
  return {
    store_number: store,
    shift_start_time: start,
    current_status: status,
    ...extra,
  };
}

describe('parseShiftTime', () => {
  it('parses AM/PM', () => {
    assert.equal(parseShiftTime('05:00 AM'), 5 * 60);
    assert.equal(parseShiftTime('01:30 PM'), 13 * 60 + 30);
    assert.equal(parseShiftTime('12:00 PM'), 12 * 60);
    assert.equal(parseShiftTime('12:15 AM'), 15);
  });
});

describe('calcDayMileage', () => {
  it('unknown EID warns and returns zero', () => {
    const r = calcDayMileage('999', [visit(19, '08:00 AM')]);
    assert.equal(r.totalMiles, 0);
    assert.ok(r.warnings[0].includes('not in home-to-store'));
  });

  it('single completed store: home→store→home (mirrored)', () => {
    const r = calcDayMileage(JAMES, [visit(53, '08:00 AM')]);
    assert.deepEqual(r.sequence, [53]);
    assert.equal(r.legs.length, 2);
    assert.deepEqual(r.legs[0], { from: 'home', to: '53', miles: 3.4 });
    assert.deepEqual(r.legs[1], { from: '53', to: 'home', miles: 3.4 });
    assert.equal(r.totalMiles, 6.8);
    assert.deepEqual(r.warnings, []);
  });

  it('James multi-stop day uses store matrix between visits', () => {
    // home→53→682→home
    const r = calcDayMileage(JAMES, [
      visit(682, '11:00 AM'),
      visit(53, '06:00 AM'),
    ]);
    assert.deepEqual(r.sequence, [53, 682]);
    assert.equal(r.legs[0].miles, 3.4); // home→53
    assert.equal(r.legs[1].miles, 5.0); // 53→682
    assert.equal(r.legs[2].miles, 3.5); // 682→home
    assert.equal(r.totalMiles, 11.9);
  });

  it('Brian home→111 sanity (~4.8)', () => {
    const r = calcDayMileage(BRIAN, [visit(111, '07:00 AM')]);
    assert.equal(r.legs[0].miles, 4.8);
    assert.equal(r.totalMiles, 9.6);
  });

  it('Alexandra home→19 sanity (7.4)', () => {
    const r = calcDayMileage(ALEX, [visit(19, '07:00 AM')]);
    assert.equal(r.legs[0].miles, 7.4);
    assert.equal(r.totalMiles, 14.8);
  });

  it('skips non-completed by default', () => {
    const r = calcDayMileage(JAMES, [
      visit(53, '06:00 AM', 'scheduled'),
      visit(682, '10:00 AM', 'completed'),
    ]);
    assert.deepEqual(r.sequence, [682]);
    assert.equal(r.totalMiles, 7.0);
  });

  it('completedOnly=false includes all visits', () => {
    const r = calcDayMileage(
      JAMES,
      [visit(53, '06:00 AM', 'scheduled'), visit(682, '10:00 AM', 'completed')],
      { completedOnly: false }
    );
    assert.deepEqual(r.sequence, [53, 682]);
  });

  it('same-store consecutive visits add a 0-mile leg', () => {
    const r = calcDayMileage(JAMES, [
      visit(53, '06:00 AM'),
      visit(53, '01:00 PM'),
    ]);
    assert.deepEqual(r.legs[1], { from: '53', to: '53', miles: 0 });
    assert.equal(r.totalMiles, 6.8);
  });

  it('uses hand-corrected 459→53 (12.9 not 21.9)', () => {
    const r = calcDayMileage(JAMES, [
      visit(459, '06:00 AM'),
      visit(53, '10:00 AM'),
    ]);
    assert.equal(r.legs[1].miles, 12.9);
  });

  it('prefers actual_start_time over identical scheduled starts', () => {
    const r = calcDayMileage(JAMES, [
      visit(682, '06:00 AM', 'completed', { actual_start_time: '11:01:00' }),
      visit(53, '06:00 AM', 'completed', { actual_start_time: '06:01:00' }),
    ]);
    assert.deepEqual(r.sequence, [53, 682]);
  });

  it('returns totalMiles null when any leg is unresolved', () => {
    const r = calcDayMileage(JAMES, [
      visit(53, '06:00 AM'),
      visit(390, '10:00 AM'), // Tacoma — outside D8 matrix
    ]);
    assert.equal(r.totalMiles, null);
    assert.ok(r.legs.some((l) => l.miles == null));
    assert.ok(r.warnings.some((w) => /withheld/i.test(w)));
  });
});
