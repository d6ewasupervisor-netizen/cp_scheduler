// dashboard.js — mobile-first Central Pet team schedule board
import {
  WORK_DAYS,
  api,
  loadMe,
  signOut,
  dateForDay,
  shortDate,
  toast,
} from '/shared.js';

const state = {
  user: null,
  weeks: [],
  weekIndex: 0,
  reps: [],
  activeRepKey: null,
  schedules: {}, // repKey -> { rep, shifts, source }
  drafts: {}, // repKey -> { `${date}-${store}`: draft summary }
};

const $ = (id) => document.getElementById(id);

function defaultWeekIndex(weeks) {
  const today = new Date().toISOString().slice(0, 10);
  const containing = weeks.findIndex((w) => w.start <= today && today <= w.end);
  if (containing >= 0) return containing;
  const upcoming = weeks.findIndex((w) => w.start > today);
  return upcoming >= 0 ? upcoming : 0;
}

function draftKey(date, store) {
  return `${date}-${store}`;
}

function currentWeek() {
  return state.weeks[state.weekIndex];
}

function myMappedRep() {
  const email = (state.user?.email || '').toLowerCase();
  return state.reps.find((r) =>
    (r.emails || []).map((e) => e.toLowerCase()).includes(email)
  );
}

function canSeeAll() {
  return !!state.user?.isAdmin;
}

function visibleReps() {
  if (canSeeAll()) return state.reps;
  const mine = myMappedRep();
  return mine ? [mine] : [];
}

function showError(msg) {
  const el = $('dashError');
  el.hidden = !msg;
  el.textContent = msg || '';
}

function badgeHtml(shift, draft) {
  const bits = [];
  if (shift.workLoad) bits.push('<span class="dash-badge load">Load</span>');
  if (shift.writeOrder) bits.push('<span class="dash-badge order">Order</span>');
  if (shift.picksDay) bits.push(`<span class="dash-badge">Picks ${shift.picksDay}</span>`);
  if (draft?.status === 'ready_for_prod') bits.push('<span class="dash-badge sealed">Sealed</span>');
  else if (draft?.status === 'in_progress') bits.push('<span class="dash-badge progress">In progress</span>');
  return bits.length ? `<div class="dash-badges">${bits.join('')}</div>` : '';
}

function shiftTimeLabel(s) {
  const start = (s.shiftStart || '').slice(11, 16) || (s.shiftStart || '').slice(0, 5);
  const end = (s.shiftEnd || '').slice(11, 16) || (s.shiftEnd || '').slice(0, 5);
  if (start && end) return `${start}–${end}`;
  if (start) return start;
  return '';
}

function openShift(repKey, shift) {
  const params = new URLSearchParams();
  params.set('rep', repKey);
  params.set('date', shift.date);
  params.set('store', String(shift.actualStore));
  if (canSeeAll()) params.set('preview', '1');
  // Deep-link into Shift Day with session already on this origin
  location.assign(`/shiftday.html?${params.toString()}`);
}

function renderWho() {
  const el = $('dashWho');
  const name = state.user?.rep?.name || myMappedRep()?.name || state.user?.email || '';
  const layer = state.user?.isAdmin ? 'Admin' : 'Rep';
  el.innerHTML = `
    <span class="pill you"><strong>You</strong> ${name || state.user.email}</span>
    <span class="pill">${layer}</span>
    ${canSeeAll() ? '<span class="pill">Viewing all D8 schedules</span>' : '<span class="pill">Your schedule only</span>'}
  `;
  $('layerBadge').textContent = layer;
  $('layerBadge').className = `layer-badge ${state.user?.isAdmin ? 'admin' : 'rep'}`;
  $('linkPlanning').hidden = !state.user?.isAdmin;
}

function renderTabs() {
  const tabs = $('dashTabs');
  const reps = visibleReps();
  if (!canSeeAll() || reps.length <= 1) {
    tabs.hidden = true;
    tabs.innerHTML = '';
    return;
  }
  tabs.hidden = false;
  tabs.innerHTML = reps
    .map((r) => {
      const selected = r.repKey === state.activeRepKey;
      return `<button type="button" role="tab" aria-selected="${selected}" data-rep="${r.repKey}">${r.name.split(' ')[0]}</button>`;
    })
    .join('');
  tabs.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      state.activeRepKey = btn.dataset.rep;
      renderTabs();
      await ensureSchedule(state.activeRepKey);
      renderSchedule();
      updateFullShiftDayLink();
    };
  });
}

