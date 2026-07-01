'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cpSchedulerLayer, REP_LAYER_EMAILS } = require('../src/lib/cp-roles');
const { buildVisitBrief } = require('../src/lib/visit-instructions');

describe('cp-roles', () => {
  it('defaults rep layer to tgauthier2011@gmail.com', () => {
    assert.ok(REP_LAYER_EMAILS.includes('tgauthier2011@gmail.com'));
    assert.equal(cpSchedulerLayer('tgauthier2011@gmail.com'), 'rep');
    assert.equal(cpSchedulerLayer('tyson.gauthier@retailodyssey.com'), 'admin');
  });
});

describe('visit-instructions', () => {
  it('builds actionable brief for a pick/delivery visit', () => {
    const slot = {
      storeNum: 220,
      visitIndex: 0,
      action: 'Service surge',
      anchorServiceDay: 'Tue',
      pickDay: 'Thu',
      deliveryDay: 'Wed',
      allowedDays: ['Tue', 'Wed', 'Thu'],
    };
    const brief = buildVisitBrief(slot, { shiftStart: '06:00', shiftEnd: '14:30' });
    assert.ok(brief.some((l) => /pick/i.test(l)));
    assert.ok(brief.some((l) => l.includes('06:00')));
  });
});
