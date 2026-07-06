// rep.js — "My Week" rep experience.
// Calendar grid with draggable store pills; tap a pill to expand details in an overlay.

import {
  WORK_DAYS,
  api,
  loadMe,
  signOut,
  repKeyOf,
  slotKey,
  findSlot,
  placementsByDay,
  orderTimingLine,
  dateForDay,
  shortDate,
  isMobileLayout,
  validatePlacements,
  toast,
  setSaveState,
  isCoverageNeeded,
  coverageNeededCount,
  applyRepAvailability,
  stopSelectBubble,
  chitFlagLabel,
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
  drag: null,
  expanded: null,
  dirty: false,
  lastValidationWarnings: [],
  lastAllValid: true,
};

let validateGen = 0;
let dragJustEnded = false;

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
  $('repBannerMeta').textContent = [
    `District ${state.rep.district}`,
    `${state.placements.length} visit${state.placements.length === 1 ? '' : 's'} this week`,
  ].join(' · ');
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

  state.drag = null;
  closeVisitOverlay();
  state.dirty = false;
  setSaveState($('saveState'), 'saved');
  await revalidate();
}

async function revalidate() {
  const gen = ++validateGen;
  const week = currentWeek();
  const { warnings, allValid } = await validatePlacements(
    state.repKey,
    week.start,
    state.placements
  );
  if (gen !== validateGen) return;
  render(warnings, allValid);
}

/* ---------- Rendering ---------- */

function render(warnings, allValid) {
  const week = currentWeek();
  if (!week) return;

  state.lastValidationWarnings = warnings;
  state.lastAllValid = allValid;

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
    : `<span class="fail">${invalidCount} on a day that doesn't work — move them to an allowed day</span>`;
  if (coverageCount) {
    statusExtra += ` · <span class="warn">${coverageCount} need coverage</span>`;
  }
  $('weekStatus').innerHTML = `${state.placements.length} visits · ${statusExtra}`;

  const byDay = placementsByDay(state.placements);
  const activePlacement = state.drag || state.expanded;
  const activeSlot = activePlacement ? findSlot(state.slots, activePlacement) : null;

  const cal = $('calendar');
  cal.innerHTML = '';

  for (const day of WORK_DAYS) {
    const col = document.createElement('div');
    col.className = 'day-col';
    col.dataset.day = day;

    if (activeSlot) {
      col.classList.add(activeSlot.allowedDays.includes(day) ? 'eligible' : 'ineligible');
    }

    const date = dateForDay(week.start, day);
    const count = (byDay[day] || []).length;
    col.innerHTML = `
      <div class="day-head">
        <span class="day-label">${day} <small>${shortDate(date)}</small></span>
        <span class="day-count">${count ? count + ' visit' + (count > 1 ? 's' : '') : ''}</span>
      </div>
      <div class="day-body"></div>`;

    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      const slot = state.drag ? findSlot(state.slots, state.drag) : null;
      const ok = slot?.allowedDays.includes(day);
      col.classList.toggle('drag-over-ok', !!ok);
      col.classList.toggle('drag-over-bad', !ok);
    });
    col.addEventListener('dragleave', () =>
      col.classList.remove('drag-over-ok', 'drag-over-bad')
    );
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drag-over-ok', 'drag-over-bad');
      if (!state.drag) return;
      const slot = findSlot(state.slots, state.drag);
      moveTo(state.drag, slot, day);
      state.drag = null;
    });

    const body = col.querySelector('.day-body');
    for (const p of byDay[day] || []) {
      body.appendChild(makePill(p));
    }
    cal.appendChild(col);
  }

  renderWarnings(warnings);
  $('repCoverageLegend').hidden =
    !state.rep?.allowsRepAvailability || coverageCount === 0;

  if (state.expanded) {
    highlightExpandedPill(state.expanded);
  }
}

function highlightExpandedPill(p) {
  document.querySelectorAll('.chit-pill.expanded').forEach((el) => el.classList.remove('expanded'));
  const key = slotKey(p);
  document.querySelectorAll('.chit-pill').forEach((el) => {
    if (el.dataset.key === key) el.classList.add('expanded');
  });
}

function scrollDayIntoView(day) {
  if (!isMobileLayout()) return;
  document
    .querySelector(`.day-col[data-day="${day}"]`)
    ?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
}

function moveTo(p, slot, day) {
  if (!slot?.allowedDays.includes(day)) {
    toast(
      `Store ${p.storeNum} can't go on ${day}. Allowed: ${slot?.allowedDays.join(', ') || 'none'}`,
      'bad'
    );
    return;
  }
  const moved = p.dayOfWeek !== day;
  p.dayOfWeek = day;
  p.scheduledDate = dateForDay(currentWeek().start, day);
  markDirty();
  if (moved) {
    toast(`Store ${p.storeNum} moved to ${day}`, 'ok', 1800);
    scrollDayIntoView(day);
  }
  if (state.expanded && slotKey(state.expanded) === slotKey(p)) {
    populateOverlayControls(p, slot);
  }
  revalidate();
}

