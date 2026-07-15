'use strict';

const { calcDayMileage } = require('./day-mileage');

/**
 * Default accessors — Workday EID is the stable key used by
 * d8_home_to_store.json (e.g. "800553343"). Confirmed on field-app
 * shift-complete / employees payloads as `workday_given_id`.
 * Internal SAS `employee.id` (e.g. 354456) is a different namespace.
 */
const defaultGetEid = (v) =>
  String(
    v.workday_given_id ??
      v.employee?.workday_given_id ??
      v.rep_eid ??
      ''
  );

const defaultGetDate = (v) =>
  v.actual_start_date ||
  v.executed_date ||
  v.scheduled_date ||
  null;

/**
 * Compute a rep's mileage over a date range.
 *
 * @param {string} eid       - Workday EID (REP_HOME_ / home-matrix key)
 * @param {Array}  visits    - raw SAS visit/shift records (any reps, any dates)
 * @param {string} startDate - inclusive, "YYYY-MM-DD"
 * @param {string} endDate   - inclusive, "YYYY-MM-DD"
 * @param {Object} [opts]    - { getEid, getDate, completedOnly = true }
 * @returns {{
 *   eid: string,
 *   startDate: string,
 *   endDate: string,
 *   days: Array<{date: string, sequence: number[], legs: Array,
 *                totalMiles: number|null, warnings: string[]}>,
 *   periodMiles: number,
 *   daysWithheld: string[],
 *   complete: boolean
 * }}
 */
function calcPeriodMileage(eid, visits, startDate, endDate, opts = {}) {
  const {
    getEid = defaultGetEid,
    getDate = defaultGetDate,
    completedOnly = true,
  } = opts;

  const byDate = new Map();

  for (const v of visits) {
    if (getEid(v) !== String(eid)) continue;
    const date = getDate(v);
    if (!date || date < startDate || date > endDate) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(v);
  }

  const days = [...byDate.keys()]
    .sort()
    .map((date) => {
      const result = calcDayMileage(eid, byDate.get(date), { completedOnly });
      return { date, ...result };
    })
    .filter((d) => d.sequence.length > 0);

  const daysWithheld = days
    .filter((d) => d.totalMiles === null)
    .map((d) => d.date);

  const periodMiles =
    Math.round(
      days.reduce((sum, d) => sum + (d.totalMiles ?? 0), 0) * 10
    ) / 10;

  return {
    eid,
    startDate,
    endDate,
    days,
    periodMiles,
    daysWithheld,
    complete: daysWithheld.length === 0,
  };
}

module.exports = { calcPeriodMileage, defaultGetEid, defaultGetDate };