function updateFullShiftDayLink() {
  const params = new URLSearchParams();
  if (state.activeRepKey) params.set('rep', state.activeRepKey);
  if (canSeeAll()) params.set('preview', '1');
  const week = currentWeek();
  if (week?.start) params.set('weekStart', week.start);
  $('linkFullShiftDay').href = `/shiftday.html?${params.toString()}`;
}

function renderSchedule() {
  const week = currentWeek();
  const pack = state.schedules[state.activeRepKey];
  const el = $('dashSchedule');
  if (!pack) {
    el.innerHTML = `<p class="dash-empty">No schedule loaded.</p>`;
    return;
  }

  const drafts = state.drafts[state.activeRepKey] || {};
  const byDay = Object.fromEntries(WORK_DAYS.map((d) => [d, []]));
  for (const s of pack.shifts || []) {
    const day = s.dayOfWeek || WORK_DAYS[0];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(s);
  }

  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = WORK_DAYS.map((day) => {
    const date = dateForDay(week.start, day);
    const isToday = date === today;
    const shifts = (byDay[day] || []).sort((a, b) =>
      String(a.shiftStart || '').localeCompare(String(b.shiftStart || ''))
    );
    const cards =
      shifts
        .map((s) => {
          const draft = drafts[draftKey(s.date, s.actualStore)];
          const name = s.store?.name || '';
          const addr = s.store?.address || '';
          const time = shiftTimeLabel(s);
          return `<button type="button" class="dash-shift" data-id="${s.id}" data-store="${s.actualStore}" data-date="${s.date}">
            <div class="dash-shift-top">
              <div class="dash-shift-store">FM ${s.actualStore}${name ? ` <span>· ${name}</span>` : ''}</div>
              ${time ? `<div class="dash-shift-meta">${time}</div>` : ''}
            </div>
            ${addr ? `<div class="dash-shift-meta">${addr}</div>` : ''}
            ${badgeHtml(s, draft)}
          </button>`;
        })
        .join('') || `<div class="dash-empty">No shifts</div>`;

    return `<section class="dash-day" data-day="${day}" ${isToday ? 'data-today="1"' : ''}>
      <div class="dash-day-head">
        <h2>${day}${isToday ? ' · Today' : ''}</h2>
        <span class="date">${shortDate(date)}</span>
      </div>
      ${cards}
    </section>`;
  }).join('');

  el.querySelectorAll('.dash-shift').forEach((btn) => {
    btn.addEventListener('click', () => {
      const shift = (pack.shifts || []).find((s) => String(s.id) === String(btn.dataset.id));
      if (shift) openShift(state.activeRepKey, shift);
    });
  });

  // Scroll today into view on mobile
  const todayEl = el.querySelector('[data-today="1"]');
  if (todayEl) {
    setTimeout(() => todayEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }
}

async function ensureSchedule(repKey) {
  const week = currentWeek();
  if (!week) return;
  const cacheKey = `${repKey}:${week.start}`;
  if (state.schedules[repKey]?._weekStart === week.start) return;

  const data = await api(
    `/shift-day/schedule?rep=${encodeURIComponent(repKey)}&weekStart=${encodeURIComponent(week.start)}`
  );
  state.schedules[repKey] = { ...data, _weekStart: week.start };

  try {
    const drafts = await api(`/shift-day/visit/mine?rep=${encodeURIComponent(repKey)}`);
    const map = {};
    for (const d of drafts || []) map[draftKey(d.date, d.actualStore)] = d;
    state.drafts[repKey] = map;
  } catch {
    state.drafts[repKey] = {};
  }
}

let dashSyncInFlight = null;

/** Auto/manual PROD pull for the selected week (shared by open + Resync button). */
async function pullDashWeekFromProd({ silent = false } = {}) {
  const week = currentWeek();
  if (!week) return null;
  if (dashSyncInFlight) return dashSyncInFlight;

  const btn = $('btnDashResync');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
  }
  if ($('dashSubtitle')) {
    $('dashSubtitle').textContent = `Syncing ${week.label || week.start} from PROD…`;
  }

  dashSyncInFlight = (async () => {
    try {
      const data = await api('/shift-day/sync-from-prod', {
        method: 'POST',
        body: JSON.stringify({ weekStart: week.start }),
      });
      state.schedules = {};
      state.weeks = await api('/shift-day/weeks');
      const idx = state.weeks.findIndex((w) => w.start === week.start);
      if (idx >= 0) state.weekIndex = idx;
      if (!silent) {
        toast(
          `PROD sync: ${data.shiftCount ?? 0} shift(s)` +
            (data.matchSummary?.matched != null ? ` · ${data.matchSummary.matched} matched` : ''),
          'ok',
          4000
        );
      } else {
        toast(
          `Synced ${data.shiftCount ?? 0} shifts from PROD`,
          'ok',
          2500
        );
      }
      return data;
    } finally {
      dashSyncInFlight = null;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Resync from PROD';
      }
    }
  })();

  return dashSyncInFlight;
}

