'use strict';

const fs = require('fs');
const path = require('path');
const { buildVisitSlots } = require('./master-route-constraints');
const { districtForStore } = require('./constants');
const { REP_AVAILABILITY } = require('./rep-availability');

const DATA_DIR = path.join(__dirname, '../../data');
const D8_VIRTUAL_KEY = '__D8_CENTRAL_PET__';

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

function loadD8Assignees() {
  const file = path.join(DATA_DIR, 'd8-assignees.json');
  if (!fs.existsSync(file)) return { proposedAssignees: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function filterRowsToStoreNums(rows, storeNums) {
  if (!storeNums?.length) return rows;
  const allowed = new Set(storeNums.map(Number));
  return rows.filter((r) => allowed.has(Number(r.storeNum)));
}

function groupRowsByRep(masterRoute, overrides) {
  const byRep = new Map();

  for (const row of masterRoute.rows) {
    const name = row.employeeName;
    if (!byRep.has(name)) byRep.set(name, []);
    byRep.get(name).push(row);
  }

  for (const [repName, cfg] of Object.entries(overrides)) {
    let rows = [];
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
    rows = filterRowsToStoreNums(rows, cfg.storeNums);

    const dedup = new Map();
    for (const r of rows) {
      const key = `${r.storeNum}:${r.serviceDay}:${r.action}`;
      if (!dedup.has(key)) {
        dedup.set(key, { ...r, employeeName: repName, district: cfg.district || r.district });
      }
    }
    byRep.set(repName, [...dedup.values()]);
  }

  return byRep;
}

function buildD8VisitSlots(masterRoute) {
  const d8Rows = masterRoute.rows.filter((r) => r.district === 8);
  const byStore = new Map();
  for (const row of d8Rows) {
    if (!byStore.has(row.storeNum)) byStore.set(row.storeNum, []);
    byStore.get(row.storeNum).push(row);
  }

  const visitSlots = [];
  for (const [storeNum, storeRows] of byStore) {
    for (const s of buildVisitSlots(storeRows)) {
      visitSlots.push({ ...s, district: 8, masterRouteRep: storeRows[0]?.employeeName });
    }
  }
  visitSlots.sort((a, b) => a.storeNum - b.storeNum || a.visitIndex - b.visitIndex);
  return visitSlots;
}

function buildD8PoolRep(masterRoute) {
  const cfg = loadD8Assignees();
  const visitSlots = buildD8VisitSlots(masterRoute);
  return {
    name: cfg.displayName || 'District 8 — Central Pet',
    repKey: D8_VIRTUAL_KEY,
    employeeId: null,
    workdayId: null,
    email: null,
    district: 8,
    storeCount: new Set(visitSlots.map((s) => s.storeNum)).size,
    visitSlots,
    isD8Pool: true,
    proposedAssignees: cfg.proposedAssignees || [],
    proposedAssigneeNote:
      'Select a proposed assignee per visit. Names are for planning only — nothing is sent to these people.',
  };
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
    repKey: repName,
    employeeId: override.employeeId || null,
    workdayId: override.workdayId || null,
    email: override.email || null,
    district: override.district || rows[0]?.district || null,
    storeCount: byStore.size,
    visitSlots,
    isD8Pool: false,
    proposedAssignees: [],
    allowsRepAvailability: !!override.exclusiveDistrictRep,
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
  const exclusiveD1 = new Set(
    Object.entries(overrides)
      .filter(([, cfg]) => cfg.exclusiveDistrictRep && cfg.district === 1)
      .map(([name]) => name)
  );

  if (!districtFilter || Number(districtFilter) === 8) {
    reps.push(buildD8PoolRep(masterRoute));
  }

  for (const [name, rows] of grouped) {
    if (!rows.length || !overrides[name]) continue;
    const override = overrides[name];
    const profile = buildRepProfile(name, rows, override);

    if (Number(districtFilter) === 1 && exclusiveD1.size && !exclusiveD1.has(name)) {
      continue;
    }
    if (districtFilter && profile.district !== Number(districtFilter)) continue;
    if (Number(districtFilter) === 8) continue;

    reps.push(profile);
  }

  reps.sort((a, b) => {
    if (a.isD8Pool) return -1;
    if (b.isD8Pool) return 1;
    return a.name.localeCompare(b.name);
  });
  return reps;
}

function getRep(nameOrKey) {
  const decoded = decodeURIComponent(nameOrKey);
  if (decoded === D8_VIRTUAL_KEY || decoded.startsWith('District 8')) {
    return buildD8PoolRep(loadMasterRoute());
  }
  const rep = listReps().find((r) => r.name === decoded || r.repKey === decoded);
  return rep || null;
}

/** Visit slots for one store from the master route (any district / rep row). */
function visitSlotsForStore(storeNum) {
  const master = loadMasterRoute();
  const rows = (master.rows || []).filter((r) => Number(r.storeNum) === Number(storeNum));
  if (!rows.length) return [];
  return buildVisitSlots(rows);
}

function resolveRepKey(rep) {
  return rep?.repKey || rep?.name;
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
      proposedAssignee: rep.isD8Pool ? '' : undefined,
      repAvailability: rep.allowsRepAvailability ? REP_AVAILABILITY.AVAILABLE : undefined,
    };
  });
}

module.exports = {
  D8_VIRTUAL_KEY,
  loadMasterRoute,
  loadRepOverrides,
  loadD8Assignees,
  listReps,
  getRep,
  visitSlotsForStore,
  resolveRepKey,
  defaultPlacementsForWeek,
  buildD8PoolRep,
};
