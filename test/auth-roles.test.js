'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cpSchedulerLayer, REP_LAYER_EMAILS } = require('../src/lib/cp-roles');
const { buildVisitBrief } = require('../src/lib/visit-instructions');

describe('cp-roles', () => {
  it('defaults rep layer to d6ewa.supervisor@gmail.com tester account', () => {
    assert.ok(REP_LAYER_EMAILS.includes('d6ewa.supervisor@gmail.com'));
    assert.equal(cpSchedulerLayer('d6ewa.supervisor@gmail.com'), 'rep');
    assert.equal(cpSchedulerLayer('tgauthier2011@gmail.com'), 'admin');
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
    const brief = buildVisitBrief(slot, { action: 'Service surge' });
    assert.ok(brief.some((l) => /Place on one of/i.test(l)));
    assert.ok(brief.some((l) => /1–2 hours/i.test(l)));
    assert.ok(!brief.some((l) => /06:00|14:30|8h/i.test(l)));
  });
});