/**
 * @param {{ resync?: boolean, silent?: boolean }} opts
 */
async function loadActiveWeek({ resync = false, silent = false } = {}) {
  showError('');
  const week = currentWeek();
  if (!week) return;
  $('weekSelect').value = String(state.weekIndex);
  $('dashSubtitle').textContent = week.label || 'Team schedule';

  if (resync) {
    try {
      await pullDashWeekFromProd({ silent });
    } catch (e) {
      toast(
        `PROD sync failed — showing last saved schedule. ${e.message || ''}`.trim(),
        'bad',
        7000
      );
    }
  }

  const reps = visibleReps();
  if (!reps.length) {
    $('dashSchedule').innerHTML =
      '<p class="dash-empty">No Central Pet Shift Day schedule is mapped to your account. Contact your supervisor if you expected one.</p>';
    return;
  }
  if (!state.activeRepKey || !reps.some((r) => r.repKey === state.activeRepKey)) {
    state.activeRepKey = reps[0].repKey;
  }

  // Prefetch all visible reps for admin so tab switches are instant
  if (canSeeAll()) {
    await Promise.all(reps.map((r) => ensureSchedule(r.repKey).catch((e) => {
      console.warn('schedule load failed', r.repKey, e);
    })));
  } else {
    await ensureSchedule(state.activeRepKey);
  }

  renderTabs();
  renderSchedule();
  updateFullShiftDayLink();
  const w = currentWeek();
  if (w && $('dashSubtitle')) {
    $('dashSubtitle').textContent = w.label || 'Team schedule';
  }
}

async function init() {
  try {
    state.user = await loadMe();
  } catch {
    $('dashLoading').textContent = 'Sign in required';
    return;
  }

  $('userBar').hidden = false;
  $('userEmail').textContent = state.user.email;
  $('btnSignOut').onclick = signOut;

  try {
    state.reps = await api('/shift-day/reps');
    state.weeks = await api('/shift-day/weeks');
    state.weekIndex = defaultWeekIndex(state.weeks);

    const params = new URLSearchParams(location.search);
    const qRep = params.get('rep');
    if (qRep && (canSeeAll() || myMappedRep()?.repKey === qRep)) {
      state.activeRepKey = qRep;
    } else {
      state.activeRepKey = myMappedRep()?.repKey || (canSeeAll() ? state.reps[0]?.repKey : null);
    }
    const qWeek = params.get('weekStart');
    if (qWeek) {
      const idx = state.weeks.findIndex((w) => w.start === qWeek);
      if (idx >= 0) state.weekIndex = idx;
    }

    $('weekSelect').innerHTML = state.weeks
      .map(
        (w, i) =>
          `<option value="${i}">${w.label}${w.hasSchedule ? '' : ' · no export'}</option>`
      )
      .join('');

    $('weekSelect').onchange = async () => {
      state.weekIndex = Number($('weekSelect').value);
      state.schedules = {};
      await loadActiveWeek({ resync: true, silent: true });
    };
    $('btnPrevWeek').onclick = async () => {
      if (state.weekIndex > 0) {
        state.weekIndex -= 1;
        state.schedules = {};
        await loadActiveWeek({ resync: true, silent: true });
      }
    };
    $('btnNextWeek').onclick = async () => {
      if (state.weekIndex < state.weeks.length - 1) {
        state.weekIndex += 1;
        state.schedules = {};
        await loadActiveWeek({ resync: true, silent: true });
      }
    };

    $('btnDashResync')?.addEventListener('click', async () => {
      try {
        await loadActiveWeek({ resync: true, silent: false });
      } catch (e) {
        toast(e.message || 'Resync failed', 'bad', 5000);
      }
    });

    renderWho();
    $('dashLoading').hidden = true;
    $('dashApp').hidden = false;
    // Auto PROD sync on open
    await loadActiveWeek({ resync: true, silent: true });
  } catch (err) {
    $('dashLoading').hidden = true;
    showError(err.message || 'Could not load dashboard');
  }
}

init();
