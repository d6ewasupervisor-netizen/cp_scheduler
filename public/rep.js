// rep.js — "My Week" rep experience.
// Tap a store card to select it; eligible days light up; tap a day header to place.
// "Move to" select on each card is the fallback. One Save button, no admin surface.

import {
  WORK_DAYS,
  api,
  loadMe,
  signOut,
  repKeyOf,
  slotKey,
  findSlot,
  placementsByDay,
  taskLine,
  dateForDay,
  shortDate,
  isMobileLayout,
  validatePlacements,
  toast,
  setSaveState,
  isCoverageNeeded,
  coverageNeededCount,
  REP_AVAILABILITY,
} from '/shared.js';

const state = {
  user: null,
  repKey: null,
  rep: null,
  weeks: [],
  weekIndex: 0,
  placements: [],
  slots: [],
  draftId: null,
  selected: null, // selected placement (tap-to-place source)
  dirty: false,
};

const $ = (id) => document.getElementById(id);

/* ---------- Rep identity ---------- */

const isPreview = () => new URLSearchParams(location.search).has('preview');

async function resolveRepKey() {
  if (state.user.repKey) return state.user.repKey;
  const saved = localStorage.getItem('cp_my_rep');
  if (saved) return saved;

  const reps = await api('/reps');
  const sel = $('repPickerSelect');
  sel.innerHTML = reps
    .map(
      (r) =>
        `<option value="${encodeURIComponent(repKeyOf(r))}">${r.name} · ${r.visitSlots?.length || r.storeCount || 0} visits (D${r.district})</option>`
    )
    .join('');
  $('repLoading').hidden = true;
  $('repPicker').hidden = false;

  return new Promise((resolve) => {
    $('btnRepPickerSave').addEventListener('click', () => {
      const key = decodeURIComponent(sel.value);
      localStorage.setItem('cp_my_rep', key);
      $('repPicker').hidden = true;
      resolve(key);
    });
  });
}

function populateWeekSelect() {
  const sel = $('weekSelect');
  sel.innerHTML = state.weeks
    .map(
      (w, i) =>
        `<option value="${i}">${w.label} (${shortDate(w.start)} – ${shortDate(w.end)})</option>`
    )
    .join('');
  sel.value = String(state.weekIndex);
}

function updateRepBanner() {
  const banner = $('repBanner');
  if (!state.rep) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $('repBannerTitle').textContent = state.rep.name;
  const parts = [
    `District ${state.rep.district}`,
    `${state.placements.length} visit${state.placements.length === 1 ? '' : 's'} this week`,
  ];
  if (state.rep.isD8Pool) {
    parts.push('pick a suggested lead per store (planning only)');
  }
  $('repBannerMeta').textContent = parts.join(' · ');
  $('repSubtitle').textContent = state.rep.name;
}

/* ---------- Week loading ---------- */

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

async function loadWeek() {
  const week = currentWeek();
  state.rep = await api(`/reps/${encodeURIComponent(state.repKey)}`);
  state.slots = state.rep.visitSlots;

  const drafts = await api(
    `/schedule/draft?rep=${encodeURIComponent(state.repKey)}&weekStart=${week.start}`
  );
  if (drafts.length) {
    state.placements = drafts[0].placements;
    state.draftId = drafts[0].id;
  } else {
    const def = await api(
      `/schedule/default?rep=${encodeURIComponent(state.repKey)}&weekStart=${week.start}`
    );
    state.placements = def.placements;
    state.draftId = null;
  }

  state.selected = null;
  state.dirty = false;
  setSaveState($('saveState'), 'saved');
  await revalidate();
}

async function revalidate() {
  const week = currentWeek();
  const { warnings, allValid } = await validatePlacements(
    state.repKey,
    week.start,
    state.placements
  );
  render(warnings, allValid);
}

/* ---------- Rendering ---------- */

