'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { listWeeks, MIN_WEEK_LABEL, getWeekByStart } = require('../src/lib/fiscal-calendar');
const { applyWeeklyTemplate, toTemplatePlacements } = require('../src/lib/weekly-template');

describe('fiscal-calendar', () => {
  it('starts at P06W2 and includes P08', () => {
    const weeks = listWeeks();
    assert.equal(weeks[0].label, MIN_WEEK_LABEL);
    assert.equal(weeks[0].start, '2026-06-28');
    assert.ok(weeks.some((w) => w.label === 'P08W4'));
    assert.equal(weeks[weeks.length - 1].label, 'P08W4');
    assert.equal(weeks.length, 11);
  });

  it('rejects weeks before P06W2', () => {
    assert.equal(getWeekByStart('2026-06-21'), null);
  });
});

describe('weekly-template', () => {
  it('remaps template days onto a new week', () => {
    const rep = {
      isD8Pool: false,
      visitSlots: [
        { storeNum: 40, visitIndex: 0, account: 'A', action: 'X', anchorServiceDay: 'Tue' },
        { storeNum: 60, visitIndex: 0, account: 'B', action: 'Y', anchorServiceDay: 'Thu' },
      ],
    };
    const template = toTemplatePlacements([
      {
        storeNum: 40,
        visitIndex: 0,
        dayOfWeek: 'Wed',
        account: 'A',
        action: 'X',
        scheduledDate: '2026-06-30',
      },
      {
        storeNum: 60,
        visitIndex: 0,
        dayOfWeek: 'Fri',
        account: 'B',
        action: 'Y',
        scheduledDate: '2026-07-02',
      },
    ]);

    const applied = applyWeeklyTemplate(template, rep, '2026-08-16');
    assert.equal(applied[0].dayOfWeek, 'Wed');
    assert.equal(applied[0].scheduledDate, '2026-08-19');
    assert.equal(applied[1].dayOfWeek, 'Fri');
    assert.equal(applied[1].scheduledDate, '2026-08-21');
  });
});
