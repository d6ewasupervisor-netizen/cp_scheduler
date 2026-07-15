'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/shift-day-schedules.json');

function readStore() {
  if (!fs.existsSync(FILE)) return { weeks: {} };
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function listWeekKeys() {
  return Object.keys(readStore().weeks || {}).sort();
}

function getWeekSchedule(weekStart) {
  return readStore().weeks?.[weekStart] || null;
}

function saveWeekSchedule(weekStart, payload) {
  const db = readStore();
  db.weeks = db.weeks || {};
  db.weeks[weekStart] = {
    weekStart,
    ...payload,
    updatedAt: new Date().toISOString(),
  };
  writeStore(db);
  return db.weeks[weekStart];
}

function getShiftsForRep(weekStart, repKey) {
  const week = getWeekSchedule(weekStart);
  if (!week) return [];
  return (week.shifts || []).filter((s) => s.repKey === repKey);
}

function updateShiftDay(weekStart, shiftId, dayOfWeek, scheduledDate) {
  const db = readStore();
  const week = db.weeks?.[weekStart];
  if (!week) throw new Error('Week schedule not found — ingest export first');
  const shift = (week.shifts || []).find((s) => String(s.id) === String(shiftId));
  if (!shift) throw new Error('Shift not found');
  shift.dayOfWeek = dayOfWeek;
  shift.date = scheduledDate;
  week.updatedAt = new Date().toISOString();
  writeStore(db);
  return shift;
}

module.exports = {
  FILE,
  listWeekKeys,
  getWeekSchedule,
  saveWeekSchedule,
  getShiftsForRep,
  updateShiftDay,
  readStore,
};
