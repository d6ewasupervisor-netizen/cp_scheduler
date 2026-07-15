'use strict';

const storeMatrix = require('../../data/d8_mileage_matrix.json');
const homeMatrix = require('../../data/d8_home_to_store.json');

/**
 * Parse a clock / schedule time into minutes since midnight for sorting.
 * Accepts "05:00 AM", "06:01:00", and ISO "2026-07-08T13:01:00Z".
 */
function parseShiftTime(t) {
  if (!t) return Number.MAX_SAFE_INTEGER;
  const s = String(t).trim();

  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (ampm[3].toUpperCase() === 'PM') h += 12;
    return h * 60 + parseInt(ampm[2], 10);
  }

  const hms = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hms) {
    return parseInt(hms[1], 10) * 60 + parseInt(hms[2], 10);
  }

  // ISO / Date-parseable — use UTC clock minutes (SAS punches often Zulu).
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) {
    const d = new Date(ms);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  return Number.MAX_SAFE_INTEGER;
}

/**
 * Prefer actual punch time when present; fall back to scheduled start.
 */
function visitSortKey(v) {
  const actual = v.actual_start_time ?? v.actualStartTime;
  if (actual) return parseShiftTime(actual);
  return parseShiftTime(v.shift_start_time ?? v.shiftStart);
}

/**
 * Compute one rep's mileage for one day.
 *
 * Path: home → first store → … → last store → home.
 * Home↔store uses the home matrix (mirrored for return).
 * Store↔store uses the directed store matrix.
 *
 * If any leg is unresolved (null miles), totalMiles is null — do not
 * emit a partial sum that could look like a real reimbursement figure.
 *
 * @param {string} eid    - rep EID, e.g. "800627385"
 * @param {Array}  visits - that rep's visits for ONE date; each needs
 *                          { store_number, shift_start_time, current_status }
 *                          and preferably { actual_start_time } when punched
 * @param {Object} [opts] - { completedOnly = true }
 * @returns {{
 *   eid: string,
 *   sequence: number[],
 *   legs: Array<{from: string, to: string, miles: number|null}>,
 *   totalMiles: number|null,
 *   warnings: string[]
 * }}
 */
function calcDayMileage(eid, visits, opts = {}) {
  const { completedOnly = true } = opts;
  const warnings = [];
  const rep = homeMatrix.reps[eid];

  if (!rep) {
    return {
      eid,
      sequence: [],
      legs: [],
      totalMiles: 0,
      warnings: [
        `EID ${eid} not in home-to-store matrix — not a mileage rep or matrix needs rebuild`,
      ],
    };
  }

  const dayVisits = visits
    .filter((v) => !completedOnly || v.current_status === 'completed')
    .slice()
    .sort((a, b) => visitSortKey(a) - visitSortKey(b));

  const sequence = dayVisits.map((v) => Number(v.store_number));

  if (sequence.length === 0) {
    return {
      eid,
      sequence: [],
      legs: [],
      totalMiles: 0,
      warnings: ['No completed visits for this day'],
    };
  }

  const legs = [];

  const homeLeg = (storeNum, outbound) => {
    const miles = Object.prototype.hasOwnProperty.call(rep.miles, String(storeNum))
      ? rep.miles[String(storeNum)]
      : null;
    if (miles === null) {
      warnings.push(`No home leg for store ${storeNum} — rebuild home-to-store matrix`);
    }
    legs.push(
      outbound
        ? { from: 'home', to: String(storeNum), miles }
        : { from: String(storeNum), to: 'home', miles }
    );
  };

  homeLeg(sequence[0], true);

  for (let i = 0; i < sequence.length - 1; i += 1) {
    const from = sequence[i];
    const to = sequence[i + 1];
    if (from === to) {
      legs.push({ from: String(from), to: String(to), miles: 0 });
      continue;
    }
    const key = `${from}-${to}`;
    const miles = Object.prototype.hasOwnProperty.call(storeMatrix.matrix, key)
      ? storeMatrix.matrix[key]
      : null;
    if (miles === null) {
      warnings.push(`No store pair ${from}-${to} in matrix — store outside D8 set?`);
    }
    legs.push({ from: String(from), to: String(to), miles });
  }

  homeLeg(sequence[sequence.length - 1], false);

  const unresolved = legs.some((l) => l.miles == null);
  const totalMiles = unresolved
    ? null
    : Math.round(legs.reduce((sum, l) => sum + l.miles, 0) * 10) / 10;

  if (unresolved) {
    warnings.push('Day total withheld — one or more legs unresolved; enter mileage manually');
  }

  return { eid, sequence, legs, totalMiles, warnings };
}

module.exports = {
  parseShiftTime,
  visitSortKey,
  calcDayMileage,
  storeMatrix,
  homeMatrix,
};
