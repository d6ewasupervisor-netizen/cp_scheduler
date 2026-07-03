'use strict';

const REP_AVAILABILITY = {
  AVAILABLE: 'available',
  NOT_AVAILABLE: 'not_available',
};

const REP_AVAILABILITY_LABELS = {
  [REP_AVAILABILITY.AVAILABLE]: 'Available',
  [REP_AVAILABILITY.NOT_AVAILABLE]: 'Not Available',
};

function normalizeRepAvailability(value) {
  return value === REP_AVAILABILITY.NOT_AVAILABLE
    ? REP_AVAILABILITY.NOT_AVAILABLE
    : REP_AVAILABILITY.AVAILABLE;
}

function isCoverageNeeded(placement) {
  return normalizeRepAvailability(placement?.repAvailability) === REP_AVAILABILITY.NOT_AVAILABLE;
}

function countCoverageNeeded(placements) {
  return (placements || []).filter(isCoverageNeeded).length;
}

module.exports = {
  REP_AVAILABILITY,
  REP_AVAILABILITY_LABELS,
  normalizeRepAvailability,
  isCoverageNeeded,
  countCoverageNeeded,
};