function makePill(p) {
  const tpl = $('chitTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  const slot = findSlot(state.slots, p);

  el.dataset.key = slotKey(p);

  if (!p._valid) el.classList.add('invalid');
  else if (isCoverageNeeded(p)) el.classList.add('needs-coverage');

  const flag = chitFlagLabel(p, state.rep, { hideD8Lead: true });
  el.querySelector('.chit-store').textContent = `#${p.storeNum}`;
  const flagEl = el.querySelector('.chit-flag');
  if (flag && flag !== 'OK') {
    flagEl.textContent = flag;
    flagEl.title = flag;
  } else {
    flagEl.hidden = true;
  }

  el.draggable = !isMobileLayout();
  el.addEventListener('dragstart', (e) => {
    if (isMobileLayout()) {
      e.preventDefault();
      return;
    }
    state.drag = p;
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
    revalidate();
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    state.drag = null;
    dragJustEnded = true;
    setTimeout(() => {
      dragJustEnded = false;
    }, 0);
    revalidate();
  });

  el.addEventListener('click', () => {
    if (dragJustEnded) return;
    openVisitOverlay(p);
  });

  return el;
}

function renderWarnings(warnings) {
  const warnEl = $('warnings');
  const coverageCount = state.rep.allowsRepAvailability
    ? coverageNeededCount(state.placements)
    : 0;
  const all = [...warnings];
  if (coverageCount) {
    all.unshift({
      message: `${coverageCount} visit(s) marked Not Available — someone else will need to cover those shifts.`,
    });
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

/* ---------- Visit overlay ---------- */

function openVisitOverlay(p) {
  state.expanded = p;
  const slot = findSlot(state.slots, p);
  const overlay = $('visitOverlay');
  overlay.hidden = false;
  document.body.classList.add('overlay-open');

  $('overlayStore').textContent = `#${p.storeNum}`;
  const overlayFlag = chitFlagLabel(p, state.rep, { hideD8Lead: true });
  $('overlayFlag').textContent = overlayFlag || '';
  $('overlayFlag').hidden = !overlayFlag;
  $('overlayMeta').textContent = [
    orderTimingLine(slot, state.slots),
    p.account || '',
    (p.action || '').slice(0, 80),
  ]
    .filter(Boolean)
    .join(' · ');

  populateOverlayControls(p, slot);
  loadOverlayDetail(p);
  highlightExpandedPill(p);
  revalidate();
}

function populateOverlayControls(p, slot) {
  const moveSelect = $('overlayMoveDay');
  moveSelect.innerHTML = WORK_DAYS.map((day) => {
    const allowed = slot?.allowedDays.includes(day);
    return `<option value="${day}"${p.dayOfWeek === day ? ' selected' : ''}${allowed ? '' : ' disabled'}>${allowed ? day : day + ' — not allowed'}</option>`;
  }).join('');
  stopSelectBubble(moveSelect);
  moveSelect.onchange = () => moveTo(p, slot, moveSelect.value);

  const availWrap = $('overlayAvailWrap');
  if (state.rep.allowsRepAvailability) {
    availWrap.hidden = false;
    const availSelect = $('overlayAvailability');
    const current = p.repAvailability || REP_AVAILABILITY.AVAILABLE;
    availSelect.innerHTML = `
      <option value="${REP_AVAILABILITY.AVAILABLE}"${current !== REP_AVAILABILITY.NOT_AVAILABLE ? ' selected' : ''}>Available</option>
      <option value="${REP_AVAILABILITY.NOT_AVAILABLE}"${current === REP_AVAILABILITY.NOT_AVAILABLE ? ' selected' : ''}>Not Available</option>`;
    stopSelectBubble(availSelect);
    availSelect.onchange = () => {
      applyRepAvailability(p, availSelect.value);
      markDirty();
      $('overlayFlag').textContent = chitFlagLabel(p, state.rep, { hideD8Lead: true }) || '';
      loadOverlayDetail(p);
      revalidate();
    };
  } else {
    availWrap.hidden = true;
  }
}

async function loadOverlayDetail(p) {
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
      detail.visitType,
      '',
      ...detail.brief,
      '',
      `Scheduled: ${detail.scheduledDay || '—'} (${detail.scheduledDate || '—'})`,
      p._valid ? 'Day works ✓' : 'Wrong day — move to an allowed day',
    ];
    $('overlayDetail').textContent = lines.join('\n');
    $('overlayChecklist').innerHTML =
      '<div class="visit-type">Checklist</div><ul>' +
      detail.checklist.map((c) => `<li>${c}</li>`).join('') +
      '</ul>';
  } catch {
    $('overlayDetail').textContent = 'Could not load visit details.';
    $('overlayChecklist').innerHTML = '';
  }
}

function closeVisitOverlay() {
  state.expanded = null;
  $('visitOverlay').hidden = true;
  document.body.classList.remove('overlay-open');
  document.querySelectorAll('.chit-pill.expanded').forEach((el) => el.classList.remove('expanded'));
  revalidate();
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
    $('btnCloseOverlay').addEventListener('click', closeVisitOverlay);
    $('visitOverlayBackdrop').addEventListener('click', closeVisitOverlay);

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) e.preventDefault();
    });

    await loadWeek();
  } catch (err) {
    console.error('[rep]', err);
    showInitError(err);
  }
})();
