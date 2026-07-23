// shiftday.js — D8 Shift Day surface (mobile-first, read-only visit match indicators)

import {
  WORK_DAYS,
  api,
  loadMe,
  signOut,
  dateForDay,
  shortDate,
  toast,
  setSaveState,
  stopSelectBubble,
  shiftRunStatus,
  shiftRunStatusBadgeHtml,
  shiftScopeBadgesHtml,
  resolveShiftScopeTags,
  fullDayName,
} from '/shared.js';
import { createVisitFlowController } from '/visit-flow-ui.js';
import { initAppShell } from '/ux/app-shell.js';
import { mountThemeToggle } from '/ux/theme.js';
import { beginBusy, endBusy } from '/ux/buffering.js';
import { needsProdSync, markProdSynced } from '/ux/prod-sync.js';
import {
  getCachedSchedule,
  putCachedSchedule,
  getCachedWeeks,
  putCachedWeeks,
  getCachedDrafts,
  putCachedDrafts,
  getCachedMatch,
  putCachedMatch,
  startScheduleWarmth,
  registerAppServiceWorker,
  preloadFieldData,
} from '/ux/schedule-cache.js';

const state = {
  user: null,
  repKey: null,
  rep: null,
  weeks: [],
  weekIndex: 0,
  shifts: [],
  matchByShift: {},
  draftByShift: {}, // `${date}-${actualStore}` -> draft summary (in-progress pill)
  dirtyMoves: [],
  selected: null,
  supervisorId: localStorage.getItem('cp_supervisor_id') || '800175315',
};

const $ = (id) => document.getElementById(id);

function draftKey(date, actualStore) {
  return `${date}-${actualStore}`;
}

const visitFlow = createVisitFlowController({
  $,
  getRepKey: () => state.repKey,
  isAdmin: () => !!state.user?.isAdmin,
  onDraftChanged: (draft) => {
    state.draftByShift[draftKey(draft.date, draft.actualStore)] = draft;
    renderCalendar();
  },
});

function currentWeek() {
  return state.weeks[state.weekIndex];
}

function defaultWeekIndex(weeks) {
  const today = new Date().toISOString().slice(0, 10);
  const containing = weeks.findIndex((w) => w.start <= today && today <= w.end);
  if (containing >= 0) return containing;
  const upcoming = weeks.findIndex((w) => w.start > today);
  return upcoming >= 0 ? upcoming : 0;
}

async function resolveRepKey() {
  const params = new URLSearchParams(location.search);
  const qRep = params.get('rep');

  // Admin deep-link / preview: open a specific rep's Shift Day
  if (state.user?.isAdmin && qRep) {
    return qRep;
  }

  const mapped = state.user?.email
    ? (await api('/shift-day/reps')).find((r) =>
        (r.emails || []).map((e) => e.toLowerCase()).includes(state.user.email.toLowerCase())
      )
    : null;
  if (mapped) return mapped.repKey;

  // Non-admin with ?rep= only if it matches nothing → still fall through to picker
  if (qRep && state.user?.isAdmin) return qRep;

  const saved = localStorage.getItem('cp_shift_rep');
  if (saved) return saved;

  const reps = await api('/shift-day/reps');
  const sel = $('sdRepSelect');
  sel.innerHTML = reps
    .map((r) => `<option value="${r.repKey}">${r.name}</option>`)
    .join('');
  $('sdLoading').hidden = true;
  $('sdPicker').hidden = false;

  return new Promise((resolve) => {
    $('btnSdRepSave').onclick = () => {
      const key = sel.value;
      localStorage.setItem('cp_shift_rep', key);
      $('sdPicker').hidden = true;
      resolve(key);
    };
  });
}

function shiftsByDay() {
  const map = Object.fromEntries(WORK_DAYS.map((d) => [d, []]));
  for (const s of state.shifts) {
    const day = s.dayOfWeek || WORK_DAYS[0];
    if (!map[day]) map[day] = [];
    map[day].push(s);
  }
  for (const day of WORK_DAYS) {
    map[day].sort((a, b) => String(a.shiftStart || '').localeCompare(String(b.shiftStart || '')));
  }
  return map;
}