function render(warnings, allValid) {
  const week = currentWeek();
  if (!week) return;

  populateWeekSelect();
  $('weekTitle').textContent = week.label;
  $('weekDates').textContent = `${shortDate(week.start)} – ${shortDate(week.end)}`;
  $('btnPrevWeek').disabled = state.weekIndex === 0;
  $('btnNextWeek').disabled = state.weekIndex === state.weeks.length - 1;
  $('weekSelect').value = String(state.weekIndex);

  updateRepBanner();

  const invalidCount = state.placements.filter((p) => !p._valid).length;
  const coverageCount = state.rep.allowsRepAvailability
    ? coverageNeededCount(state.placements)
    : 0;
  let statusExtra = allValid
    ? '<span class="pass">All days check out</span>'
    : `<span class="fail">${invalidCount} on a day that doesn't work — tap them to fix</span>`;
  if (coverageCount) {
    statusExtra += ` · <span class="warn">${coverageCount} need coverage</span>`;
  }
  $('weekStatus').innerHTML = `${state.placements.length} visits · ${statusExtra}`;

  const byDay = placementsByDay(state.placements);
  const selectedSlot = state.selected ? findSlot(state.slots, state.selected) : null;

  const cal = $('calendar');
  cal.innerHTML = '';

  for (const day of WORK_DAYS) {
    const col = document.createElement('div');
    col.className = 'day-col';
    col.dataset.day = day;

    if (selectedSlot) {
      col.classList.add(selectedSlot.allowedDays.includes(day) ? 'eligible' : 'ineligible');
    }

    const date = dateForDay(week.start, day);
    col.innerHTML = `
      <div class="day-head">
        <span>${day} <small>${shortDate(date)}</small></span>
        <span class="day-count">${(byDay[day] || []).length ? byDay[day].length + ' visit' + (byDay[day].length > 1 ? 's' : '') : ''}</span>
      </div>
      <div class="day-body"></div>`;

    col.querySelector('.day-head').addEventListener('click', () => {
      if (!state.selected || !selectedSlot) return;
      placeSelectedOn(day, selectedSlot);
    });

    const body = col.querySelector('.day-body');
    for (const p of byDay[day] || []) {
      body.appendChild(makeChit(p));
    }
    cal.appendChild(col);
  }

  renderWarnings(warnings);
  $('repCoverageLegend').hidden = !state.rep?.allowsRepAvailability;
}

function scrollDayIntoView(day) {
  if (!isMobileLayout()) return;
  document
    .querySelector(`.day-col[data-day="${day}"]`)
    ?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
}

function placeSelectedOn(day, slot) {
  const p = state.selected;
  if (!slot.allowedDays.includes(day)) {
    toast(`Store ${p.storeNum} can't go on ${day}. Green days only.`, 'bad');
    return;
  }
  p.dayOfWeek = day;
  p.scheduledDate = dateForDay(currentWeek().start, day);
  state.selected = null;
  markDirty();
  toast(`Store ${p.storeNum} moved to ${day}`, 'ok', 1800);
  scrollDayIntoView(day);
  revalidate();
}

