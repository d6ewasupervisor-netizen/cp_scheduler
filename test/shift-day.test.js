'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { decodeD8Note } = require('../src/lib/d8-note-decoder');
const { parseScheduleExport, resolveRepKey } = require('../src/lib/parse-schedule-export');
const { matchVisits, statusForShift } = require('../src/lib/visit-matcher');

const NOTE_215 =
  '***WRITE ORDER*** THIS IS FOR STORE 215 -\nDELIVERED YESTERDAY(MONDAY)/WORK LOAD/PICKS TUESDAY(TODAY)***WRITE ORDER***';
const NOTE_31 =
  '***DO NOT WRITE ORDER*** THIS IS FOR STORE 31 - WORK LOAD ONLY / PICKS FRIDAY***DO NOT WRITE ORDER***';

async function buildFixtureWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export');
  ws.addRow([
    'Team Name',
    'Emp #',
    'Emp Name',
    'Store #',
    'Store Name',
    'Scheduled Date',
    'Shift Start',
    'Shift End',
    'Home To Store',
    'Store To Store',
    'Store To Home',
    'Visit Notes (Optional)',
  ]);
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('parse-schedule-export', () => {
  it('resolves D8 reps by workday id and name', () => {
    assert.equal(resolveRepKey('800553343', 'Brian Campbell'), 'brian-campbell');
    assert.equal(resolveRepKey('', 'Kimberly Claflin'), 'kimberly-claflin');
    assert.equal(resolveRepKey('800627385', 'James'), 'james-duchene');
  });

  it('parses Central Pet 8 rows and decodes every D8 note (flags unknowns)', async () => {
    const buf = await buildFixtureWorkbook([
      [
        'Central Pet 8 - Brian',
        '800553343',
        'Brian Campbell',
        391,
        'Totem Lake',
        '2026-07-08',
        '06:01 AM',
        '09:01 AM',
        30.8,
        0,
        30.8,
        NOTE_215,
      ],
      [
        'Central Pet 8 - Kim',
        '800605698',
        'Kimberly Claflin',
        391,
        'Totem Lake',
        '2026-07-07',
        '06:01 AM',
        '02:01 PM',
        22.7,
        0,
        22.7,
        NOTE_31,
      ],
      [
        'Other Team',
        '999',
        'Someone Else',
        19,
        'Auburn',
        '2026-07-08',
        '06:01 AM',
        '02:01 PM',
        0,
        0,
        0,
        '',
      ],
      [
        'Central Pet 8 - Mystery',
        '999999',
        'Unknown Person',
        391,
        'Totem Lake',
        '2026-07-09',
        '06:01 AM',
        '02:01 PM',
        0,
        0,
        0,
        '***WRITE ORDER*** THIS IS FOR STORE 19***WRITE ORDER***',
      ],
    ]);

    const parsed = await parseScheduleExport(buf, { sourceFile: 'fixture.xlsx' });
    assert.equal(parsed.shifts.length, 3); // other team filtered out
    assert.equal(parsed.shifts[0].actualStore, 215);
    assert.equal(parsed.shifts[0].scheduledStore, 391);
    assert.equal(parsed.shifts[0].redirected, true);
    assert.equal(parsed.shifts[0].workLoad, true);
    assert.equal(parsed.shifts[1].actualStore, 31);
    assert.equal(parsed.shifts[1].writeOrder, false);
    assert.ok(parsed.flags.some((f) => f.reasons.includes('unknown_rep')));
    // No silent drops of Central Pet 8 rows
    assert.equal(parsed.shifts.filter((s) => /central pet 8/i.test(s.teamName)).length, 3);
  });
});

