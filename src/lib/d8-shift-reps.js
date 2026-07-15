'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/d8-shift-reps.json');

function loadD8ShiftReps() {
  if (!fs.existsSync(FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return raw.reps || [];
}

function shiftRepByKey(repKey) {
  return loadD8ShiftReps().find((r) => r.repKey === String(repKey)) || null;
}

function shiftRepByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return (
    loadD8ShiftReps().find((r) => (r.emails || []).map((x) => x.toLowerCase()).includes(e)) ||
    null
  );
}

function shiftRepByWorkdayId(wid) {
  const id = String(wid || '');
  return loadD8ShiftReps().find((r) => String(r.workdayGivenId) === id) || null;
}

function shiftRepByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return (
    loadD8ShiftReps().find((r) => {
      const full = String(r.name || '').toLowerCase();
      return full === n || full.startsWith(n) || n.startsWith(full.split(' ')[0]);
    }) || null
  );
}

module.exports = {
  loadD8ShiftReps,
  shiftRepByKey,
  shiftRepByEmail,
  shiftRepByWorkdayId,
  shiftRepByName,
};
