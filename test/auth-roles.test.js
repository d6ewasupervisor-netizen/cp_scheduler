'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  cpSchedulerLayer,
  REP_LAYER_EMAILS,
  ADMIN_EMAILS,
} = require('../src/lib/cp-roles');
const { buildVisitBrief } = require('../src/lib/visit-instructions');

describe('cp-roles', () => {
  it('treats supervisor / Tyson accounts as full admin', () => {
    assert.ok(ADMIN_EMAILS.includes('tyson.gauthier@retailodyssey.com'));
    assert.ok(ADMIN_EMAILS.includes('d6ewa.supervisor@gmail.com'));
    assert.ok(ADMIN_EMAILS.includes('tgauthier2011@gmail.com'));
    assert.equal(cpSchedulerLayer('tyson.gauthier@retailodyssey.com'), 'admin');
    assert.equal(cpSchedulerLayer('d6ewa.supervisor@gmail.com'), 'admin');
    assert.equal(cpSchedulerLayer('tgauthier2011@gmail.com'), 'admin');
  });

  it('maps D8 field reps to rep layer only', () => {
    assert.ok(REP_LAYER_EMAILS.includes('bcampb9565@sbcglobal.net'));
    assert.ok(REP_LAYER_EMAILS.includes('kimberlyjanellclaf@gmail.com'));
    assert.ok(REP_LAYER_EMAILS.includes('james.duchene@retailodyssey.com'));
    assert.equal(cpSchedulerLayer('bcampb9565@sbcglobal.net'), 'rep');
    assert.equal(cpSchedulerLayer('kimberlyjanellclaf@gmail.com'), 'rep');
    assert.equal(cpSchedulerLayer('james.duchene@retailodyssey.com'), 'rep');
    assert.equal(cpSchedulerLayer('patricia.marks@youradv.com'), 'rep');
  });

  it('does not treat d6ewa.supervisor as rep by default', () => {
    assert.ok(!REP_LAYER_EMAILS.includes('d6ewa.supervisor@gmail.com'));
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
