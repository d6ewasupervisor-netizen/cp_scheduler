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

  it('682 Tue uses master-route write-order-only even when notes claim work load', () => {
    // 2026-07-21 is a Tuesday
    const shifts = prodRowsToShifts([
      {
        visitId: 1,
        shiftId: 2,
        date: '2026-07-21',
        scheduledStore: 682,
        actualStore: 682,
        redirected: false,
        writeOrder: true,
        workLoad: true,
        workdayGivenId: '1',
        repKey: 'brian-campbell',
        empName: 'Brian Campbell',
        visitStatus: 'in-progress',
      },
    ]);
    assert.equal(shifts[0].dayOfWeek, 'Tue');
    assert.equal(shifts[0].writeOrder, true);
    assert.equal(shifts[0].workLoad, false);
  });

  it('682 Fri uses master-route work-load-only even when notes claim write order', () => {
    // 2026-07-24 is a Friday
    const shifts = prodRowsToShifts([
      {
        visitId: 3,
        shiftId: 4,
        date: '2026-07-24',
        scheduledStore: 682,
        actualStore: 682,
        redirected: false,
        writeOrder: true,
        workLoad: true,
        workdayGivenId: '1',
        repKey: 'brian-campbell',
        empName: 'Brian Campbell',
        visitStatus: 'not started',
      },
    ]);
    assert.equal(shifts[0].dayOfWeek, 'Fri');
    assert.equal(shifts[0].writeOrder, false);
    assert.equal(shifts[0].workLoad, true);
  });
});
