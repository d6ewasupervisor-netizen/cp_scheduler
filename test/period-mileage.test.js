'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  calcPeriodMileage,
  defaultGetEid,
  defaultGetDate,
} = require('../src/lib/period-mileage');

const JAMES = '800627385';
const BRIAN = '800553343';

function visit(overrides) {
  return {
    workday_given_id: JAMES,
    scheduled_date: '2026-07-08',
    store_number: 53,
    shift_start_time: '06:00 AM',
    current_status: 'completed',
    ...overrides,
  };
}

describe('defaultGetEid / defaultGetDate', () => {
  it('prefers workday_given_id over nested / internal ids', () => {
    assert.equal(
      defaultGetEid({
        workday_given_id: '800553343',
        id: 354456,
        employee: { id: 354456, workday_given_id: '800553343' },
        employee_id: 354456,
      }),
      '800553343'
    );
    assert.equal(
      defaultGetEid({ employee: { workday_given_id: BRIAN, id: 99 } }),
      BRIAN
    );
    // Must NOT treat internal SAS id as the mileage EID
    assert.equal(defaultGetEid({ employee_id: 354456, id: 354456 }), '');
  });

  it('prefers actual_start_date then executed_date then scheduled_date', () => {
    assert.equal(
      defaultGetDate({
        actual_start_date: '2026-07-08',
        scheduled_date: '2026-07-07',
      }),
      '2026-07-08'
    );
    assert.equal(
      defaultGetDate({ executed_date: '2026-07-08', scheduled_date: '2026-07-07' }),
      '2026-07-08'
    );
    assert.equal(defaultGetDate({ scheduled_date: '2026-07-07' }), '2026-07-07');
  });
});

describe('calcPeriodMileage', () => {
  it('groups by date and sums resolved days', () => {
    const visits = [
      visit({ scheduled_date: '2026-07-07', store_number: 53 }), // James→53×2 = 6.8
      visit({ scheduled_date: '2026-07-08', store_number: 682, shift_start_time: '08:00 AM' }), // 3.5×2 = 7.0
      visit({
        workday_given_id: BRIAN,
        scheduled_date: '2026-07-07',
        store_number: 111,
      }), // other rep — ignored
    ];
    const r = calcPeriodMileage(JAMES, visits, '2026-07-07', '2026-07-08');
    assert.equal(r.days.length, 2);
    assert.equal(r.days[0].totalMiles, 6.8);
    assert.equal(r.days[1].totalMiles, 7.0);
    assert.equal(r.periodMiles, 13.8);
    assert.equal(r.complete, true);
    assert.deepEqual(r.daysWithheld, []);
  });

  it('marks period incomplete when a day is withheld', () => {
    const visits = [
      visit({ scheduled_date: '2026-07-07', store_number: 53 }),
      visit({ scheduled_date: '2026-07-08', store_number: 390 }), // out of D8
    ];
    const r = calcPeriodMileage(JAMES, visits, '2026-07-07', '2026-07-08');
    assert.equal(r.complete, false);
    assert.deepEqual(r.daysWithheld, ['2026-07-08']);
    assert.equal(r.periodMiles, 6.8); // floor: only resolved day
  });

  it('respects inclusive date bounds', () => {
    const visits = [
      visit({ scheduled_date: '2026-07-06', store_number: 53 }),
      visit({ scheduled_date: '2026-07-07', store_number: 53 }),
      visit({ scheduled_date: '2026-07-09', store_number: 53 }),
    ];
    const r = calcPeriodMileage(JAMES, visits, '2026-07-07', '2026-07-08');
    assert.equal(r.days.length, 1);
    assert.equal(r.days[0].date, '2026-07-07');
  });
});
