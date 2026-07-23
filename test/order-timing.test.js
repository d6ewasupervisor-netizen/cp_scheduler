'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildVisitSlots } = require('../src/lib/master-route-constraints');
const {
  orderTimingLine,
  processFlagsFromSlot,
  resolveProcessFlags,
} = require('../src/lib/order-timing');
const { visitSlotsForStore } = require('../src/lib/master-route');

describe('order-timing', () => {
  const slots = buildVisitSlots([
    {
      storeNum: 220,
      serviceDay: 'Tue',
      pickDay: 'Tue',
      deliveryDay: 'Thu',
      action: 'WRITE ORDER/SERVICE',
    },
    {
      storeNum: 220,
      serviceDay: 'Fri',
      pickDay: null,
      deliveryDay: null,
      action: 'WORK LOAD/SERVICE',
    },
  ]);

  it('write-order visit shows pick day', () => {
    assert.equal(orderTimingLine(slots[0], slots), 'Order picks Tue');
  });

  it('work-load follow-up shows prior delivery day', () => {
    assert.equal(orderTimingLine(slots[1], slots), 'Order delivered Thu');
  });

  it('processFlagsFromSlot separates write-order vs work-load actions', () => {
    assert.deepEqual(processFlagsFromSlot(slots[0]), { writeOrder: true, workLoad: false });
    assert.deepEqual(processFlagsFromSlot(slots[1]), { writeOrder: false, workLoad: true });
  });

  it('combined WORK LOAD/WRITE ORDER keeps both flags', () => {
    const slot = buildVisitSlots([
      {
        storeNum: 19,
        serviceDay: 'Tue',
        pickDay: 'Wed',
        deliveryDay: 'Thu',
        action: 'WORK LOAD/WRITE ORDER',
      },
    ])[0];
    assert.deepEqual(processFlagsFromSlot(slot), { writeOrder: true, workLoad: true });
  });
});

describe('store 682 one-delivery cadence', () => {
  it('master route: Tue write-order only, Fri work-load only (Thu delivery)', () => {
    const slots = visitSlotsForStore(682);
    assert.equal(slots.length, 2);
    assert.equal(slots[0].anchorServiceDay, 'Tue');
    assert.equal(slots[0].action, 'WRITE ORDER');
    assert.equal(slots[0].pickDay, 'Wed');
    assert.equal(slots[0].deliveryDay, 'Thu');
    assert.deepEqual(processFlagsFromSlot(slots[0]), { writeOrder: true, workLoad: false });

    assert.equal(slots[1].anchorServiceDay, 'Fri');
    assert.equal(slots[1].action, 'WORK LOAD');
    assert.deepEqual(processFlagsFromSlot(slots[1]), { writeOrder: false, workLoad: true });
    assert.equal(orderTimingLine(slots[1], slots), 'Order delivered Thu');
  });

  it('stale PROD notes cannot force both flags on Tue or Fri', () => {
    const slots = visitSlotsForStore(682);
    const tue = resolveProcessFlags({
      slots,
      dayOfWeek: 'Tue',
      writeOrder: true,
      workLoad: true,
    });
    assert.equal(tue.writeOrder, true);
    assert.equal(tue.workLoad, false);
    assert.equal(tue.fromMasterRoute, true);

    const fri = resolveProcessFlags({
      slots,
      dayOfWeek: 'Fri',
      writeOrder: true,
      workLoad: true,
    });
    assert.equal(fri.writeOrder, false);
    assert.equal(fri.workLoad, true);
    assert.equal(fri.fromMasterRoute, true);
  });
});
