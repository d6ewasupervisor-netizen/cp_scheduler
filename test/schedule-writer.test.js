'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildVisitCreateBody,
  buildNewVisitId,
  addMinutesToDisplayTime,
  isLiveScheduleWriteEnabled,
} = require('../src/lib/schedule-writer');

describe('schedule-writer helpers', () => {
  const sourceVisit = {
    cycle: 242142,
    shift_start_time: '06:05 AM',
    shift_end_time: '02:30 PM',
    scheduled_end_time: '14:30:00',
    estimated_shift_hours: '3.00',
    timezone_store: 'PDT',
    team: { id: 1692804, name: 'Central Pet 8B', teammates: [] },
    store: {
      id: 3254314,
      project: { id: 9293 },
      store: { id: 138, number: 391 },
    },
  };

  it('buildNewVisitId concatenates team+accountStore+project+cycle', () => {
    assert.equal(buildNewVisitId(sourceVisit), '16928041389293242142');
  });

  it('buildVisitCreateBody sets dest dates and store object', () => {
    const body = buildVisitCreateBody(sourceVisit, '2026-07-17');
    assert.equal(body.scheduled_date, '2026-07-17');
    assert.equal(body.due_by, '2026-07-17');
    assert.deepEqual(body.store, { id: 3254314 });
    assert.equal(body.team.id, 1692804);
    assert.equal(body.shift_start_time, '06:05 AM');
  });

  it('start offset bumps display time', () => {
    const body = buildVisitCreateBody(sourceVisit, '2026-07-17', { startOffsetMinutes: 3 });
    assert.equal(body.shift_start_time, '06:08 AM');
    assert.equal(addMinutesToDisplayTime('11:59 AM', 2), '12:01 PM');
  });

  it('isLiveScheduleWriteEnabled defaults off', () => {
    assert.equal(isLiveScheduleWriteEnabled({}), false);
    assert.equal(isLiveScheduleWriteEnabled({ LIVE_SCHEDULE_WRITE: '1' }), true);
  });
});
