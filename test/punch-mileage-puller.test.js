'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decodeD8Note } = require('../src/lib/d8-note-decoder');
const { calcDayMileage } = require('../src/lib/day-mileage');
const {
  pullPeriodMileage,
  toMileageVisits,
  reconcileTravelRecords,
  createVisitCache,
  DELTA_THRESHOLD_MILES,
} = require('../src/lib/punch-mileage-puller');

const BRIAN = '800553343';

const NOTE_215 =
  '***WRITE ORDER*** THIS IS FOR STORE 215 -\nDELIVERED YESTERDAY(MONDAY)/WORK LOAD/PICKS TUESDAY(TODAY)***WRITE ORDER***';

describe('decoded-store leg selection', () => {
  it('uses decoded 215 not scheduled 391 for Brian home legs', () => {
    const with391 = calcDayMileage(BRIAN, [
      {
        store_number: 391,
        shift_start_time: '06:01 AM',
        actual_start_time: '2026-07-08T13:01:00Z',
        current_status: 'completed',
      },
    ]);
    const with215 = calcDayMileage(BRIAN, [
      {
        store_number: 215,
        shift_start_time: '06:01 AM',
        actual_start_time: '2026-07-08T13:01:00Z',
        current_status: 'completed',
      },
    ]);
    assert.equal(with391.legs[0].miles, 31.0);
    assert.equal(with215.legs[0].miles, 3.6);
    assert.notEqual(with391.totalMiles, with215.totalMiles);
  });

  it('orders multi-stop day by actual_start_time using decoded stores', () => {
    const r = calcDayMileage(BRIAN, [
      {
        store_number: 28,
        actual_start_time: '11:00:00',
        current_status: 'completed',
      },
      {
        store_number: 215,
        actual_start_time: '06:01:00',
        current_status: 'completed',
      },
    ]);
    assert.deepEqual(r.sequence, [215, 28]);
    assert.equal(r.legs[0].from, 'home');
    assert.equal(r.legs[0].to, '215');
    assert.equal(r.legs[1].from, '215');
    assert.equal(r.legs[1].to, '28');
    assert.equal(r.legs[2].to, 'home');
  });
});

describe('travel delta flagging (391 trap detector)', () => {
  it('flags SAS 30.80 H-S vs matrix Brian→215 = 3.6', () => {
    const day = calcDayMileage(BRIAN, [
      {
        store_number: 215,
        actual_start_time: '2026-07-08T13:01:00Z',
        current_status: 'completed',
      },
    ]);
    const dayVisits = [
      {
        visit_id: 27000510,
        store_number: 215,
        scheduled_store_number: 391,
        shift_id: 44390825,
        travel_records: [
          {
            shift_id: 44390825,
            start_location_type: 'H',
            end_location_type: 'S',
            distance: '30.80',
          },
        ],
      },
    ];
    const deltas = reconcileTravelRecords(BRIAN, day, dayVisits);
    assert.ok(deltas.length >= 1);
    assert.equal(deltas[0].type, 'H-S');
    assert.equal(deltas[0].matrixMiles, 3.6);
    assert.equal(deltas[0].sasMiles, 30.8);
    assert.ok(deltas[0].delta > DELTA_THRESHOLD_MILES);
    assert.equal(deltas[0].decodedStore, 215);
    assert.equal(deltas[0].scheduledStore, 391);
    assert.equal(deltas[0].visitId, 27000510);
  });

  it('does not flag when SAS and matrix agree within 2.0', () => {
    const day = calcDayMileage(BRIAN, [
      {
        store_number: 215,
        actual_start_time: '06:01:00',
        current_status: 'completed',
      },
    ]);
    const deltas = reconcileTravelRecords(BRIAN, day, [
      {
        store_number: 215,
        travel_records: [
          {
            start_location_type: 'H',
            end_location_type: 'S',
            distance: '4.0',
          },
        ],
      },
    ]);
    assert.deepEqual(deltas, []);
  });
});

