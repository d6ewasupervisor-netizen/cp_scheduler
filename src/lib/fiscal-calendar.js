'use strict';

const FISCAL_2026 = {
  '05': {
    weeks: {
      '1': { start: '2026-05-24', end: '2026-05-30', label: 'P05W1' },
      '2': { start: '2026-05-31', end: '2026-06-06', label: 'P05W2' },
      '3': { start: '2026-06-07', end: '2026-06-13', label: 'P05W3' },
      '4': { start: '2026-06-14', end: '2026-06-20', label: 'P05W4' },
    },
  },
  '06': {
    weeks: {
      '1': { start: '2026-06-21', end: '2026-06-27', label: 'P06W1' },
      '2': { start: '2026-06-28', end: '2026-07-04', label: 'P06W2' },
      '3': { start: '2026-07-05', end: '2026-07-11', label: 'P06W3' },
      '4': { start: '2026-07-12', end: '2026-07-18', label: 'P06W4' },
    },
  },
  '07': {
    weeks: {
      '1': { start: '2026-07-19', end: '2026-07-25', label: 'P07W1' },
      '2': { start: '2026-07-26', end: '2026-08-01', label: 'P07W2' },
      '3': { start: '2026-08-02', end: '2026-08-08', label: 'P07W3' },
      '4': { start: '2026-08-09', end: '2026-08-15', label: 'P07W4' },
    },
  },
};

function listWeeks() {
  const out = [];
  for (const period of Object.values(FISCAL_2026)) {
    for (const w of Object.values(period.weeks)) {
      out.push({ label: w.label, start: w.start, end: w.end });
    }
  }
  return out;
}

function getWeekByStart(startDate) {
  for (const w of listWeeks()) {
    if (w.start === startDate) return w;
  }
  return null;
}

function getWeekForDate(dateStr) {
  for (const w of listWeeks()) {
    if (dateStr >= w.start && dateStr <= w.end) return w;
  }
  return null;
}

function dateToDayOfWeek(dateStr) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const d = new Date(`${dateStr}T12:00:00`);
  return names[d.getDay()];
}

function dayToDateInWeek(weekStart, dayName) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const target = names.indexOf(dayName);
  if (target < 0) return null;
  const start = new Date(`${weekStart}T12:00:00`);
  const startDow = start.getDay();
  let delta = target - startDow;
  if (delta < 0) delta += 7;
  const out = new Date(start);
  out.setDate(out.getDate() + delta);
  return out.toISOString().slice(0, 10);
}

module.exports = {
  listWeeks,
  getWeekByStart,
  getWeekForDate,
  dateToDayOfWeek,
  dayToDateInWeek,
};
