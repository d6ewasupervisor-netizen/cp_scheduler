'use strict';

const PROJECT_ID = 9293;
const PROJECT_NAME = 'Central Pet Service Surge';

const D1 = new Set([
  4, 35, 40, 51, 60, 63, 143, 153, 218, 220, 240, 242, 285, 375, 377, 393, 462, 482, 516, 651,
  661, 694,
]);
const D8 = new Set([19, 23, 28, 31, 53, 111, 215, 391, 459, 658, 682]);

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_INDEX = Object.fromEntries(DAY_NAMES.map((d, i) => [d, i]));
const WORK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function districtForStore(n) {
  const num = Number(n);
  if (D1.has(num)) return 1;
  if (D8.has(num)) return 8;
  return null;
}

module.exports = {
  PROJECT_ID,
  PROJECT_NAME,
  D1,
  D8,
  DAY_NAMES,
  DAY_INDEX,
  WORK_DAYS,
  districtForStore,
};