describe('toMileageVisits + skip rules', () => {
  it('skips no_show and prefers decoded store', () => {
    const rows = toMileageVisits([
      {
        visitId: 1,
        scheduledDate: '2026-07-08',
        scheduledStore: 391,
        visitStatus: 'completed',
        decoded: decodeD8Note(NOTE_215, 391),
        storeField: { notes: NOTE_215, store: { number: 391 } },
        employees: [
          {
            workday_given_id: BRIAN,
            shift_id: 1,
            no_show: true,
            actual_start_time: null,
          },
          {
            workday_given_id: BRIAN,
            shift_id: 2,
            no_show: false,
            actual_start_time: '2026-07-08T13:01:00Z',
            executed_date: '2026-07-08',
          },
        ],
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].store_number, 215);
    assert.equal(rows[0].scheduled_store_number, 391);
    assert.equal(rows[0].redirected, true);
  });
});

describe('pullPeriodMileage (mocked SAS)', () => {
  it('runs decoder, caches completed visits, and never re-fetches notes', async () => {
    const calls = [];
    const cache = createVisitCache();

    const fieldRow = {
      id: 27000510,
      scheduled_date: '2026-07-08',
      current_status: 'completed',
      store_name: { number: 391, name: 'Fred Meyer' },
    };

    async function sasGet(_token, path, params) {
      calls.push({ path, params });
      if (path === '/operations/field-data/') return [fieldRow];
      if (path === '/field-app/visits/27000510/employees/') {
        return [
          {
            workday_given_id: BRIAN,
            shift_id: 44390825,
            no_show: false,
            actual_start_time: '2026-07-08T13:01:00Z',
            executed_date: '2026-07-08',
          },
        ];
      }
      if (path === '/field-app/visits/27000510/store-field/') {
        return {
          notes: NOTE_215,
          store: { number: 391 },
          visit_status: 'completed',
        };
      }
      if (path === '/api/v2/field-app/shifts/44390825/') {
        return {
          id: 44390825,
          travel_records: [
            {
              shift_id: 44390825,
              start_location_type: 'H',
              end_location_type: 'S',
              distance: '30.80',
            },
          ],
        };
      }
      throw new Error(`unexpected path ${path}`);
    }

    const loadSession = async () => ({ token: 'test-token' });

    const first = await pullPeriodMileage({
      startDate: '2026-07-08',
      endDate: '2026-07-08',
      supervisorId: '800175315',
      eids: [BRIAN],
      sasGet,
      loadSession,
      cache,
    });

    assert.equal(first.visits[0].store_number, 215);
    assert.equal(first.visits[0].scheduled_store_number, 391);
    assert.equal(first.reps[BRIAN].days[0].legs[0].to, '215');
    assert.equal(first.reps[BRIAN].days[0].legs[0].miles, 3.6);
    assert.ok(first.travelDeltas.some((d) => d.sasMiles === 30.8 && d.matrixMiles === 3.6));
    assert.equal(cache.size(), 1);

    const callsAfterFirst = calls.length;

    const second = await pullPeriodMileage({
      startDate: '2026-07-08',
      endDate: '2026-07-08',
      supervisorId: '800175315',
      eids: [BRIAN],
      sasGet,
      loadSession,
      cache,
    });

    const detailCalls = calls
      .slice(callsAfterFirst)
      .filter(
        (c) =>
          c.path.includes('employees') ||
          c.path.includes('store-field') ||
          c.path.includes('field-app/shifts')
      );
    assert.deepEqual(detailCalls, []);
    assert.equal(second.visits[0].store_number, 215);
  });

  it('skips deleted field-data rows', async () => {
    async function sasGet(_token, path) {
      if (path === '/operations/field-data/') {
        return [
          {
            id: 1,
            scheduled_date: '2026-07-08',
            current_status: 'deleted',
            store_name: { number: 53 },
          },
        ];
      }
      throw new Error(`should not fetch ${path}`);
    }
    const result = await pullPeriodMileage({
      startDate: '2026-07-08',
      endDate: '2026-07-08',
      supervisorId: '800175315',
      eids: [BRIAN],
      sasGet,
      loadSession: async () => ({ token: 't' }),
      includeTravel: false,
    });
    assert.equal(result.visitCount, 0);
    assert.equal(result.visits.length, 0);
  });

  it('requires supervisorId via opts', async () => {
    await assert.rejects(
      () =>
        pullPeriodMileage({
          startDate: '2026-07-08',
          endDate: '2026-07-08',
        }),
      /supervisorId/
    );
  });
});
