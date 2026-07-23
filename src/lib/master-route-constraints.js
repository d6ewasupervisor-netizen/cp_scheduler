'use strict';

const { DAY_INDEX, WORK_DAYS } = require('./constants');

function sortVisitsByServiceDay(visits) {
  return [...visits].sort(
    (a, b) => (DAY_INDEX[a.serviceDay] ?? 99) - (DAY_INDEX[b.serviceDay] ?? 99)
  );
}

function dayRangeInclusive(fromDay, toDay, workDaysOnly = true) {
  const days = workDaysOnly ? WORK_DAYS : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const from = DAY_INDEX[fromDay];
  const to = DAY_INDEX[toDay];
  if (from == null || to == null) return [];
  if (from <= to) return days.filter((d) => DAY_INDEX[d] >= from && DAY_INDEX[d] <= to);
  return days.filter((d) => DAY_INDEX[d] >= from || DAY_INDEX[d] <= to);
}

/**
 * Compute allowed service days for one visit row using Master Route rules.
 * @param {object[]} sortedVisits - rows for same store+rep, sorted by service day
 * @param {number} visitIndex - index in sortedVisits
 */
function computeAllowedDaysForVisit(sortedVisits, visitIndex) {
  const visit = sortedVisits[visitIndex];
  const n = sortedVisits.length;
  const hasPick = !!visit.pickDay;
  const hasDelivery = !!visit.deliveryDay;

  // Case B: second visit, blank pick/delivery (work load only)
  if (!hasPick && !hasDelivery && n >= 2) {
    const serviceIdx = DAY_INDEX[visit.serviceDay];
    if (serviceIdx == null) return [...WORK_DAYS];
    const fromIdx = Math.max(0, serviceIdx - 1);
    return WORK_DAYS.filter((d) => DAY_INDEX[d] >= fromIdx && DAY_INDEX[d] <= DAY_INDEX.Fri);
  }

  // Case C: single visit
  if (n === 1) {
    let earliest = visit.deliveryDay || visit.serviceDay || 'Mon';
    let latest = 'Fri';
    if (hasPick && DAY_INDEX[visit.pickDay] > DAY_INDEX[visit.serviceDay]) {
      latest = visit.pickDay;
    }
    if (DAY_INDEX[earliest] > DAY_INDEX[latest]) {
      return dayRangeInclusive(earliest, 'Fri');
    }
    return dayRangeInclusive(earliest, latest);
  }

  // Case A: multi-visit
  const isFirst = visitIndex === 0;
  const isLast = visitIndex === n - 1;
  const prev = isFirst ? sortedVisits[n - 1] : sortedVisits[visitIndex - 1];

  let earliest = 'Mon';
  if (prev?.deliveryDay) {
    if (isFirst && DAY_INDEX[prev.deliveryDay] <= DAY_INDEX[visit.serviceDay]) {
      earliest = prev.deliveryDay;
    } else if (!isFirst) {
      earliest = prev.deliveryDay;
    } else {
      earliest = prev.deliveryDay;
    }
  }

  let latest = visit.pickDay || 'Fri';
  if (DAY_INDEX[latest] < DAY_INDEX[earliest]) {
    latest = 'Fri';
  }

  let allowed = dayRangeInclusive(earliest, latest);

  if (isLast && prev?.deliveryDay && !isFirst) {
    const floor = prev.deliveryDay;
    allowed = allowed.filter((d) => DAY_INDEX[d] >= (DAY_INDEX[floor] ?? 0));
  }

  if (allowed.length === 0 && visit.serviceDay) {
    allowed = [visit.serviceDay];
  }

  return allowed;
}

function buildVisitSlots(storeRows) {
  const sorted = sortVisitsByServiceDay(storeRows);
  return sorted.map((row, index) => {
    const allowedDays = computeAllowedDaysForVisit(sorted, index);
    return {
      storeNum: row.storeNum,
      account: row.account,
      visitIndex: index,
      action: row.action,
      cadence: row.cadence || null,
      anchorServiceDay: row.serviceDay,
      pickDay: row.pickDay,
      deliveryDay: row.deliveryDay,
      allowedDays,
      reason: `anchor=${row.serviceDay}, pick=${row.pickDay || '-'}, deliver=${row.deliveryDay || '-'}, allowed=${allowedDays.join('/')}`,
    };
  });
}

function isDayAllowed(slot, dayName) {
  return slot.allowedDays.includes(dayName);
}

function validatePlacements(slots, placements) {
  const slotByKey = new Map(slots.map((s) => [`${s.storeNum}:${s.visitIndex}`, s]));
  const results = [];
  const byDay = {};

  for (const p of placements) {
    const key = `${p.storeNum}:${p.visitIndex ?? 0}`;
    const slot = slotByKey.get(key) || slots.find((s) => s.storeNum === p.storeNum);
    const dayName = p.dayOfWeek || p.dow;
    const valid = slot ? isDayAllowed(slot, dayName) : false;
    results.push({
      ...p,
      valid,
      slot,
      message: valid
        ? 'OK'
        : `Store ${p.storeNum} not allowed on ${dayName}; allowed: ${slot?.allowedDays?.join(', ') || 'none'}`,
    });
    if (dayName) {
      if (!byDay[dayName]) byDay[dayName] = [];
      byDay[dayName].push(p.storeNum);
    }
  }

  const warnings = [];
  for (const [day, stores] of Object.entries(byDay)) {
    if (stores.length >= 4) {
      warnings.push({
        type: 'capacity',
        day,
        storeCount: stores.length,
        message: `${stores.length} visits scheduled on ${day} — check travel/time capacity`,
      });
    }
  }

  return { results, warnings, allValid: results.every((r) => r.valid) };
}

module.exports = {
  sortVisitsByServiceDay,
  computeAllowedDaysForVisit,
  buildVisitSlots,
  isDayAllowed,
  validatePlacements,
};