describe('visit-matcher', () => {
  it('matches unique rep+date+decoded store; flags ambiguity without guessing', async () => {
    const appShifts = [
      {
        id: 'a1',
        repKey: 'brian-campbell',
        date: '2026-07-08',
        actualStore: 215,
        scheduledStore: 391,
      },
      {
        id: 'a2',
        repKey: 'brian-campbell',
        date: '2026-07-08',
        actualStore: 215,
        scheduledStore: 391,
      },
      {
        id: 'a3',
        repKey: 'james-duchene',
        date: '2026-07-08',
        actualStore: 53,
        scheduledStore: 391,
      },
    ];

    async function sasGet(_token, path) {
      if (path === '/operations/field-data/') {
        return [
          { id: 100, scheduled_date: '2026-07-08', current_status: 'completed', store_name: { number: 391 } },
          { id: 101, scheduled_date: '2026-07-08', current_status: 'completed', store_name: { number: 391 } },
          { id: 102, scheduled_date: '2026-07-08', current_status: 'completed', store_name: { number: 391 } },
          { id: 103, scheduled_date: '2026-07-08', current_status: 'deleted', store_name: { number: 391 } },
        ];
      }
      if (path.includes('/100/store-field')) {
        return { notes: NOTE_215, store: { number: 391 } };
      }
      if (path.includes('/101/store-field')) {
        return { notes: NOTE_215, store: { number: 391 } };
      }
      if (path.includes('/102/store-field')) {
        return {
          notes: '***WRITE ORDER*** THIS IS FOR STORE 53***WRITE ORDER***',
          store: { number: 391 },
        };
      }
      if (path.includes('/employees')) {
        if (path.includes('/100/') || path.includes('/101/')) {
          return [
            {
              workday_given_id: '800553343',
              no_show: false,
              actual_start_time: '2026-07-08T13:01:00Z',
              executed_date: '2026-07-08',
              shift_id: 1,
            },
          ];
        }
        if (path.includes('/102/')) {
          return [
            {
              workday_given_id: '800627385',
              no_show: false,
              actual_start_time: '2026-07-08T16:00:00Z',
              executed_date: '2026-07-08',
              shift_id: 2,
            },
          ];
        }
      }
      return [];
    }

    const result = await matchVisits({
      startDate: '2026-07-08',
      endDate: '2026-07-08',
      weekStart: '2026-07-05',
      supervisorId: '800175315',
      appShifts,
      sasGet,
      loadSession: async () => ({ token: 't' }),
    });

    // Two identical Brian 215 notes same day → ambiguous for both app shifts
    assert.equal(result.ambiguous.length, 2);
    assert.ok(result.ambiguous.every((a) => a.candidates.length === 2));
    // James unique → matched
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].prodVisit.visitId, 102);
    assert.equal(statusForShift(result, 'a3').status, 'matched');
    assert.equal(statusForShift(result, 'a1').status, 'ambiguous');
  });

  it('marks unmatched app shifts and orphaned prod visits', async () => {
    const appShifts = [
      {
        id: 'only-app',
        repKey: 'brian-campbell',
        date: '2026-07-08',
        actualStore: 19,
        scheduledStore: 391,
      },
    ];

    async function sasGet(_token, path) {
      if (path === '/operations/field-data/') {
        return [
          { id: 200, scheduled_date: '2026-07-08', current_status: 'completed', store_name: { number: 391 } },
        ];
      }
      if (path.includes('store-field')) {
        return {
          notes: '***WRITE ORDER*** THIS IS FOR STORE 111***WRITE ORDER***',
          store: { number: 391 },
        };
      }
      if (path.includes('employees')) {
        return [
          {
            workday_given_id: '800553343',
            no_show: false,
            actual_start_time: '2026-07-08T13:00:00Z',
            executed_date: '2026-07-08',
          },
        ];
      }
      return [];
    }

    const result = await matchVisits({
      startDate: '2026-07-08',
      endDate: '2026-07-08',
      supervisorId: '1',
      appShifts,
      sasGet,
      loadSession: async () => ({ token: 't' }),
    });
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.orphaned.length, 1);
    assert.equal(result.orphaned[0].prodVisit.actualStore, 111);
  });
});

describe('decode fixtures used by export parser', () => {
  it('keeps decoder contract for export notes', () => {
    assert.equal(decodeD8Note(NOTE_215, 391).actualStore, 215);
    assert.equal(decodeD8Note(NOTE_31, 391).writeOrder, false);
  });
});
