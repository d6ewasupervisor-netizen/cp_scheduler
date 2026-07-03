#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const D1 = new Set([
  4, 35, 40, 51, 60, 63, 143, 153, 218, 220, 240, 242, 285, 375, 377, 393, 462, 482, 516, 651, 661,
  694,
]);
const D8 = new Set([19, 23, 28, 31, 53, 215, 391, 459, 658, 682]);

function normDay(d) {
  if (!d) return null;
  const s = String(d).trim().toLowerCase();
  const map = {
    mon: 'Mon',
    monday: 'Mon',
    tue: 'Tue',
    tues: 'Tue',
    tuesday: 'Tue',
    wed: 'Wed',
    wednesday: 'Wed',
    thur: 'Thu',
    thu: 'Thu',
    thurs: 'Thu',
    thursday: 'Thu',
    fri: 'Fri',
    friday: 'Fri',
    sat: 'Sat',
    saturday: 'Sat',
    sun: 'Sun',
    sunday: 'Sun',
  };
  return map[s] || null;
}

async function main() {
  const input =
    process.argv[2] ||
    path.join(process.env.USERPROFILE || '', 'Downloads', 'MASTER ROUTE 05-22-2026 (1).xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(input);
  const ws = wb.getWorksheet('BY STORE');
  if (!ws) throw new Error('BY STORE sheet not found');

  const headers = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = String(cell.value || '').trim();
  });

  // Normalized lookup: case-insensitive, collapses internal whitespace,
  // returns the 1-based column number (headers[] is already 1-based).
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const col = (name) => {
    const want = norm(name);
    for (let i = 1; i < headers.length; i++) {
      if (norm(headers[i]) === want) return i;
    }
    throw new Error(`Column not found in BY STORE header row: "${name}"`);
  };

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const store = Number(row.getCell(col('Store #')).value);
    if (!Number.isFinite(store)) return;
    const district = D1.has(store) ? 1 : D8.has(store) ? 8 : null;
    if (!district) return;
    const name = row.getCell(col('Employee Name ')).value;
    if (!name) return;
    rows.push({
      sc: row.getCell(col('SC')).value,
      sup: row.getCell(col('SUP')).value,
      employeeName: String(name).trim(),
      account: row.getCell(col('ACCOUNT')).value,
      storeNum: store,
      district,
      serviceDay: normDay(row.getCell(col('Service  Day')).value),
      action: row.getCell(col('ACTION')).value,
      pickDay: normDay(row.getCell(col(' Pick Day')).value),
      deliveryDay: normDay(row.getCell(col('Deliver')).value),
      routeNum: row.getCell(col('Route#')).value,
      carriers: row.getCell(col('Carriers')).value,
    });
  });

  const outPath = path.join(__dirname, '../data/central-pet-master-route.json');
  const payload = {
    versionDate: (() => {
      const m = path.basename(input).match(/(\d{2})-(\d{2})-(\d{4})/);
      return m ? `${m[3]}-${m[1]}-${m[2]}` : 'unknown';
    })(),
    sourceFile: path.basename(input),
    sheet: 'BY STORE',
    rowCount: rows.length,
    rows,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${rows.length} rows to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
