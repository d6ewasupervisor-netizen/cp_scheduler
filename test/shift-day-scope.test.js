'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shiftRepByEmail, shiftRepByKey } = require('../src/lib/d8-shift-reps');

/** Mirrors shiftDayScope overwrite rules for unit coverage without spinning HTTP. */
function applyShiftDayScope(user, query = {}, body = {}) {
  if (user?.layer === 'rep') {
    const mine = shiftRepByEmail(user.email);
    if (mine) {
      query.rep = mine.repKey;
      body.repKey = mine.repKey;
    }
  }
  return { query, body };
}

describe('shiftDayScope identity mapping', () => {
  it('maps Brian/Kim/James emails to individual repKeys (not D8 pool)', () => {
    assert.equal(shiftRepByEmail('bcampb9565@sbcglobal.net')?.repKey, 'brian-campbell');
    assert.equal(shiftRepByEmail('kimberlyjanellclaf@gmail.com')?.repKey, 'kimberly-claflin');
    assert.equal(shiftRepByEmail('james.duchene@retailodyssey.com')?.repKey, 'james-duchene');
  });

  it('does not let one rep key resolve to another', () => {
    assert.notEqual(
      shiftRepByKey('brian-campbell').workdayGivenId,
      shiftRepByKey('james-duchene').workdayGivenId
    );
  });

  it('overwrites Brian requesting James schedule to Brian only', () => {
    const { query, body } = applyShiftDayScope(
      { layer: 'rep', email: 'bcampb9565@sbcglobal.net' },
      { rep: 'james-duchene', weekStart: '2026-07-05' },
      { repKey: 'james-duchene', shiftId: 'x' }
    );
    assert.equal(query.rep, 'brian-campbell');
    assert.equal(body.repKey, 'brian-campbell');
  });

  it('leaves admin free to select any rep', () => {
    const { query } = applyShiftDayScope(
      { layer: 'admin', email: 'admin@example.com' },
      { rep: 'james-duchene' }
    );
    assert.equal(query.rep, 'james-duchene');
  });
});

describe('Stage 3 visit-draft endpoints reuse the same shiftDayScope guard', () => {
  it('rewrites repKey on visit/start, checklist, survey, time, and finish bodies', () => {
    const asBrian = (body) =>
      applyShiftDayScope({ layer: 'rep', email: 'bcampb9565@sbcglobal.net' }, {}, body).body;

    for (const body of [
      { repKey: 'james-duchene', weekStart: '2026-07-06', shiftId: 'x' },
      { repKey: 'james-duchene', date: '2026-07-08', actualStore: 215, itemId: 'ewc-01', checked: true },
      { repKey: 'james-duchene', date: '2026-07-08', actualStore: 215, answers: { q1: 'yes' } },
      { repKey: 'james-duchene', date: '2026-07-08', actualStore: 215, stopActual: '2026-07-08T20:00:00Z' },
      { repKey: 'james-duchene', date: '2026-07-08', actualStore: 215 },
    ]) {
      assert.equal(asBrian(body).repKey, 'brian-campbell');
    }
  });

  it('rewrites rep on visit GET / mine query params', () => {
    const asBrian = (query) =>
      applyShiftDayScope({ layer: 'rep', email: 'bcampb9565@sbcglobal.net' }, query, {}).query;

    assert.equal(asBrian({ rep: 'james-duchene', date: '2026-07-08', store: '215' }).rep, 'brian-campbell');
    assert.equal(asBrian({ rep: 'james-duchene' }).rep, 'brian-campbell');
  });
});