function makeChit(p) {
  const tpl = $('chitTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  const slot = findSlot(state.slots, p);

  if (!p._valid) el.classList.add('invalid');
  else if (isCoverageNeeded(p)) el.classList.add('needs-coverage');
  else if (state.rep.isD8Pool && !p.proposedAssignee) el.classList.add('unassigned');
  if (state.selected && slotKey(state.selected) === slotKey(p)) el.classList.add('selected');

  el.querySelector('.chit-store').textContent = `#${p.storeNum}`;
  el.querySelector('.chit-flag').textContent = !p._valid
    ? 'Wrong day'
    : isCoverageNeeded(p)
      ? 'Needs coverage'
      : state.rep.isD8Pool && !p.proposedAssignee
        ? 'Needs a name'
        : '';
  el.querySelector('.chit-task').textContent = taskLine(slot);
  el.querySelector('.chit-account').textContent = p.account || '';
  el.querySelector('.chit-action').textContent = (p.action || '').slice(0, 48);

  // D8 pool: pick who takes the visit
  if (state.rep.isD8Pool) {
    const wrap = el.querySelector('.chit-assignee-wrap');
    wrap.hidden = false;
    const select = wrap.querySelector('.chit-assignee');
    select.innerHTML =
      '<option value="">Choose…</option>' +
      (state.rep.proposedAssignees || [])
        .map(
          (a) =>
            `<option value="${a.name}"${p.proposedAssignee === a.name ? ' selected' : ''}>${a.label || a.name}</option>`
        )
        .join('');
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      p.proposedAssignee = select.value;
      markDirty();
      revalidate();
    });
  }

  // D1 rep (Patricia): mark visits Not Available when coverage is needed
  if (state.rep.allowsRepAvailability) {
    const wrap = el.querySelector('.chit-availability-wrap');
    wrap.hidden = false;
    const select = wrap.querySelector('.chit-availability');
    const current = p.repAvailability || REP_AVAILABILITY.AVAILABLE;
    select.innerHTML = `
      <option value="${REP_AVAILABILITY.AVAILABLE}"${current !== REP_AVAILABILITY.NOT_AVAILABLE ? ' selected' : ''}>Available</option>
      <option value="${REP_AVAILABILITY.NOT_AVAILABLE}"${current === REP_AVAILABILITY.NOT_AVAILABLE ? ' selected' : ''}>Not Available</option>`;
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      p.repAvailability = select.value;
      markDirty();
      revalidate();
    });
  }

  // Move-to fallback (always available)
  const moveSelect = el.querySelector('.chit-move-day');
  moveSelect.innerHTML = WORK_DAYS.map((day) => {
    const allowed = slot?.allowedDays.includes(day);
    return `<option value="${day}"${p.dayOfWeek === day ? ' selected' : ''}${allowed ? '' : ' disabled'}>${allowed ? day : day + ' — not allowed'}</option>`;
  }).join('');
  moveSelect.addEventListener('click', (e) => e.stopPropagation());
  moveSelect.addEventListener('change', () => {
    p.dayOfWeek = moveSelect.value;
    p.scheduledDate = dateForDay(currentWeek().start, moveSelect.value);
    markDirty();
    revalidate();
  });

  // Tap to select / deselect
  el.addEventListener('click', (e) => {
    if (e.target.closest('select')) return;
    state.selected =
      state.selected && slotKey(state.selected) === slotKey(p) ? null : p;
    showDetail(p);
    if (state.selected) scrollDayIntoView(p.dayOfWeek);
    revalidate();
  });

  return el;
}

function renderWarnings(warnings) {
  const warnEl = $('warnings');
  const d8Unassigned = state.rep.isD8Pool
    ? state.placements.filter((p) => !p.proposedAssignee).length
    : 0;
  const coverageCount = state.rep.allowsRepAvailability
    ? coverageNeededCount(state.placements)
    : 0;
  const all = [...warnings];
  if (coverageCount) {
    all.unshift({
      message: `${coverageCount} visit(s) marked Not Available — someone else will need to cover those shifts.`,
    });
  }
  if (d8Unassigned) {
    all.unshift({ message: `${d8Unassigned} visit(s) still need a name picked.` });
  }
  if (all.length) {
    warnEl.classList.add('show');
    warnEl.innerHTML =
      '<strong>Before you save</strong><ul>' +
      all.map((w) => `<li>${w.message}</li>`).join('') +
      '</ul>';
  } else {
    warnEl.classList.remove('show');
    warnEl.innerHTML = '';
  }
}

