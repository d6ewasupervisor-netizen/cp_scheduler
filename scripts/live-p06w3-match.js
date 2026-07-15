'use strict';

/**
 * Live read-only P06W3 visit matcher check.
 * Usage: node scripts/live-p06w3-match.js [supervisorId]
 */
const { matchVisits } = require('../src/lib/visit-matcher');
const { getWeekSchedule } = require('../src/lib/shift-day-store');

async function main() {
  const supervisorId = process.argv[2] || process.env.SAS_SUPERVISOR_ID || '800175315';
  const weekStart = '2026-07-05';
  const weekEnd = '2026-07-11';
  const schedule = getWeekSchedule(weekStart);
  if (!schedule?.shifts?.length) {
    console.error('No seeded schedule for', weekStart);
    process.exit(1);
  }

  console.log(`P06W3 matcher (read-only) supervisor=${supervisorId}`);
  console.log(`App shifts seeded: ${schedule.shifts.length}`);

  const result = await matchVisits({
    startDate: weekStart,
    endDate: weekEnd,
    weekStart,
    supervisorId,
  });

  const redirectedMatched = result.matched.filter(
    (m) => m.appShift.scheduledStore === 391 && m.appShift.actualStore !== 391
  );

  console.log('\nSummary:', JSON.stringify(result.summary, null, 2));
  console.log(`\nMatched redirected-391: ${redirectedMatched.length}`);
  for (const m of redirectedMatched) {
    console.log(
      `  ✓ ${m.appShift.repKey} ${m.appShift.date} sched ${m.appShift.scheduledStore} → ${m.appShift.actualStore} visit=${m.prodVisit.visitId}`
    );
  }
  console.log('\nAll matched:');
  for (const m of result.matched) {
    console.log(
      `  ✓ ${m.appShift.repKey} ${m.appShift.date} ${m.appShift.actualStore} visit=${m.prodVisit.visitId} (sched ${m.prodVisit.scheduledStore})`
    );
  }
  if (result.unmatched.length) {
    console.log('\nUnmatched:');
    for (const u of result.unmatched) {
      console.log(`  ? ${u.appShift.repKey} ${u.appShift.date} ${u.appShift.actualStore} id=${u.appShift.id}`);
    }
  }
  if (result.ambiguous.length) {
    console.log('\nAmbiguous:');
    for (const a of result.ambiguous) {
      console.log(
        `  ! ${a.appShift.repKey} ${a.appShift.date} ${a.appShift.actualStore} candidates=${a.candidates.map((c) => c.visitId).join(',')}`
      );
    }
  }
  if (result.orphaned.length) {
    console.log('\nOrphaned prod:');
    for (const o of result.orphaned) {
      console.log(
        `  ○ visit=${o.prodVisit.visitId} ${o.prodVisit.repKey} ${o.prodVisit.date} decoded=${o.prodVisit.actualStore} sched=${o.prodVisit.scheduledStore}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