function matchDot(shift) {
  const m = state.matchByShift[shift.id];
  if (!m || m.status === 'unknown') {
    return `<span class="match-dot match-unknown" title="Match not loaded">•</span>`;
  }
  if (m.status === 'matched') {
    return `<span class="match-dot match-ok" title="Prod visit ${m.visitId}">✓</span>`;
  }
  if (m.status === 'ambiguous') {
    return `<span class="match-dot match-bad" title="Ambiguous prod visits">!</span>`;
  }
  return `<span class="match-dot match-warn" title="No prod visit linked">?</span>`;
}

function runStatusForShift(s) {
  const draft = state.draftByShift[draftKey(s.date, s.actualStore)];
  // Prefer live match visitStatus when present (fresher than last week sync)
  const match = state.matchByShift[s.id];
  const visitStatus = match?.visitStatus || s.visitStatus || null;
  return shiftRunStatus({ visitStatus, draftStatus: draft?.status || null });
}

function badgeHtml(s) {
  const bits = [];
  const run = runStatusForShift(s);
  bits.push(shiftRunStatusBadgeHtml(run, { className: 'sd-badge' }));
  // Surface scope: Delivers {day} → Work Load → Write Order → Picks {day}
  bits.push(shiftScopeBadgesHtml(s, { className: 'sd-badge' }));
  return bits.join('');
}

function renderCalendar() {
  const byDay = shiftsByDay();
  const week = currentWeek();
  const el = $('sdCalendar');
  el.innerHTML = WORK_DAYS.map((day) => {
    const date = dateForDay(week.start, day);
    const pills = (byDay[day] || [])
      .map((s) => {
        const name = s.store?.name || '';
        const run = runStatusForShift(s);
        return `<button type="button" class="sd-pill run-${run.key}" data-id="${s.id}" title="${run.title.replace(/"/g, '&quot;')}">
          <span class="sd-pill-top">${matchDot(s)} <strong>${s.actualStore}</strong> ${name}</span>
          <span class="sd-pill-badges">${badgeHtml(s)}</span>
        </button>`;
      })
      .join('');
    return `<div class="day-col sd-day" data-day="${day}">
      <div class="day-head"><span>${day}</span><span class="day-date">${shortDate(date)}</span></div>
      <div class="day-body">${pills || '<div class="day-empty">No shifts</div>'}</div>
    </div>`;
  }).join('');

  el.querySelectorAll('.sd-pill').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.dataset.id));
  });
}

