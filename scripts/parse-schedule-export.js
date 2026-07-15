#!/usr/bin/env node
'use strict';

const { parseScheduleExport } = require('../src/lib/parse-schedule-export');
const fs = require('fs');
const path = require('path');

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/parse-schedule-export.js <export.xlsx> [out.json]');
    process.exit(1);
  }
  const out =
    process.argv[3] ||
    path.join(
      __dirname,
      '../data/shift-day-schedules',
      `${path.basename(input, path.extname(input))}.json`
    );
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
