'use strict';

const fs = require('fs');
const path = require('path');
const { buildVisitSlots } = require('./master-route-constraints');
const { districtForStore } = require('./constants');

const DATA_DIR = path.join(__dirname, '../../data');

function loadMasterRoute() {
  const file = path.join(DATA_DIR, 'central-pet-master-route.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const suppPath = path.join(DATA_DIR, 'supplemental-stores.json');
  if (fs.existsSync(suppPath)) {
    const supp = JSON.parse(fs.readFileSync(suppPath, 'utf8'));
    data.rows = [...(data.rows || []), ...(supp.rows || [])];
    data.rowCount = data.rows.length;
  }
  return data;
}

function loadRepOverrides() {
  const file = path.join(DATA_DIR, 'rep-overrides.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function groupRowsByRep(masterRoute, overrides) {
  const byRep = new Map();

  for (const row of masterRoute.rows) {
    const name = row.employeeName;
    if (!byRep.has(name)) byRep.set(name, []);
    byRep.get(name).push(row);
  }

  for (const [repName, cfg] of Object.entries(overrides)) {
    const rows = [];
    for (const inherit of cfg.inheritFrom || []) {
      rows.push(...(byRep.get(inherit) || []));
    }
    for (const storeNum of cfg.extraStoreNums || []) {
      for (const [, repRows] of byRep) {
        for (const r of repRows) {
          if (r.storeNum === storeNum) rows.push({ ...r, employeeName: repName });
        }
      }
    }
    const dedup = new Map();
    for (const r of rows) {
      const key = `${r.storeNum}:${r.serviceDay}:${r.action}`;
      if (!dedup.has(key)) dedup.set(key, { ...r, employeeName: repName, district: cfg.district || r.district });
    }
    byRep.set(repName, [...dedup.values()]);
  }

  return byRep;
}

function buildRepProfile(repName, rows, override = {}) {
  const byStore = new Map();
  for (const row of rows) {
    if (!byStore.has(row.storeNum)) byStore.set(row.storeNum, []);
    byStore.get(row.storeNum).push(row);
  }

  const visitSlots = [];
  for (const [storeNum, storeRows] of byStore) {
    const slots = buildVisitSlots(storeRows);
    for (const s of slots) {
      visitSlots.push({
        ...s,
        district: districtForStore(storeNum) || rowDistrict(storeRows),
      });
    }
  }

  visitSlots.sort((a, b) => a.storeNum - b.storeNum || a.visitIndex - b.visitIndex);

  return {
    name: repName,
    employeeId: override.employeeId || null,
    workdayId: override.workdayId || null,
    email: override.email || null,
    district: override.district || rows[0]?.district || null,
    storeCount: byStore.size,
    visitSlots,
  };
}

function rowDistrict(storeRows) {
  return storeRows[0]?.district || null;
}

function listReps(districtFilter) {
  const masterRoute = loadMasterRoute();
  const overrides = loadRepOverrides();
  const grouped = groupRowsByRep(masterRoute, overrides);
  const reps = [];

  for (const [name, rows] of grouped) {
    if (!rows.length) continue;
    const override = overrides[name] || {};
    const profile = buildRepProfile(name, rows, override);
    if (districtFilter && profile.district !== Number(districtFilter)) continue;
    reps.push(profile);
  }

  reps.sort((a, b) => a.name.localeCompare(b.name));
  return reps;
}

function getRep(name) {
  return listReps().find((r) => r.name === name) || null;
}

function defaultPlacementsForWeek(rep, weekStart) {
  const { dayToDateInWeek } = require('./fiscal-calendar');
  return rep.visitSlots.map((slot) => {
    const dayOfWeek = slot.anchorServiceDay;
    const scheduledDate = dayToDateInWeek(weekStart, dayOfWeek);
    return {
      storeNum: slot.storeNum,
      visitIndex: slot.visitIndex,
      account: slot.account,
      action: slot.action,
      dayOfWeek,
      scheduledDate,
      shiftStart: '06:00',
      shiftEnd: '14:30',
      estimatedHours: 8,
      isLead: true,
    };
  });
}

module.exports = {
  loadMasterRoute,
  loadRepOverrides,
  listReps,
  getRep,
  defaultPlacementsForWeek,
};