function openDetail(id) {
  const s = state.shifts.find((x) => String(x.id) === String(id));
  if (!s) return;
  state.selected = s;
  const addr = s.store;
  const isRedirect = s.redirected || (s.scheduledStore != null && Number(s.scheduledStore) !== Number(s.actualStore));
  $('sdDetailStore').textContent =
    `Store ${s.actualStore}${addr?.name ? ` — ${addr.name}` : ''}` +
    (isRedirect ? `  (PROD placeholder ${s.scheduledStore})` : '');
  $('sdDetailAddr').textContent = addr?.address || 'Address not on file';
  $('sdDetailBadges').innerHTML = badgeHtml(s);

  const m = state.matchByShift[s.id];
  const run = runStatusForShift(s);
  const matchEl = $('sdDetailMatch');
  const runLine = `Run status: ${run.label}${run.source ? ` (${run.source === 'prod' ? 'SAS PROD' : 'app'})` : ''}`;
  if (m?.status === 'matched') {
    matchEl.className = `sd-detail-match ok run-${run.key}`;
    matchEl.textContent = `${runLine} · Linked to prod visit ${m.visitId}${
      m.visitStatus ? ` · PROD ${m.visitStatus}` : s.visitStatus ? ` · PROD ${s.visitStatus}` : ''
    }`;
  } else if (m?.status === 'ambiguous') {
    matchEl.className = `sd-detail-match bad run-${run.key}`;
    matchEl.textContent = `${runLine} · Ambiguous — candidates: ${(m.candidates || []).join(', ')}`;
  } else if (m?.status === 'unmatched') {
    matchEl.className = `sd-detail-match warn run-${run.key}`;
    matchEl.textContent = `${runLine} · No matching prod visit yet`;
  } else {
    matchEl.className = `sd-detail-match run-${run.key}`;
    matchEl.textContent = `${runLine}${s.visitStatus ? ` · PROD ${s.visitStatus}` : ' · Visit match not loaded'}`;
  }

  const scope = resolveShiftScopeTags(s);
  $('sdDetailMeta').innerHTML = [
    ['Run status', run.label],
    ['PROD status', m?.visitStatus || s.visitStatus || '—'],
    [
      'Scope',
      scope.tags.map((t) => t.label).join(' · ') ||
        [s.workLoad && 'Work Load', s.writeOrder && 'Write Order'].filter(Boolean).join(' + ') ||
        '—',
    ],
    ['Delivers', fullDayName(scope.deliveryDay) || s.delivery || '—'],
    ['Picks', fullDayName(scope.picksDay) || '—'],
    ['Scheduled (placeholder)', s.scheduledStore ?? '—'],
    ['Shift', `${s.shiftStart || '—'} – ${s.shiftEnd || '—'}`],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  const slots = s.masterRoute?.slots || [];
  $('sdDetailRoute').innerHTML = slots.length
    ? `<h3>Master Route</h3>${slots
        .map(
          (sl) =>
            `<p class="sd-route-line"><strong>${sl.anchorServiceDay}</strong> · ${sl.action || 'visit'} · allowed ${
              (sl.allowedDays || []).join(', ') || '—'
            }</p>`
        )
        .join('')}`
    : '<p class="week-status">No Master Route slot for this store.</p>';

  const draft = state.draftByShift[draftKey(s.date, s.actualStore)];
  const startBtn = $('btnSdStartVisit');
  const abandonRow = $('sdAbandonRow');
  if (run.key === 'completed') {
    startBtn.textContent = draft ? 'View visit (completed in PROD)' : 'Completed in PROD';
    startBtn.disabled = !draft;
    if (abandonRow) abandonRow.hidden = true;
  } else if (draft?.status === 'ready_for_prod') {
    startBtn.textContent = 'View sealed visit';
    startBtn.disabled = false;
    if (abandonRow) abandonRow.hidden = true;
  } else if (draft?.status === 'in_progress') {
    startBtn.textContent = 'Resume visit';
    startBtn.disabled = false;
    if (abandonRow) abandonRow.hidden = false;
  } else {
    // PROD in-progress (rep punched in SAS) still allows app completion.
    startBtn.textContent =
      run.key === 'in_progress' ? 'Continue in app (PROD started)' : 'Start visit';
    startBtn.disabled = false;
    if (abandonRow) abandonRow.hidden = true;
  }

  const allowed = new Set(s.allowedDays || WORK_DAYS);
  const sel = $('sdMoveDay');
  sel.innerHTML = WORK_DAYS.map(
    (d) =>
      `<option value="${d}" ${d === s.dayOfWeek ? 'selected' : ''} ${allowed.has(d) ? '' : 'disabled'}>${d}${
        allowed.has(d) ? '' : ' (blocked)'
      }</option>`
  ).join('');
  stopSelectBubble(sel);

  $('sdOverlay').hidden = false;
}

function closeDetail() {
  $('sdOverlay').hidden = true;
  state.selected = null;
}

async function moveSelected() {
  const s = state.selected;
  if (!s) return;
  const day = $('sdMoveDay').value;
  if (day === s.dayOfWeek) {
    toast('Already on that day', 'info');
    return;
  }
  if (!(s.allowedDays || []).includes(day)) {
    toast(`Store ${s.actualStore} can't go on ${day}`, 'bad');
    return;
  }
  try {
    await api('/shift-day/move', {
      method: 'POST',
      body: JSON.stringify({
        repKey: state.repKey,
        weekStart: currentWeek().start,
        shiftId: s.id,
        dayOfWeek: day,
      }),
    });
    toast(`Store ${s.actualStore} moved to ${day}`, 'ok');
    closeDetail();
    await loadWeek();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function applyDraftList(drafts) {
  state.draftByShift = {};
  for (const d of drafts || []) state.draftByShift[draftKey(d.date, d.actualStore)] = d;
}

function applySchedulePayload(data, week) {
  if (!data) return;
  state.rep = data.rep;
  state.shifts = data.shifts || [];
  if ($('sdBannerTitle') && data.rep?.name) $('sdBannerTitle').textContent = data.rep.name;
  if ($('sdBannerMeta')) {
    $('sdBannerMeta').textContent = `${state.shifts.length} shifts · ${week?.label || ''}`.trim();
  }
  if ($('sdSubtitle') && data.rep?.name) $('sdSubtitle').textContent = data.rep.name;
  const stale = data.matchStale ? ' · MATCH STALE — tap Resync from PROD' : '';
  const synced = data.lastSyncedAt
    ? ` · last sync ${new Date(data.lastSyncedAt).toLocaleString()}`
    : '';
  if ($('sdWeekStatus')) {
    $('sdWeekStatus').textContent = data.source
      ? `Schedule source: ${data.source}${synced}${stale}`
      : `No schedule for this week yet — tap Resync from PROD${stale}`;
  }
  if ($('sdResyncHint')) {
    $('sdResyncHint').textContent = data.matchStale
      ? 'Schedule may be out of date — tap Resync from PROD.'
      : 'Uses the last saved week when fresh. Background refresh checks hourly.';
  }
}

async function loadMatch() {
  const week = currentWeek();
  if (!week) return;
  const cached = await getCachedMatch(state.repKey, week.start);
  if (cached) state.matchByShift = cached;
  try {
    const data = await api(
      `/shift-day/match-status?rep=${encodeURIComponent(state.repKey)}&weekStart=${week.start}&supervisorId=${encodeURIComponent(state.supervisorId)}`
    );
    state.matchByShift = data.byShift || {};
    await putCachedMatch(state.repKey, week.start, state.matchByShift);
  } catch {
    if (!cached) state.matchByShift = {};
  }
}

async function loadDrafts() {
  const cached = await getCachedDrafts(state.repKey);
  if (cached) applyDraftList(cached);
  try {
    const drafts = await api(`/shift-day/visit/mine?rep=${encodeURIComponent(state.repKey)}`);
    applyDraftList(drafts);
    await putCachedDrafts(state.repKey, drafts || []);
  } catch {
    if (!cached) state.draftByShift = {};
  }
}

/** In-flight sync promise so open/week-change/manual share one pull. */
let syncInFlight = null;

/**
 * Pull week from SAS PROD. Does not reload the calendar (caller does loadWeek).
 * @param {{ silent?: boolean }} opts silent=true for auto-open (less toast noise)
 */
async function pullWeekFromProd({ silent = false } = {}) {
  const week = currentWeek();
  if (!week) return null;
  if (syncInFlight) return syncInFlight;

  const btn = $('btnSdResyncProd');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
  }
  if ($('sdWeekStatus')) {
    $('sdWeekStatus').textContent = silent
      ? `Syncing ${week.label} from PROD…`
      : `Resyncing ${week.label} from PROD…`;
  }

  syncInFlight = (async () => {
    try {
      if (!silent) toast('Resyncing week from PROD…', 'ok', 3000);
      const data = await api('/shift-day/sync-from-prod', {
        busy: 'Syncing from PROD…',
        busyForce: true,
        method: 'POST',
        body: JSON.stringify({
          weekStart: week.start,
          supervisorId: state.supervisorId,
        }),
      });
      markProdSynced(week.start);
      const n = data.shiftCount ?? 0;
      const matched = data.matchSummary?.matched;
      const msg =
        `PROD sync: ${n} shift(s)` +
        (matched != null ? ` · ${matched} matched` : '') +
        (data.matchError ? ` · match warn: ${data.matchError}` : '');
      if (!silent) toast(msg, 'ok', 5000);
      else toast(msg, 'ok', 2200);
      return data;
    } finally {
      syncInFlight = null;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Resync from PROD';
      }
    }
  })();

  return syncInFlight;
}

/**
 * @param {{ resync?: boolean|'auto', silent?: boolean, force?: boolean }} opts
 * true = always pull · false = never · 'auto' = only when stale/missing/first open
 */
async function loadWeek({ resync = false, silent = false, force = false } = {}) {
  const week = currentWeek();
  if (!week) return;
  $('sdWeekTitle').textContent = week.label;
  $('sdWeekDates').textContent = `${shortDate(week.start)} – ${shortDate(week.end)}`;
  $('sdWeekSelect').value = String(state.weekIndex);

  // Instant paint from IndexedDB so tab switches don't wait on the network.
  const idbSchedule = await getCachedSchedule(state.repKey, week.start);
  if (idbSchedule) {
    applySchedulePayload(idbSchedule, week);
    const idbDrafts = await getCachedDrafts(state.repKey);
    if (idbDrafts) applyDraftList(idbDrafts);
    const idbMatch = await getCachedMatch(state.repKey, week.start);
    if (idbMatch) state.matchByShift = idbMatch;
    renderCalendar();
  }

  // Peek server schedule (fast local API) so auto can see matchStale / lastSyncedAt
  let peek = idbSchedule;
  if (resync === 'auto' && !force) {
    try {
      peek = await api(
        `/shift-day/schedule?rep=${encodeURIComponent(state.repKey)}&weekStart=${week.start}`
      );
    } catch {
      peek = idbSchedule;
    }
  }

  let doSync = false;
  if (resync === true || force) {
    doSync = true;
  } else if (resync === 'auto') {
    doSync = needsProdSync(week.start, {
      matchStale: !!peek?.matchStale,
      hasSchedule: week.hasSchedule !== false && !!(peek?.shifts?.length || peek?.source),
      lastSyncedAt: peek?.lastSyncedAt || week.lastSyncedAt || null,
      shiftCount: peek?.shifts?.length ?? null,
    });
  }

  if (doSync) {
    try {
      await pullWeekFromProd({ silent });
      peek = null; // force re-fetch after sync
    } catch (err) {
      const msg = err.message || '';
      const sessionHint = /sas_session_|No sas-auth session|session stale/i.test(msg)
        ? ' — SAS auth is refreshing in the background; try Resync from PROD in a moment'
        : '';
      toast(
        `PROD sync failed — showing last saved schedule. ${msg}${sessionHint}`.trim(),
        'bad',
        7000
      );
    }
  }

  let data = peek;
  if (!data) {
    try {
      data = await api(
        `/shift-day/schedule?rep=${encodeURIComponent(state.repKey)}&weekStart=${week.start}`
      );
    } catch (err) {
      if (idbSchedule) {
        data = idbSchedule;
        toast('Showing cached schedule (offline or slow network)', 'warn', 3500);
      } else {
        throw err;
      }
    }
  }
  // Fresh enough without a new PROD pull — still mark session so sibling pages skip
  if (!doSync && data?.lastSyncedAt) markProdSynced(week.start);

  applySchedulePayload(data, week);
  await putCachedSchedule(state.repKey, week.start, data);

  await loadMatch();
  await loadDrafts();
  renderCalendar();
  setSaveState($('sdSaveState'), false);
  $('btnSdSave').disabled = true;
}

async function resyncFromProd() {
  try {
    await loadWeek({ resync: true, silent: false, force: true });
  } catch (err) {
    toast(err.message || 'Resync failed', 'bad', 6000);
  }
}

/**
 * Pull the week from PROD (auth warms itself via sas-beacon in the background).
 */
async function refreshConnectionAndSchedule() {
  const btn = $('btnSdRefresh');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
  }
  try {
    beginBusy('Refreshing schedule…', { force: true });
    // Nudge silent auth if beacon is present; do not toast or block on it
    try {
      await window.cpSasBeacon?.refresh?.();
    } catch {
      /* optional */
    }
    await loadWeek({ resync: true, silent: false, force: true });
    toast('Schedule refreshed from PROD', 'ok', 3000);
  } catch (err) {
    toast(err.message || 'Refresh failed', 'bad', 6000);
  } finally {
    endBusy();
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }
}

