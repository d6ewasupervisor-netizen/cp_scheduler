#!/usr/bin/env node
'use strict';

/**
 * Read-only Brian dry run for one fiscal week.
 * Usage: node scripts/dry-run-brian-mileage.js [start] [end] [supervisorId]
 * Defaults: P06W3 2026-07-05..2026-07-11, supervisor 800175315
 */

const { pullPeriodMileage } = require('../src/lib/punch-mileage-puller');

const BRIAN = '800553343';

async function main() {
  const startDate = process.argv[2] || '2026-07-05';
  const endDate = process.argv[3] || '2026-07-11';
  const supervisorId = process.argv[4] || '800175315';

  console.log(`Dry run Brian only ${startDate} → ${endDate} (supervisor ${supervisorId})`);
  const result = await pullPeriodMileage({
    startDate,
    endDate,
    supervisorId,
    eids: [BRIAN],
    includeTravel: true,
  });

  const rep = result.reps[BRIAN];
  const summary = {
    range: `${result.startDate}..${result.endDate}`,
    visitCount: result.visitCount,
    punchedVisits: result.visits.length,
    cachedVisitCount: result.cachedVisitCount,
    periodMiles: rep?.periodMiles ?? 0,
    complete: rep?.complete ?? true,
    daysWithheld: rep?.daysWithheld || [],
    days: (rep?.days || []).map((d) => ({
      date: d.date,
      sequence: d.sequence,
      totalMiles: d.totalMiles,
      legs: d.legs,
      warnings: d.warnings,
      travelDeltas: d.travelDeltas || [],
    })),
    travelDeltas: result.travelDeltas,
    redirectedVisits: result.visits.filter((v) => v.redirected),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
