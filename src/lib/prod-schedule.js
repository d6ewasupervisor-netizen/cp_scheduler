'use strict';

const fs = require('fs');
const path = require('path');
const { loadSasSession } = require('./sas-session');
const { getVisitStoreNumber, filterVisitsByStore } = require('./sas-store-match');
const { PROJECT_ID } = require('./constants');

async function sasGet(token, urlPath, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  const url = `https://prod.sasretail.com/api/v1${urlPath}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Token ${token}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const text = await res.text();
  const body = JSON.parse(text);
  if (!res.ok) throw new Error(`SAS ${res.status} ${urlPath}`);
  return body;
}

function rows(body) {
  return Array.isArray(body) ? body : body.results || [];
}

async function resolveCycle(token, weekStart, weekEnd) {
  const cycles = rows(
    await sasGet(token, '/projects/project-cycles/', {
      project: PROJECT_ID,
      page: 1,
      page_size: 100,
      sort: '-start_date',
    })
  );
  return (
    cycles.find((c) => c.start_date === weekStart && c.end_date === weekEnd) ||
    cycles.find((c) => weekStart >= c.start_date && weekEnd <= c.end_date)
  );
}

async function fetchProdSchedule(employeeId, weekStart, weekEnd) {
  const { token } = await loadSasSession();
  const cycle = await resolveCycle(token, weekStart, weekEnd);
  if (!cycle) return { cycle: null, shifts: [], error: 'No cycle found' };

  const visits = rows(
    await sasGet(token, '/team-scheduling/visits/', { cycle: cycle.id, page: 1, page_size: 500 })
  ).filter((v) => {
    const d = String(v.scheduled_date || '');
    return d >= weekStart && d <= weekEnd;
  });

  const shifts = [];
  for (const v of visits) {
    const batch = rows(
      await sasGet(token, '/team-scheduling/shifts/', { visit: v.id, page: 1, page_size: 50 })
    ).filter((s) => s.current_status !== 'deleted');
    const hers = batch.filter(
      (s) => Number(s.employee?.id ?? s.employee_id ?? s.employee) === Number(employeeId)
    );
    if (!hers.length) continue;
    const detail = await sasGet(token, `/team-scheduling/visits/${v.id}/`);
    for (const s of hers) {
      shifts.push({
        visitId: v.id,
        shiftId: s.id,
        scheduledDate: detail.scheduled_date || v.scheduled_date,
        storeNum: Number(getVisitStoreNumber(detail)),
        shiftStart: s.shift_start_time,
        shiftEnd: s.shift_end_time,
        visitStatus: detail.current_status,
      });
    }
  }

  shifts.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.storeNum - b.storeNum);
  return { cycle: { id: cycle.id, name: cycle.name }, shifts };
}

module.exports = { fetchProdSchedule, resolveCycle };
