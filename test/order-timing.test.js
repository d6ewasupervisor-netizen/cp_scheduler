'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildVisitSlots } = require('../src/lib/master-route-constraints');

// Mirror shared.js order-timing helpers for Node tests (ESM in browser only).
function priorVisitDeliveryDay(slots, slot) {
  if (!slot || !slots?.length) return null;
  const idx = slot.visitIndex ?? 0;
  if (idx === 0) return slot.deliveryDay || null;
  const prev = slots.find(
    (s) => s.storeNum === slot.storeNum && (s.visitIndex ?? 0) === idx - 1
  );
  return prev?.deliveryDay || null;
}

function isWorkLoadVisit(slot) {
  if (!slot || slot.pickDay || slot.deliveryDay) return false;
  const action = (slot.action || '').toUpperCase();
  return action.includes('WORK LOAD') || (slot.visitIndex ?? 0) > 0;
}

function isWriteOrderVisit(slot) {
  if (!slot?.pickDay) return false;
  const action = (slot.action || '').toUpperCase();
  return action.includes('WRITE ORDER') || action.includes('WORK LOAD/WRITE ORDER');
}

function orderTimingLine(slot, slots) {
  if (!slot) return '';
  if (isWriteOrderVisit(slot)) return `Order picks ${slot.pickDay}`;
  if (isWorkLoadVisit(slot)) {
    const delivered = priorVisitDeliveryDay(slots, slot);
    if (delivered) return `Order delivered ${delivered}`;
  }
  return '';
}

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
});