async function init() {
  try {
    beginBusy('Loading Shift Day…', { force: true });
    state.user = await loadMe();
  } catch {
    endBusy();
    $('sdLoading').textContent = 'Sign in required';
    return;
  }

  if (state.user.isAdmin && !new URLSearchParams(location.search).has('preview')) {
    // Admins can still preview Shift Day with ?preview=1
  }

  $('userBar').hidden = false;
  $('userEmail').textContent = state.user.email;
  $('btnSignOut').onclick = signOut;
  initAppShell({
    isAdmin: !!state.user.isAdmin,
    active: 'shiftday',
    bottomNav: true,
    navGuard: {
      hasBlockingWork: () => (visitFlow.photoQueueSnapshot?.()?.inFlight || 0) > 0,
      isVisitOpen: () => !!visitFlow.getDraft?.(),
    },
  });
  // Same Night/Light/Auto control as the schedule page user bar — available
  // inside the visit workspace sidebar (topbar is hidden while a visit is open).
  const sidebarTheme = $('vfSidebarTheme');
  if (sidebarTheme && !sidebarTheme.querySelector('[data-theme-toggle]')) {
    mountThemeToggle(sidebarTheme);
  }

  state.repKey = await resolveRepKey();
  $('sdLoading').hidden = true;
  $('sdPicker').hidden = true;
  $('sdApp').hidden = false;
  $('sdSticky').hidden = false;

  // Prefer IDB weeks for instant week chrome; refresh from network.
  const cachedWeeks = await getCachedWeeks();
  if (cachedWeeks?.length) {
    state.weeks = cachedWeeks;
    state.weekIndex = defaultWeekIndex(state.weeks);
  }
  try {
    state.weeks = await api('/shift-day/weeks');
    await putCachedWeeks(state.weeks);
  } catch (err) {
    if (!state.weeks?.length) throw err;
    toast('Using cached weeks (network slow)', 'warn', 2800);
  }
  state.weekIndex = defaultWeekIndex(state.weeks);
  const params = new URLSearchParams(location.search);
  const qWeek = params.get('weekStart');
  if (qWeek) {
    const idx = state.weeks.findIndex((w) => w.start === qWeek);
    if (idx >= 0) state.weekIndex = idx;
  }
  $('sdWeekSelect').innerHTML = state.weeks
    .map(
      (w, i) =>
        `<option value="${i}">${w.label}${w.hasSchedule ? '' : ' · resync needed'}</option>`
    )
    .join('');

  $('sdWeekSelect').onchange = async () => {
    state.weekIndex = Number($('sdWeekSelect').value);
    await loadWeek({ resync: 'auto', silent: true });
  };
  $('btnSdPrev').onclick = async () => {
    if (state.weekIndex > 0) {
      state.weekIndex -= 1;
      await loadWeek({ resync: 'auto', silent: true });
    }
  };
  $('btnSdNext').onclick = async () => {
    if (state.weekIndex < state.weeks.length - 1) {
      state.weekIndex += 1;
      await loadWeek({ resync: 'auto', silent: true });
    }
  };
  $('btnSdRefresh')?.addEventListener('click', () => refreshConnectionAndSchedule());
  $('btnSdResyncProd')?.addEventListener('click', () => resyncFromProd());
  $('sdOverlayClose').onclick = closeDetail;
  $('sdOverlay').addEventListener('click', (e) => {
    if (e.target === $('sdOverlay')) closeDetail();
  });
  $('btnSdMove').onclick = moveSelected;
  function todayIsoLocal() {
    const n = new Date();
    const y = n.getFullYear();
    const m = String(n.getMonth() + 1).padStart(2, '0');
    const d = String(n.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatShiftDay(iso) {
    try {
      return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  }

  function hideStartConfirm() {
    const m = $('vfStartConfirm');
    if (m) m.hidden = true;
  }

  function hideAbandonConfirm() {
    const m = $('vfAbandonConfirm');
    if (m) m.hidden = true;
  }

  function showStartConfirm(s) {
    const modal = $('vfStartConfirm');
    if (!modal) return;
    const today = todayIsoLocal();
    const dayLabel = formatShiftDay(s.date);
    const runForConfirm = runStatusForShift(s);
    const prodInProgress = runForConfirm.key === 'in_progress' && runForConfirm.source === 'prod';
    $('vfStartConfirmBody').textContent = prodInProgress
      ? 'This visit is already started in SAS PROD. Opening it here lets you finish photos, times, mileage, and seal so PROD and the app stay in sync. Confirm the day and store before continuing.'
      : 'This starts a local visit draft in the app only (not SAS / PROD). Confirm the day and store before continuing.';
    $('vfStartConfirmList').innerHTML = [
      `<li><strong>Day:</strong> ${dayLabel}</li>`,
      `<li><strong>Store:</strong> FM${String(s.actualStore).padStart(3, '0')}${
        s.store?.name ? ` — ${s.store.name}` : ''
      }</li>`,
      s.scheduledStore != null && Number(s.scheduledStore) !== Number(s.actualStore)
        ? `<li><strong>Scheduled placeholder:</strong> ${s.scheduledStore} (decoded to ${s.actualStore})</li>`
        : '',
      prodInProgress
        ? `<li><strong>PROD:</strong> Already in progress — app will complete remaining work and write back when sealed/transmitted</li>`
        : '',
      `<li><strong>Scope:</strong> ${resolveShiftScopeTags(s).tags.map((t) => t.label).join(' · ') || 'Service'}</li>`,
    ]
      .filter(Boolean)
      .join('');
    const warn = $('vfStartConfirmWarn');
    if (s.date !== today) {
      warn.hidden = false;
      warn.textContent =
        s.date > today
          ? `⚠ This is a FUTURE day (today is ${formatShiftDay(today)}). Only continue if you really mean to work this visit early.`
          : `⚠ This is NOT today (today is ${formatShiftDay(today)}). Only continue if you are correcting a past visit.`;
    } else {
      warn.hidden = true;
      warn.textContent = '';
    }
    modal.hidden = false;
    $('vfStartConfirmOk').onclick = async () => {
      hideStartConfirm();
      try {
        await visitFlow.open({ ...s, weekStart: currentWeek().start });
        closeDetail();
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    $('vfStartConfirmCancel').onclick = hideStartConfirm;
    $('vfStartConfirmBackdrop').onclick = hideStartConfirm;
  }

  async function openVisitForSelected() {
    const s = state.selected;
    if (!s) return;
    const draft = state.draftByShift[draftKey(s.date, s.actualStore)];
    // Resume / view sealed: no "start" confirm
    if (draft?.status === 'in_progress' || draft?.status === 'ready_for_prod') {
      try {
        await visitFlow.open({ ...s, weekStart: currentWeek().start });
        closeDetail();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
    showStartConfirm(s);
  }

  function showAbandonConfirm(s) {
    const modal = $('vfAbandonConfirm');
    if (!modal || !s) return;
    $('vfAbandonConfirmDetail').textContent = `${formatShiftDay(s.date)} · FM${String(s.actualStore).padStart(3, '0')}`;
    modal.hidden = false;
    $('vfAbandonConfirmOk').onclick = async () => {
      hideAbandonConfirm();
      try {
        const openDraft = visitFlow.getDraft?.();
        if (
          openDraft &&
          openDraft.date === s.date &&
          Number(openDraft.actualStore) === Number(s.actualStore)
        ) {
          await visitFlow.abandon();
        } else {
          await api('/shift-day/visit/abandon', {
            method: 'POST',
            body: JSON.stringify({
              repKey: state.repKey,
              date: s.date,
              actualStore: s.actualStore,
            }),
          });
          toast('Visit discarded — not started in PROD', 'ok', 4000);
        }
        delete state.draftByShift[draftKey(s.date, s.actualStore)];
        closeDetail();
        await loadWeek();
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    $('vfAbandonConfirmCancel').onclick = hideAbandonConfirm;
    $('vfAbandonConfirmBackdrop').onclick = hideAbandonConfirm;
  }

  $('btnSdStartVisit').onclick = () => openVisitForSelected();
  $('btnSdAbandonVisit')?.addEventListener('click', () => {
    if (state.selected) showAbandonConfirm(state.selected);
  });
  // Abandon from inside visit workspace
  $('vfAbandon')?.addEventListener('click', () => {
    const d = visitFlow.getDraft?.();
    if (!d) return;
    showAbandonConfirm({
      date: d.date,
      actualStore: d.actualStore,
    });
  });

  // Cached week when fresh; PROD only if stale / missing / first session open
  await loadWeek({ resync: 'auto', silent: true });

  // Hourly quiet refresh + shell SW for faster return visits
  startScheduleWarmth({
    api,
    getRepKey: () => state.repKey,
    getWeekStart: () => currentWeek()?.start || null,
    onUpdated: ({ schedule, drafts }) => {
      const week = currentWeek();
      if (!week || !schedule) return;
      applySchedulePayload(schedule, week);
      if (drafts) applyDraftList(drafts);
      renderCalendar();
    },
  });
  registerAppServiceWorker();
  preloadFieldData({ api, repKey: state.repKey, weekStart: currentWeek()?.start }).catch(() => {});

  // SAS auth recovered (silent beacon) → quiet schedule pull
  window.addEventListener('cp-sas-auth', (ev) => {
    if (ev?.detail?.ok && (ev.detail.recovered || !ev.detail.silent)) {
      loadWeek({ resync: true, silent: true, force: true }).catch(() => {});
    }
  });

  // Deep-link from dashboard: open a specific store shift
  const qDate = params.get('date');
  const qStore = params.get('store');
  if (qDate && qStore != null) {
    const hit = state.shifts.find(
      (s) => String(s.date) === String(qDate) && Number(s.actualStore) === Number(qStore)
    );
    if (hit) openDetail(hit.id);
  }
  endBusy();
}

init().catch((err) => {
  endBusy();
  $('sdLoading').hidden = true;
  $('sdError').hidden = false;
  $('sdError').textContent = err.message;
});
