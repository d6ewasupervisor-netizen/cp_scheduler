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
} from '/shared.js';
import { createVisitFlowController } from '/visit-flow-ui.js';

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

function badgeHtml(s) {
  const bits = [];
  if (s.workLoad) bits.push('<span class="sd-badge load">LOAD</span>');
  if (s.writeOrder) bits.push('<span class="sd-badge order">ORDER</span>');
  if (s.picksDay) bits.push(`<span class="sd-badge picks">PICKS ${s.picksDay}</span>`);
  const draft = state.draftByShift[draftKey(s.date, s.actualStore)];
  if (draft?.status === 'ready_for_prod') bits.push('<span class="sd-badge visit-done">VISIT SEALED</span>');
  else if (draft?.status === 'in_progress') bits.push('<span class="sd-badge visit-progress">VISIT IN PROGRESS</span>');
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
        return `<button type="button" class="sd-pill" data-id="${s.id}">
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
  $('sdDetailStore').textContent = `Store ${s.actualStore}${addr?.name ? ` — ${addr.name}` : ''}`;
  $('sdDetailAddr').textContent = addr?.address || 'Address not on file';
  $('sdDetailBadges').innerHTML = badgeHtml(s);

  const m = state.matchByShift[s.id];
  const matchEl = $('sdDetailMatch');
  if (m?.status === 'matched') {
    matchEl.className = 'sd-detail-match ok';
    matchEl.textContent = `Linked to prod visit ${m.visitId}`;
  } else if (m?.status === 'ambiguous') {
    matchEl.className = 'sd-detail-match bad';
    matchEl.textContent = `Ambiguous — candidates: ${(m.candidates || []).join(', ')}`;
  } else if (m?.status === 'unmatched') {
    matchEl.className = 'sd-detail-match warn';
    matchEl.textContent = 'No matching prod visit yet';
  } else {
    matchEl.className = 'sd-detail-match';
    matchEl.textContent = 'Visit match not loaded';
  }

  $('sdDetailMeta').innerHTML = [
    ['Type', [s.workLoad && 'Work load', s.writeOrder && 'Write order'].filter(Boolean).join(' + ') || '—'],
    ['Delivery', s.delivery || '—'],
    ['Picks', s.picksDay || '—'],
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
  if (draft?.status === 'ready_for_prod') {
    startBtn.textContent = 'View sealed visit';
    startBtn.disabled = false;
    if (abandonRow) abandonRow.hidden = true;
  } else if (draft?.status === 'in_progress') {
    startBtn.textContent = 'Resume visit';
    startBtn.disabled = false;
    if (abandonRow) abandonRow.hidden = false;
  } else {
    startBtn.textContent = 'Start visit';
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

async function loadMatch() {
  try {
    const data = await api(
      `/shift-day/match-status?rep=${encodeURIComponent(state.repKey)}&weekStart=${currentWeek().start}&supervisorId=${encodeURIComponent(state.supervisorId)}`
    );
    state.matchByShift = data.byShift || {};
  } catch {
    state.matchByShift = {};
  }
}

async function loadDrafts() {
  try {
    const drafts = await api(`/shift-day/visit/mine?rep=${encodeURIComponent(state.repKey)}`);
    state.draftByShift = {};
    for (const d of drafts) state.draftByShift[draftKey(d.date, d.actualStore)] = d;
  } catch {
    state.draftByShift = {};
  }
}

async function loadWeek() {
  const week = currentWeek();
  $('sdWeekTitle').textContent = week.label;
  $('sdWeekDates').textContent = `${shortDate(week.start)} – ${shortDate(week.end)}`;
  $('sdWeekSelect').value = String(state.weekIndex);

  const data = await api(
    `/shift-day/schedule?rep=${encodeURIComponent(state.repKey)}&weekStart=${week.start}`
  );
  state.rep = data.rep;
  state.shifts = data.shifts || [];
  $('sdBannerTitle').textContent = data.rep.name;
  $('sdBannerMeta').textContent = `${state.shifts.length} shifts · ${week.label}`;
  $('sdSubtitle').textContent = data.rep.name;
  const stale = data.matchStale ? ' · MATCH STALE — tap Resync from PROD' : '';
  const synced = data.lastSyncedAt ? ` · last sync ${new Date(data.lastSyncedAt).toLocaleString()}` : '';
  $('sdWeekStatus').textContent = data.source
    ? `Schedule source: ${data.source}${synced}${stale}`
    : `No schedule for this week yet — tap Resync from PROD${stale}`;
  if ($('sdResyncHint')) {
    $('sdResyncHint').textContent = data.matchStale
      ? 'Schedule may be out of date after a move or PROD change — resync recommended.'
      : 'Pulls the latest visits from SAS so stores and match status stay current.';
  }

  await loadMatch();
  await loadDrafts();
  renderCalendar();
  setSaveState($('sdSaveState'), false);
  $('btnSdSave').disabled = true;
}

async function resyncFromProd() {
  const week = currentWeek();
  if (!week) return;
  const btn = $('btnSdResyncProd');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
  }
  try {
    toast('Resyncing week from PROD…', 'ok', 4000);
    const data = await api('/shift-day/sync-from-prod', {
      method: 'POST',
      body: JSON.stringify({
        weekStart: week.start,
        supervisorId: state.supervisorId,
      }),
    });
    const n = data.shiftCount ?? 0;
    const matched = data.matchSummary?.matched;
    toast(
      `PROD resync: ${n} shift(s)` +
        (matched != null ? ` · ${matched} matched` : '') +
        (data.matchError ? ` · match warn: ${data.matchError}` : ''),
      'ok',
      6000
    );
    await loadWeek();
  } catch (err) {
    toast(err.message || 'Resync failed', 'bad', 6000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Resync from PROD';
    }
  }
}

async function init() {
  try {
    state.user = await loadMe();
  } catch {
    $('sdLoading').textContent = 'Sign in required';
    return;
  }

  if (state.user.isAdmin && !new URLSearchParams(location.search).has('preview')) {
    // Admins can still preview Shift Day with ?preview=1
  }

  $('userBar').hidden = false;
  $('userEmail').textContent = state.user.email;
  $('btnSignOut').onclick = signOut;

  state.repKey = await resolveRepKey();
  $('sdLoading').hidden = true;
  $('sdPicker').hidden = true;
  $('sdApp').hidden = false;
  $('sdSticky').hidden = false;

  state.weeks = await api('/shift-day/weeks');
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
    await loadWeek();
  };
  $('btnSdPrev').onclick = async () => {
    if (state.weekIndex > 0) {
      state.weekIndex -= 1;
      await loadWeek();
    }
  };
  $('btnSdNext').onclick = async () => {
    if (state.weekIndex < state.weeks.length - 1) {
      state.weekIndex += 1;
      await loadWeek();
    }
  };
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
    $('vfStartConfirmBody').textContent =
      'This starts a local visit draft in the app only (not SAS / PROD). Confirm the day and store before continuing.';
    $('vfStartConfirmList').innerHTML = [
      `<li><strong>Day:</strong> ${dayLabel}</li>`,
      `<li><strong>Store:</strong> FM${String(s.actualStore).padStart(3, '0')}${
        s.store?.name ? ` — ${s.store.name}` : ''
      }</li>`,
      s.scheduledStore != null && Number(s.scheduledStore) !== Number(s.actualStore)
        ? `<li><strong>Scheduled placeholder:</strong> ${s.scheduledStore} (decoded to ${s.actualStore})</li>`
        : '',
      `<li><strong>Work:</strong> ${[s.workLoad && 'Work load', s.writeOrder && 'Write order'].filter(Boolean).join(' + ') || 'Service'}</li>`,
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

  await loadWeek();

  // Deep-link from dashboard: open a specific store shift
  const qDate = params.get('date');
  const qStore = params.get('store');
  if (qDate && qStore != null) {
    const hit = state.shifts.find(
      (s) => String(s.date) === String(qDate) && Number(s.actualStore) === Number(qStore)
    );
    if (hit) openDetail(hit.id);
  }
}

init().catch((err) => {
  $('sdLoading').hidden = true;
  $('sdError').hidden = false;
  $('sdError').textContent = err.message;
});
