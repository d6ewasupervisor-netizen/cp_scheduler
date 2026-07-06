'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeAllowedDaysForVisit,
  sortVisitsByServiceDay,
  buildVisitSlots,
  validatePlacements,
} = require('../src/lib/master-route-constraints');

describe('master-route-constraints', () => {
  it('store 733 pattern — two populated visits', () => {
    const visits = sortVisitsByServiceDay([
      { serviceDay: 'Mon', pickDay: 'Wed', deliveryDay: 'Thu' },
      { serviceDay: 'Thu', pickDay: 'Fri', deliveryDay: 'Mon' },
    ]);
    const first = computeAllowedDaysForVisit(visits, 0);
    const last = computeAllowedDaysForVisit(visits, 1);
    assert.deepEqual(first, ['Mon', 'Tue', 'Wed']);
    assert.deepEqual(last, ['Thu', 'Fri']);
  });

  it('store 744 pattern — blank pick/delivery on second visit', () => {
    const visits = sortVisitsByServiceDay([
      { serviceDay: 'Tue', pickDay: 'Wed', deliveryDay: 'Thu' },
      { serviceDay: 'Fri', pickDay: null, deliveryDay: null },
    ]);
    const first = computeAllowedDaysForVisit(visits, 0);
    const second = computeAllowedDaysForVisit(visits, 1);
    assert.ok(first.includes('Mon') && first.includes('Wed'));
    assert.ok(second.includes('Thu') && second.includes('Fri'));
  });

  it('store 755 pattern — single visit', () => {
    const visits = [{ serviceDay: 'Wed', pickDay: 'Mon', deliveryDay: 'Tue' }];
    const allowed = computeAllowedDaysForVisit(visits, 0);
    assert.ok(allowed.includes('Tue') && allowed.includes('Wed') && allowed.includes('Fri'));
  });

  it('real store 220 — Tue and Fri from Carr rows', () => {
    const slots = buildVisitSlots([
      { storeNum: 220, account: 'FM 00220 NEWBERG', serviceDay: 'Tue', pickDay: 'Tue', deliveryDay: 'Thu', action: 'WRITE ORDER/SERVICE' },
      { storeNum: 220, account: 'FM 00220 NEWBERG', serviceDay: 'Fri', pickDay: null, deliveryDay: null, action: 'WORK LOAD/SERVICE' },
    ]);
    assert.equal(slots.length, 2);
    assert.ok(slots[0].allowedDays.includes('Tue'));
    assert.ok(slots[1].allowedDays.includes('Thu'));
  });

  it('validatePlacements flags invalid day', () => {
    const slots = buildVisitSlots([
      { storeNum: 40, serviceDay: 'Tue', pickDay: 'Fri', deliveryDay: 'Thu', action: 'x' },
    ]);
    const { results, allValid } = validatePlacements(slots, [
      { storeNum: 40, visitIndex: 0, dayOfWeek: 'Mon' },
    ]);
    assert.equal(allValid, false);
    assert.equal(results[0].valid, false);
  });

  it('validatePlacements warns at 4+ visits on one day', () => {
    const slots = buildVisitSlots([
      { storeNum: 1, serviceDay: 'Mon', pickDay: 'Mon', deliveryDay: 'Tue', action: 'x' },
      { storeNum: 2, serviceDay: 'Mon', pickDay: 'Mon', deliveryDay: 'Tue', action: 'x' },
      { storeNum: 3, serviceDay: 'Mon', pickDay: 'Mon', deliveryDay: 'Tue', action: 'x' },
      { storeNum: 4, serviceDay: 'Mon', pickDay: 'Mon', deliveryDay: 'Tue', action: 'x' },
    ]);
    const { warnings } = validatePlacements(slots, [
      { storeNum: 1, visitIndex: 0, dayOfWeek: 'Mon' },
      { storeNum: 2, visitIndex: 0, dayOfWeek: 'Mon' },
      { storeNum: 3, visitIndex: 0, dayOfWeek: 'Mon' },
      { storeNum: 4, visitIndex: 0, dayOfWeek: 'Mon' },
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].storeCount, 4);
  });

  it('validatePlacements does not warn for 3 visits on one day', () => {
    const slots = buildVisitSlots([
      { storeNum: 1, serviceDay: 'Mon', pickDay: 'Mon', deliveryDay: 'Tue', action: 'x' },
      { storeNum: 2, serviceDay: 'Mon', pickDay: 'Mon', deliveryDay: 'Tue', action: 'x' },
      { storeNum: 3, serviceDay: 'Mon', pickDay: 'Mon', deliveryDay: 'Tue', action: 'x' },
    ]);
    const { warnings } = validatePlacements(slots, [
      { storeNum: 1, visitIndex: 0, dayOfWeek: 'Mon' },
      { storeNum: 2, visitIndex: 0, dayOfWeek: 'Mon' },
      { storeNum: 3, visitIndex: 0, dayOfWeek: 'Mon' },
    ]);
    assert.equal(warnings.length, 0);
  });
});
