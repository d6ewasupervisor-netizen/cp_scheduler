'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isCoverageNeeded,
  countCoverageNeeded,
  normalizeRepAvailability,
  REP_AVAILABILITY,
} = require('../src/lib/rep-availability');

describe('rep-availability', () => {
  it('flags not_available as coverage needed', () => {
    assert.equal(isCoverageNeeded({ repAvailability: REP_AVAILABILITY.NOT_AVAILABLE }), true);
    assert.equal(isCoverageNeeded({ repAvailability: REP_AVAILABILITY.AVAILABLE }), false);
    assert.equal(isCoverageNeeded({}), false);
  });

  it('counts coverage visits', () => {
    const placements = [
      { repAvailability: REP_AVAILABILITY.AVAILABLE },
      { repAvailability: REP_AVAILABILITY.NOT_AVAILABLE },
      { repAvailability: REP_AVAILABILITY.NOT_AVAILABLE },
    ];
    assert.equal(countCoverageNeeded(placements), 2);
  });

  it('normalizes unknown values to available', () => {
    assert.equal(normalizeRepAvailability(undefined), REP_AVAILABILITY.AVAILABLE);
    assert.equal(normalizeRepAvailability(''), REP_AVAILABILITY.AVAILABLE);
  });
});
