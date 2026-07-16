'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { prodRowsToShifts } = require('../src/lib/prod-week-sync');

describe('prodRowsToShifts', () => {
  it('maps prod field rows into shift-day store shape with visit/shift ids', () => {
    const shifts = prodRowsToShifts([
      {
        visitId: 27000977,
        shiftId: 44392384,
        date: '2026-07-15',
        scheduledStore: 391,
        actualStore: 53,
        redirected: true,
        writeOrder: true,
        workLoad: false,
        workdayGivenId: '800627385',
        repKey: 'james-duchene',
        empName: 'James Duchene Ryan',
        visitStatus: 'completed',
      },
    ]);
    assert.equal(shifts.length, 1);
    assert.equal(shifts[0].id, 'prod-27000977-44392384');
    assert.equal(shifts[0].actualStore, 53);
    assert.equal(shifts[0].scheduledStore, 391);
    assert.equal(shifts[0].visitId, 27000977);
    assert.equal(shifts[0].source, 'prod');
    assert.equal(shifts[0].redirected, true);
  });

  it('drops rows missing rep/date/store', () => {
    assert.equal(prodRowsToShifts([{ repKey: 'x', date: null, actualStore: 1 }]).length, 0);
  });
});
