'use strict';

/**
 * Decode D8 Central Pet placeholder visit notes into actionable fields.
 *
 * Live trap: scheduled store 391 with notes "THIS IS FOR STORE 215" means
 * mileage legs must use 215, not 391.
 *
 * Note source: GET /api/v1/field-app/visits/{visitId}/store-field/ → notes
 * (NOT store-notes/, which is often empty).
 */

const STORE_MARKER = /this\s+is\s+for\s+store\s+(\d{1,4})/i;
const WRITE_ORDER_YES = /(?<!do\s+not\s)\bwrite\s+order\b/i;
const WRITE_ORDER_NO = /do\s+not\s+write\s+order/i;
const WORK_LOAD = /work\s*load/i;
const PICKS_DAY = /picks?\s+([a-z]+)(?:\s*\([^)]*\))?/i;
const DELIVERED = /delivered\s+([^\n/*]+)/i;

const DAY_ALIASES = {
  mon: 'Mon',
  monday: 'Mon',
  tue: 'Tue',
  tues: 'Tue',
  tuesday: 'Tue',
  wed: 'Wed',
  wednesday: 'Wed',
  thu: 'Thu',
  thur: 'Thu',
  thurs: 'Thu',
  thursday: 'Thu',
  fri: 'Fri',
  friday: 'Fri',
  sat: 'Sat',
  saturday: 'Sat',
  sun: 'Sun',
  sunday: 'Sun',
  yesterday: null,
  today: null,
  tomorrow: null,
};

function normalizeDayToken(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DAY_ALIASES, key)) {
    return DAY_ALIASES[key];
  }
  return null;
}

/**
 * @param {string|null|undefined} notes
 * @param {number|string|null|undefined} scheduledStore - field-data / store-field store.number
 * @returns {{
 *   actualStore: number|null,
 *   scheduledStore: number|null,
 *   redirected: boolean,
 *   writeOrder: boolean|null,
 *   workLoad: boolean,
 *   delivery: string|null,
 *   picksDay: string|null,
 *   raw: string
 * }}
 */
function decodeD8Note(notes, scheduledStore = null) {
  const raw = notes == null ? '' : String(notes);
  const scheduled =
    scheduledStore == null || scheduledStore === ''
      ? null
      : Number(String(scheduledStore).replace(/\D/g, '')) || null;

  const storeMatch = raw.match(STORE_MARKER);
  const actualStore = storeMatch ? Number(storeMatch[1]) : scheduled;

  let writeOrder = null;
  if (WRITE_ORDER_NO.test(raw)) writeOrder = false;
  else if (/\*{3}\s*write\s+order\s*\*{3}/i.test(raw) || WRITE_ORDER_YES.test(raw)) {
    writeOrder = true;
  }

  const picksMatch = raw.match(PICKS_DAY);
  let picksDay = null;
  if (picksMatch) {
    picksDay = normalizeDayToken(picksMatch[1]);
    // Keep relative tokens as lowercase labels when not a weekday
    if (picksDay == null) {
      const rel = String(picksMatch[1]).trim().toLowerCase();
      if (['today', 'yesterday', 'tomorrow'].includes(rel)) picksDay = rel;
    }
  }

  const deliveryMatch = raw.match(DELIVERED);
  const delivery = deliveryMatch ? deliveryMatch[1].trim().replace(/\s+/g, ' ') : null;

  return {
    actualStore: Number.isFinite(actualStore) ? actualStore : null,
    scheduledStore: scheduled,
    redirected:
      actualStore != null &&
      scheduled != null &&
      Number(actualStore) !== Number(scheduled),
    writeOrder,
    workLoad: WORK_LOAD.test(raw),
    delivery,
    picksDay,
    raw,
  };
}

module.exports = {
  decodeD8Note,
  STORE_MARKER,
};
