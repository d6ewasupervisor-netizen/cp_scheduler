'use strict';

/**
 * Mirrors public/shared.js resolveShiftScopeTags for Node tests.
 * Keep ordering contract: Delivers → Work Load → Write Order → Picks
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { deliveryDayFromText, decodeD8Note } = require('../src/lib/d8-note-decoder');
const { processFlagsFromSlot } = require('../src/lib/order-timing');

const FULL_DAY_NAMES = {
  Sun: 'Sunday',
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
};

function fullDayName(token) {
  if (!token) return null;
  const raw = String(token).trim();
  if (FULL_DAY_NAMES[raw]) return FULL_DAY_NAMES[raw];
  const hit = Object.values(FULL_DAY_NAMES).find((d) => d.toLowerCase() === raw.toLowerCase());
  return hit || raw;
}

function resolveShiftScopeTags(shift) {
  const slots = shift.masterRoute?.slots || [];
  const day = shift.dayOfWeek || null;
  const daySlot = day ? slots.find((x) => x.anchorServiceDay === day) || null : null;
  const slot = daySlot || slots[0] || null;
  const fromSlot = processFlagsFromSlot(daySlot);
  const workLoad = fromSlot ? fromSlot.workLoad : !!shift.workLoad;
  const writeOrder = fromSlot ? fromSlot.writeOrder : !!shift.writeOrder;

  let deliveryDay = shift.deliveryDay || null;
  let picksDay = shift.picksDay || null;
  if (!deliveryDay && shift.delivery) deliveryDay = deliveryDayFromText(shift.delivery);

  if (slot) {
    const idx = slot.visitIndex ?? 0;
    const prev = idx > 0 ? slots.find((x) => (x.visitIndex ?? 0) === idx - 1) || null : null;
    if (!picksDay && writeOrder && slot.pickDay) picksDay = slot.pickDay;
    if (!deliveryDay && workLoad) {
      deliveryDay = prev?.deliveryDay || slot.deliveryDay || null;
    }
  }

  const tags = [];
  if (workLoad) {
    const dayLabel = fullDayName(deliveryDay);
    tags.push({ key: 'delivers', label: dayLabel ? `Delivers ${dayLabel}` : 'Delivers TBD' });
    tags.push({ key: 'work_load', label: 'Work Load' });
  }
  if (writeOrder) {
    tags.push({ key: 'write_order', label: 'Write Order' });
    const pickLabel = fullDayName(picksDay);
    tags.push({ key: 'picks', label: pickLabel ? `Picks ${pickLabel}` : 'Picks TBD' });
  }
  return { tags, deliveryDay, picksDay, workLoad, writeOrder };
}

describe('shift scope surface pills', () => {
  it('orders Delivers → Work Load → Write Order → Picks for combined visit', () => {
    const { tags } = resolveShiftScopeTags({
      workLoad: true,
      writeOrder: true,
      deliveryDay: 'Mon',
      picksDay: 'Wed',
      dayOfWeek: 'Tue',
    });
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Delivers Monday', 'Work Load', 'Write Order', 'Picks Wednesday']
    );
  });

  it('work-load only shows Delivers + Work Load', () => {
    const { tags } = resolveShiftScopeTags({
      workLoad: true,
      writeOrder: false,
      deliveryDay: 'Thu',
      dayOfWeek: 'Thu',
    });
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Delivers Thursday', 'Work Load']
    );
  });

  it('write-order only shows Write Order + Picks', () => {
    const { tags } = resolveShiftScopeTags({
      workLoad: false,
      writeOrder: true,
      picksDay: 'Wed',
      dayOfWeek: 'Tue',
    });
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Write Order', 'Picks Wednesday']
    );
  });

  it('fills delivery/picks from master route when note fields missing', () => {
    const { tags, deliveryDay, picksDay } = resolveShiftScopeTags({
      workLoad: true,
      writeOrder: true,
      dayOfWeek: 'Mon',
      masterRoute: {
        slots: [
          {
            visitIndex: 0,
            anchorServiceDay: 'Mon',
            pickDay: 'Tue',
            deliveryDay: 'Wed',
            action: 'WORK LOAD/WRITE ORDER',
          },
        ],
      },
    });
    assert.equal(picksDay, 'Tue');
    assert.equal(deliveryDay, 'Wed');
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Delivers Wednesday', 'Work Load', 'Write Order', 'Picks Tuesday']
    );
  });

  it('work-load follow-up uses prior visit delivery day', () => {
    const { tags, deliveryDay } = resolveShiftScopeTags({
      workLoad: true,
      writeOrder: false,
      dayOfWeek: 'Thu',
      masterRoute: {
        slots: [
          {
            visitIndex: 0,
            anchorServiceDay: 'Tue',
            pickDay: 'Wed',
            deliveryDay: 'Thu',
            action: 'WRITE ORDER/SERVICE',
          },
          {
            visitIndex: 1,
            anchorServiceDay: 'Thu',
            pickDay: null,
            deliveryDay: null,
            action: 'WORK LOAD/SERVICE',
          },
        ],
      },
    });
    assert.equal(deliveryDay, 'Thu');
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Delivers Thursday', 'Work Load']
    );
  });

  it('682 Tue master route overrides stale note that claimed work load', () => {
    const { tags, workLoad, writeOrder } = resolveShiftScopeTags({
      workLoad: true,
      writeOrder: true,
      dayOfWeek: 'Tue',
      masterRoute: {
        slots: [
          {
            visitIndex: 0,
            anchorServiceDay: 'Tue',
            pickDay: 'Wed',
            deliveryDay: 'Thu',
            action: 'WRITE ORDER',
          },
          {
            visitIndex: 1,
            anchorServiceDay: 'Fri',
            pickDay: null,
            deliveryDay: null,
            action: 'WORK LOAD',
          },
        ],
      },
    });
    assert.equal(writeOrder, true);
    assert.equal(workLoad, false);
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Write Order', 'Picks Wednesday']
    );
  });

  it('682 Fri master route overrides stale note that claimed write order', () => {
    const { tags, workLoad, writeOrder, deliveryDay } = resolveShiftScopeTags({
      workLoad: true,
      writeOrder: true,
      dayOfWeek: 'Fri',
      masterRoute: {
        slots: [
          {
            visitIndex: 0,
            anchorServiceDay: 'Tue',
            pickDay: 'Wed',
            deliveryDay: 'Thu',
            action: 'WRITE ORDER',
          },
          {
            visitIndex: 1,
            anchorServiceDay: 'Fri',
            pickDay: null,
            deliveryDay: null,
            action: 'WORK LOAD',
          },
        ],
      },
    });
    assert.equal(writeOrder, false);
    assert.equal(workLoad, true);
    assert.equal(deliveryDay, 'Thu');
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Delivers Thursday', 'Work Load']
    );
  });

  it('note decoder feeds delivery day into tags', () => {
    const note =
      '***WRITE ORDER*** THIS IS FOR STORE 215 -\nDELIVERED YESTERDAY(MONDAY)/WORK LOAD/PICKS TUESDAY(TODAY)***WRITE ORDER***';
    const d = decodeD8Note(note, 391);
    const { tags } = resolveShiftScopeTags({
      workLoad: d.workLoad,
      writeOrder: d.writeOrder,
      delivery: d.delivery,
      deliveryDay: d.deliveryDay,
      picksDay: d.picksDay,
      dayOfWeek: 'Tue',
    });
    assert.deepEqual(
      tags.map((t) => t.label),
      ['Delivers Monday', 'Work Load', 'Write Order', 'Picks Tuesday']
    );
  });
});
