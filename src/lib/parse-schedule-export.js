#!/usr/bin/env node
'use strict';

/**
 * Parse prod schedule export xlsx for Central Pet 8 teams.
 *
 * Expected headers (flexible whitespace/case):
 *   Team Name, Emp #, Emp Name, Store #, Store Name, Scheduled Date,
 *   Shift Start, Shift End, Home To Store, Store To Store, Store To Home,
 *   Visit Notes (Optional), ...
 *
 * Usage:
 *   node scripts/parse-schedule-export.js path/to/export.xlsx [out.json]
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { decodeD8Note } = require('./d8-note-decoder');
const { shiftRepByWorkdayId, shiftRepByName } = require('./d8-shift-reps');

const TEAM_PREFIX = /^central\s+pet\s+8/i;

function normHeader(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function cellText(cell) {
  if (cell == null) return '';
  if (typeof cell === 'object') {
    if (cell.result != null) return String(cell.result).trim();
    if (cell.text != null) return String(cell.text).trim();
    if (cell.richText) return cell.richText.map((t) => t.text || '').join('').trim();
  }
  return String(cell).trim();
}

function excelDateToIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial date
    const utc = ExcelJS.DateTime?.fromExcelSerial
      ? null
      : null;
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + value * 86400000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m2) {
    const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
    return `${y}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function resolveRepKey(empNum, empName) {
  const byId = shiftRepByWorkdayId(empNum);
  if (byId) return byId.repKey;
  const byName = shiftRepByName(empName);
  if (byName) return byName.repKey;
  return null;
}

/**
 * Parse workbook buffer or file path.
 * @returns {{ shifts: Array, flags: Array, meta: Object }}
 */
async function parseScheduleExport(input, opts = {}) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input)) {
    await wb.xlsx.load(input);
  } else {
    await wb.xlsx.readFile(String(input));
  }

  const ws =
    wb.worksheets.find((s) => /schedule|export|sheet/i.test(s.name)) ||
    wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in schedule export');

  const headers = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = normHeader(cellText(cell.value));
  });

  const col = (aliases) => {
    const wants = aliases.map(normHeader);
    for (let i = 1; i < headers.length; i++) {
      if (wants.includes(headers[i])) return i;
    }
    return null;
  };

  const cTeam = col(['team name']);
  const cEmpNum = col(['emp #', 'emp#', 'employee #', 'employee id', 'emp id']);
  const cEmpName = col(['emp name', 'employee name', 'name']);
  const cStore = col(['store #', 'store#', 'store number']);
  const cStoreName = col(['store name']);
  const cDate = col(['scheduled date', 'date', 'shift date']);
  const cStart = col(['shift start time', 'shift start', 'start', 'start time']);
  const cEnd = col(['shift end time', 'shift end', 'end', 'end time']);
  const cNotes = col(['visit notes (optional)', 'visit notes', 'notes']);

  if (cTeam == null || cStore == null || cDate == null) {
    throw new Error(
      'Schedule export missing required columns (need Team Name, Store #, Scheduled Date)'
    );
  }

  const shifts = [];
  const flags = [];

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const team = cellText(row.getCell(cTeam).value);
    if (!TEAM_PREFIX.test(team)) return;

    const scheduledStore = Number(String(cellText(row.getCell(cStore).value)).replace(/\D/g, ''));
    const empNum = cEmpNum ? cellText(row.getCell(cEmpNum).value) : '';
    const empName = cEmpName ? cellText(row.getCell(cEmpName).value) : '';
    const date = excelDateToIso(row.getCell(cDate).value);
    const rawNote = cNotes ? cellText(row.getCell(cNotes).value) : '';
    const storeName = cStoreName ? cellText(row.getCell(cStoreName).value) : '';

    const decoded = decodeD8Note(rawNote, scheduledStore);
    const repKey = resolveRepKey(empNum, empName);

    const flagReasons = [];
    if (!Number.isFinite(scheduledStore)) flagReasons.push('invalid_store');
    if (!date) flagReasons.push('invalid_date');
    if (!repKey) flagReasons.push('unknown_rep');
    if (!decoded.actualStore) flagReasons.push('decode_no_store');

    const shift = {
      id: `export-${rowNumber}`,
      rowNumber,
      teamName: team,
      empNum: empNum || null,
      empName: empName || null,
      repKey,
      date,
      scheduledStore: Number.isFinite(scheduledStore) ? scheduledStore : null,
      actualStore: decoded.actualStore,
      storeName: storeName || null,
      writeOrder: decoded.writeOrder,
      workLoad: decoded.workLoad,
      picksDay: decoded.picksDay,
      delivery: decoded.delivery,
      deliveryDay: decoded.deliveryDay,
      shiftStart: cStart ? cellText(row.getCell(cStart).value) || null : null,
      shiftEnd: cEnd ? cellText(row.getCell(cEnd).value) || null : null,
      rawNote,
      redirected: decoded.redirected,
      flagged: flagReasons.length > 0,
      flagReasons,
    };

    shifts.push(shift);
    if (shift.flagged) {
      flags.push({
        rowNumber,
        empName,
        date,
        scheduledStore: shift.scheduledStore,
        reasons: flagReasons,
      });
    }
  });

  return {
    meta: {
      sourceFile: opts.sourceFile || (typeof input === 'string' ? path.basename(input) : 'upload.xlsx'),
      sheet: ws.name,
      teamFilter: 'Central Pet 8*',
      shiftCount: shifts.length,
      flagCount: flags.length,
      parsedAt: new Date().toISOString(),
    },
    shifts,
    flags,
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/parse-schedule-export.js <export.xlsx> [out.json]');
    process.exit(1);
  }
  const out =
    process.argv[3] ||
    path.join(__dirname, '../../data/shift-day-schedules', `${path.basename(input, path.extname(input))}.json`);
  const result = await parseScheduleExport(input, { sourceFile: path.basename(input) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(
    `Wrote ${result.shifts.length} Central Pet 8 shifts (${result.flags.length} flagged) → ${out}`
  );
  if (result.flags.length) {
    console.log('Flag report:');
    for (const f of result.flags) {
      console.log(`  row ${f.rowNumber}: ${f.reasons.join(', ')}`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseScheduleExport, resolveRepKey, TEAM_PREFIX };