async function showDetail(p) {
  try {
    const detail = await api('/schedule/visit-detail', {
      method: 'POST',
      body: JSON.stringify({
        repKey: state.repKey,
        storeNum: p.storeNum,
        visitIndex: p.visitIndex ?? 0,
        placement: p,
      }),
    });
    const lines = [
      `Store #${detail.storeNum} — ${detail.account}`,
      detail.visitType,
      '',
      ...detail.brief,
      '',
      `Scheduled: ${detail.scheduledDay || '—'} (${detail.scheduledDate || '—'})`,
      p._valid ? 'Day works ✓' : 'Wrong day — move it to a green day',
    ];
    $('slotDetail').textContent = lines.join('\n');
    $('visitChecklist').innerHTML =
      '<div class="visit-type">Checklist</div><ul>' +
      detail.checklist.map((c) => `<li>${c}</li>`).join('') +
      '</ul>';
  } catch {
    $('slotDetail').textContent = 'Could not load visit details.';
    $('visitChecklist').innerHTML = '';
  }
}

/* ---------- Save ---------- */

function markDirty() {
  state.dirty = true;
  setSaveState($('saveState'), 'unsaved');
}

async function saveWeek() {
  const week = currentWeek();
  setSaveState($('saveState'), 'saving');
  try {
    const draft = await api('/schedule/draft', {
      method: 'POST',
      body: JSON.stringify({
        repKey: state.repKey,
        weekStart: week.start,
        weekEnd: week.end,
        weekLabel: week.label,
        placements: state.placements,
        createdBy: state.user?.email || 'rep',
      }),
    });
    state.draftId = draft.id;
    state.dirty = false;
    setSaveState($('saveState'), 'saved');
    toast('Week saved', 'ok');
  } catch (err) {
    setSaveState($('saveState'), 'unsaved');
    toast(`Save failed: ${err.message}`, 'bad', 5000);
  }
}

/* ---------- Week navigation ---------- */

async function changeWeek(delta) {
  if (state.dirty) {
    toast('Save your week first (or your changes will be lost)', 'warn');
    return;
  }
  const next = state.weekIndex + delta;
  if (next < 0 || next >= state.weeks.length) return;
  state.weekIndex = next;
  await loadWeek();
}

async function jumpToWeek(index) {
  if (state.dirty) {
    toast('Save your week first (or your changes will be lost)', 'warn');
    $('weekSelect').value = String(state.weekIndex);
    return;
  }
  const next = Number(index);
  if (!Number.isFinite(next) || next < 0 || next >= state.weeks.length) return;
  state.weekIndex = next;
  await loadWeek();
}

function showInitError(err) {
  $('repLoading').hidden = true;
  $('repApp').hidden = true;
  $('repPicker').hidden = true;
  const el = $('repError');
  el.hidden = false;
  el.textContent = `Could not load your schedule: ${err.message || err}. Try signing out and back in.`;
}

/* ---------- Init ---------- */

(async function init() {
  try {
    await window.cpAuth.bootPromise;
    state.user = await loadMe();

    if (state.user.layer === 'admin' && !isPreview()) {
      window.location.replace('/');
      return;
    }

    $('userEmail').textContent = state.user.email || '';
    $('userBar').hidden = false;

    state.weeks = await api('/weeks');
    state.weekIndex = defaultWeekIndex(state.weeks);
    populateWeekSelect();

    state.repKey = await resolveRepKey();

    $('repLoading').hidden = true;
    $('repApp').hidden = false;
    $('stickyBar').hidden = false;

    $('btnSave').addEventListener('click', saveWeek);
    $('btnPrevWeek').addEventListener('click', () => changeWeek(-1));
    $('btnNextWeek').addEventListener('click', () => changeWeek(1));
    $('weekSelect').addEventListener('change', (e) => jumpToWeek(e.target.value));
    $('btnSignOut').addEventListener('click', signOut);

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) e.preventDefault();
    });

    await loadWeek();
  } catch (err) {
    console.error('[rep]', err);
    showInitError(err);
  }
})();
