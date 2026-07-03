// admin.js — Planning Desk.
// Everything the rep view does (tap-to-place, Move-to) plus desktop drag-and-drop,
// rep/district/week switching, weekly templates, approve + handoff, PROD overlay.

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
  dayFromDate,
  dateForDay,
  shortDate,
  isMobileLayout,
  validatePlacements,
  toast,
  armButton,
  setSaveState,
  isCoverageNeeded,
  coverageNeededCount,
  d8UnassignedCount,
  stopSelectBubble,
  chitFlagLabel,
  REP_AVAILABILITY,
} from '/shared.js';

const state = {
  user: null,
  reps: [],
  rep: null,
  weeks: [],
  week: null,
  placements: [],
  slots: [],
  draftId: null,
  prodShifts: [],
  weeklyTemplate: null,
  placementSource: null,
  selected: null,
  drag: null,
  dirty: false,
};

const $ = (id) => document.getElementById(id);

function currentRepKey() {
  return decodeURIComponent($('repSelect').value);
}

/* ---------- Loaders ---------- */

async function loadWeeks() {
  const data = await api('/weeks');
  if (!Array.isArray(data) || !data.length) {
    throw new Error('No schedule weeks are available right now');
  }
  state.weeks = data;
  const sel = $('weekSelect');
  sel.innerHTML = state.weeks
    .map((w) => `<option value="${w.start}">${w.label} (${shortDate(w.start)} – ${shortDate(w.end)})</option>`)
    .join('');
  const today = new Date().toISOString().slice(0, 10);
  const current =
    state.weeks.find((w) => w.start <= today && today <= w.end) ||
    state.weeks.find((w) => w.start > today) ||
    state.weeks[0];
  if (current) sel.value = current.start;
}

async function loadReps() {
  const district = $('districtFilter').value;
  const q = district ? `?district=${district}` : '';
  const data = await api(`/reps${q}`);
  if (!Array.isArray(data)) {
    throw new Error('Could not load rep list');
  }
  state.reps = data;
  const sel = $('repSelect');
  if (!state.reps.length) {
    sel.innerHTML = '';
    throw new Error(`No reps found for district ${district || 'All'}`);
  }
  sel.innerHTML = state.reps
    .map((r) => `<option value="${encodeURIComponent(repKeyOf(r))}">${r.name} (D${r.district})</option>`)
    .join('');
  const districtNum = district ? Number(district) : null;
  const preferred =
    (districtNum === 8 && state.reps.find((r) => r.isD8Pool)) ||
    state.reps.find((r) => r.name.includes('Patricia')) ||
    state.reps[0];
  if (preferred) sel.value = encodeURIComponent(repKeyOf(preferred));
}

async function loadRepWeek() {
  const repKey = currentRepKey();
  const weekStart = $('weekSelect').value;
  if (!repKey) throw new Error('Choose who you are scheduling for');
  if (!weekStart) throw new Error('Choose a week');
  state.rep = await api(`/reps/${encodeURIComponent(repKey)}`);
  state.week = state.weeks.find((w) => w.start === weekStart);
  state.slots = state.rep.visitSlots;

  let defaultWeeklyTemplate = null;
  const drafts = await api(
    `/schedule/draft?rep=${encodeURIComponent(repKey)}&weekStart=${weekStart}`
  );
  if (drafts.length) {
    state.placements = drafts[0].placements;
    state.draftId = drafts[0].id;
    state.placementSource = 'draft';
  } else {
    const def = await api(
      `/schedule/default?rep=${encodeURIComponent(repKey)}&weekStart=${weekStart}`
    );
    state.placements = def.placements;
    state.draftId = null;
    state.placementSource = def.source || 'masterRoute';
    defaultWeeklyTemplate = def.weeklyTemplate;
  }

  const tpl = await api(`/schedule/weekly-template?rep=${encodeURIComponent(repKey)}`).catch(
    () => ({ template: null })
  );
  state.weeklyTemplate = tpl.template || defaultWeeklyTemplate || null;
  $('btnClearTemplate').hidden = !state.weeklyTemplate;

  if ($('showProd').checked && state.rep.employeeId) {
    try {
      const prod = await api(
        `/schedule/prod?rep=${encodeURIComponent(repKey)}&weekStart=${weekStart}`
      );
      state.prodShifts = prod.shifts || [];
    } catch {
      state.prodShifts = [];
      toast('PROD overlay unavailable (no sas-auth token?)', 'warn');
    }
  } else {
    state.prodShifts = [];
  }

  state.selected = null;
  state.dirty = false;
  state.handoff = null;
  setSaveState($('saveState'), 'saved');
  setHandoffButtons(false);
  $('reviewPane').textContent = '';
  await revalidate();
}

async function revalidate() {
  const { warnings, allValid } = await validatePlacements(
    repKeyOf(state.rep),
    state.week.start,
    state.placements
  );
  render(warnings, allValid);
}

/* ---------- Rendering ---------- */

function render(warnings, allValid) {
  $('weekTitle').textContent = `${state.rep.name} · ${state.week.label}`;
  $('weekDates').textContent = `${shortDate(state.week.start)} – ${shortDate(state.week.end)}`;
  $('d8Legend').hidden = !state.rep.isD8Pool;
  $('d1CoverageLegend').hidden = !state.rep.allowsRepAvailability;

  const invalidCount = state.placements.filter((p) => !p._valid).length;
  const coverageCount = state.rep.allowsRepAvailability
    ? coverageNeededCount(state.placements)
    : 0;
  const d8Unassigned = d8UnassignedCount(state.rep, state.placements);
  const src =
    state.placementSource === 'draft'
      ? 'saved draft'
      : state.placementSource === 'weeklyTemplate'
        ? 'weekly template'
        : 'Master Route defaults';
  $('weekStatus').innerHTML =
    `${state.placements.length} visits · from ${src} · ` +
    (allValid
      ? '<span class="pass">All Master Route checks pass</span>'
      : `<span class="fail">${invalidCount} placement(s) conflict</span>`) +
    (coverageCount ? ` · <span class="warn">${coverageCount} need coverage</span>` : '') +
    (d8Unassigned ? ` · <span class="warn">${d8Unassigned} need proposed assignee</span>` : '');

  renderTemplateBanner();

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

    const date = dateForDay(state.week.start, day);
    col.innerHTML = `
      <div class="day-head">
        <span>${day} <small>${shortDate(date)}</small></span>
        <span class="day-count">${(byDay[day] || []).length ? byDay[day].length + ' visit' + (byDay[day].length > 1 ? 's' : '') : ''}</span>
      </div>
      <div class="day-body"></div>`;

    col.querySelector('.day-head').addEventListener('click', () => {
      if (!state.selected || !selectedSlot) return;
      moveTo(state.selected, selectedSlot, day, true);
    });

    // Drag targets (desktop)
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
      moveTo(state.drag, slot, day, false);
      state.drag = null;
    });

    const body = col.querySelector('.day-body');
    for (const p of byDay[day] || []) body.appendChild(makeChit(p));

    if ($('showProd').checked) {
      for (const s of state.prodShifts.filter((x) => dayFromDate(x.scheduledDate) === day)) {
        const ghost = document.createElement('div');
        ghost.className = 'chit prod-ghost';
        ghost.innerHTML = `<div class="chit-top"><span class="chit-store">#${s.storeNum} · PROD</span></div><div class="chit-task">visit ${s.visitId}</div>`;
        body.appendChild(ghost);
      }
    }

    cal.appendChild(col);
  }

  renderWarnings(warnings);
}

function scrollDayIntoView(day) {
  if (!isMobileLayout()) return;
  document
    .querySelector(`.day-col[data-day="${day}"]`)
    ?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
}

function moveTo(p, slot, day, clearSelection) {
  if (!slot?.allowedDays.includes(day)) {
    toast(
      `Store ${p.storeNum} can't go on ${day}. Allowed: ${slot?.allowedDays.join(', ') || 'none'}`,
      'bad'
    );
    return;
  }
  p.dayOfWeek = day;
  p.scheduledDate = dateForDay(state.week.start, day);
  if (clearSelection) state.selected = null;
  markDirty();
  scrollDayIntoView(day);
  revalidate();
}

function renderTemplateBanner() {
  const banner = $('templateBanner');
  if (!state.weeklyTemplate) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const fromWeek = state.weeklyTemplate.setFromWeekLabel
    ? ` (saved from ${state.weeklyTemplate.setFromWeekLabel})`
    : '';
  const updated = state.weeklyTemplate.updatedAt
    ? new Date(state.weeklyTemplate.updatedAt).toLocaleString()
    : '';
  banner.hidden = false;
  if (state.placementSource === 'weeklyTemplate' && !state.draftId) {
    banner.innerHTML = `<strong>Weekly template active.</strong> This week started from the saved layout${fromWeek}. A saved draft overrides it.`;
  } else if (state.draftId) {
    banner.innerHTML = `<strong>Weekly template on file${fromWeek}.</strong> This week has its own draft. Updated ${updated}.`;
  } else {
    banner.innerHTML = `<strong>Weekly template on file${fromWeek}.</strong> Weeks without a draft use it. Updated ${updated}.`;
  }
}

function makeChit(p) {
  const tpl = $('chitTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  const slot = findSlot(state.slots, p);

  if (!p._valid) el.classList.add('invalid');
  else if (isCoverageNeeded(p)) el.classList.add('needs-coverage');
  else if (state.rep.isD8Pool && !p.proposedAssignee) el.classList.add('unassigned');
  else if (state.rep.isD8Pool && p.proposedAssignee) el.classList.add('assigned');
  if (state.selected && slotKey(state.selected) === slotKey(p)) el.classList.add('selected');

  el.querySelector('.chit-store').textContent = `#${p.storeNum}`;
  el.querySelector('.chit-flag').textContent = chitFlagLabel(p, state.rep, { admin: true });
  el.querySelector('.chit-task').textContent = orderTimingLine(slot, state.slots);
  el.querySelector('.chit-account').textContent = p.account || '';
  el.querySelector('.chit-action').textContent = (p.action || '').slice(0, 48);

  if (state.rep.isD8Pool) {
    const wrap = el.querySelector('.chit-assignee-wrap');
    wrap.hidden = false;
    const select = wrap.querySelector('.chit-assignee');
    const assignees = state.rep.proposedAssignees?.length
      ? state.rep.proposedAssignees
      : [];
    select.innerHTML =
      '<option value="">Choose proposed assignee…</option>' +
      assignees
        .map(
          (a) =>
            `<option value="${a.name}"${p.proposedAssignee === a.name ? ' selected' : ''}>${a.label || a.name}</option>`
        )
        .join('');
    stopSelectBubble(select);
    select.addEventListener('change', () => {
      p.proposedAssignee = select.value;
      markDirty();
      if (p.proposedAssignee) {
        toast(`Proposed assignee: ${p.proposedAssignee}`, 'ok', 2200);
      }
      if (state.selected && slotKey(state.selected) === slotKey(p)) showDetail(p);
      revalidate();
    });
  }

  if (state.rep.allowsRepAvailability) {
    const wrap = el.querySelector('.chit-availability-wrap');
    wrap.hidden = false;
    const select = wrap.querySelector('.chit-availability');
    const current = p.repAvailability || REP_AVAILABILITY.AVAILABLE;
    select.innerHTML = `
      <option value="${REP_AVAILABILITY.AVAILABLE}"${current !== REP_AVAILABILITY.NOT_AVAILABLE ? ' selected' : ''}>Available</option>
      <option value="${REP_AVAILABILITY.NOT_AVAILABLE}"${current === REP_AVAILABILITY.NOT_AVAILABLE ? ' selected' : ''}>Not Available</option>`;
    stopSelectBubble(select);
    select.addEventListener('change', () => {
      p.repAvailability = select.value;
      markDirty();
      revalidate();
    });
  }

  const moveSelect = el.querySelector('.chit-move-day');
  moveSelect.innerHTML = WORK_DAYS.map((day) => {
    const allowed = slot?.allowedDays.includes(day);
    return `<option value="${day}"${p.dayOfWeek === day ? ' selected' : ''}${allowed ? '' : ' disabled'}>${allowed ? day : day + ' — not allowed'}</option>`;
  }).join('');
  stopSelectBubble(moveSelect);
  moveSelect.addEventListener('change', () => moveTo(p, slot, moveSelect.value, false));

  el.draggable = !isMobileLayout();
  el.addEventListener('dragstart', (e) => {
    if (isMobileLayout()) {
      e.preventDefault();
      return;
    }
    state.drag = p;
  });
  el.addEventListener('dragend', () => (state.drag = null));
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
  const d8Unassigned = d8UnassignedCount(state.rep, state.placements);
  const coverageCount = state.rep.allowsRepAvailability
    ? coverageNeededCount(state.placements)
    : 0;
  const all = [...warnings];
  if (coverageCount) {
    all.unshift({
      message: `${coverageCount} visit(s) marked Not Available for ${state.rep.name} — arrange coverage before execution.`,
    });
  }
  if (d8Unassigned) {
    all.unshift({ message: `${d8Unassigned} D8 visit(s) still need a proposed assignee.` });
  }
  if (all.length) {
    warnEl.classList.add('show');
    warnEl.innerHTML =
      '<strong>Fix before approving</strong><ul>' +
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
        repKey: repKeyOf(state.rep),
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
      `Master Route: ${p._valid ? 'OK' : 'INVALID — move to an allowed day'}`,
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

/* ---------- Actions ---------- */

function markDirty() {
  state.dirty = true;
  setSaveState($('saveState'), 'unsaved');
}

function setHandoffButtons(enabled) {
  for (const id of ['btnCopyMd', 'btnCopyJson', 'btnDownload']) {
    $(id).disabled = !enabled;
  }
}

async function saveDraft() {
  setSaveState($('saveState'), 'saving');
  try {
    const draft = await api('/schedule/draft', {
      method: 'POST',
      body: JSON.stringify({
        repKey: repKeyOf(state.rep),
        weekStart: state.week.start,
        weekEnd: state.week.end,
        weekLabel: state.week.label,
        placements: state.placements,
        createdBy: state.user?.email || 'admin',
      }),
    });
    state.draftId = draft.id;
    state.placementSource = 'draft';
    state.dirty = false;
    setSaveState($('saveState'), 'saved');
    renderTemplateBanner();
    toast(`Draft saved (${draft.id})`, 'ok');
    return true;
  } catch (err) {
    setSaveState($('saveState'), 'unsaved');
    toast(`Save failed: ${err.message}`, 'bad', 5000);
    return false;
  }
}

async function saveWeeklyTemplate() {
  try {
    const { template } = await api('/schedule/weekly-template', {
      method: 'POST',
      body: JSON.stringify({
        repKey: repKeyOf(state.rep),
        placements: state.placements,
        setFromWeekLabel: state.week.label,
        setBy: state.user?.email || 'admin',
      }),
    });
    state.weeklyTemplate = template;
    $('btnClearTemplate').hidden = false;
    renderTemplateBanner();
    toast(`Weekly template saved from ${state.week.label}`, 'ok');
  } catch (err) {
    toast(`Template save failed: ${err.message}`, 'bad', 5000);
  }
}

async function clearWeeklyTemplate() {
  try {
    await api(`/schedule/weekly-template?rep=${encodeURIComponent(repKeyOf(state.rep))}`, {
      method: 'DELETE',
    });
    state.weeklyTemplate = null;
    $('btnClearTemplate').hidden = true;
    toast('Weekly template cleared', 'ok');
    if (!state.draftId) await loadRepWeek();
    else renderTemplateBanner();
  } catch (err) {
    toast(`Clear failed: ${err.message}`, 'bad', 5000);
  }
}

async function approveWeek() {
  if (state.dirty || !state.draftId) {
    const ok = await saveDraft();
    if (!ok) return;
  }
  try {
    const { handoff } = await api('/schedule/approve', {
      method: 'POST',
      body: JSON.stringify({
        draftId: state.draftId,
        approvedBy: state.user?.email || 'supervisor',
        prodShifts: state.prodShifts,
      }),
    });
    state.handoff = handoff;
    $('reviewPane').textContent = handoff.markdown.slice(0, 4000) + '\n…';
    setHandoffButtons(true);
    toast('Week approved — handoff ready below', 'ok', 4500);
  } catch (err) {
    toast(`Approve failed: ${err.message}`, 'bad', 5000);
  }
}

async function copyHandoff(kind) {
  if (!state.draftId) return toast('Approve the week first', 'warn');
  try {
    const h = await api(`/schedule/handoff/${state.draftId}`);
    const text = kind === 'md' ? h.markdown : JSON.stringify(h.json, null, 2);
    await navigator.clipboard.writeText(text);
    toast(kind === 'md' ? 'Markdown copied' : 'JSON copied', 'ok');
  } catch (err) {
    toast(`Copy failed: ${err.message}`, 'bad', 5000);
  }
}

/* ---------- Init ---------- */

function showInitError(err) {
  const el = $('initError');
  if (el) {
    el.hidden = false;
    el.textContent = `Could not load the schedule: ${err.message || err}. Try signing out and back in.`;
  } else {
    toast(`Could not load: ${err.message || err}`, 'bad', 8000);
  }
}

(async function init() {
  try {
    await window.cpAuth.bootPromise;
    state.user = await loadMe();

    if (state.user.layer === 'rep') {
      window.location.replace('/rep.html');
      return;
    }

    $('userEmail').textContent = state.user.email || '';
    $('userBar').hidden = false;
    $('stickyBar').hidden = false;

    $('btnSave').addEventListener('click', saveDraft);
    $('btnApprove').addEventListener('click', approveWeek);
    armButton($('btnSaveTemplate'), 'Tap again to confirm', saveWeeklyTemplate);
    armButton($('btnClearTemplate'), 'Tap again to clear', clearWeeklyTemplate);
    $('btnCopyMd').addEventListener('click', () => copyHandoff('md'));
    $('btnCopyJson').addEventListener('click', () => copyHandoff('json'));
    $('btnDownload').addEventListener('click', () => {
      if (!state.draftId) return toast('Approve the week first', 'warn');
      window.location.href = `/api/central-pet/schedule/export/${state.draftId}?format=handoff`;
    });
    $('btnRepView').addEventListener('click', () => (window.location.href = '/rep.html?preview=1'));
    $('btnSignOut').addEventListener('click', signOut);

    const reload = async () => {
      if (state.dirty) {
        toast('Unsaved changes discarded on switch', 'warn', 2200);
      }
      try {
        await loadRepWeek();
      } catch (err) {
        showInitError(err);
      }
    };
    $('districtFilter').addEventListener('change', async () => {
      try {
        await loadReps();
        await reload();
      } catch (err) {
        showInitError(err);
      }
    });
    $('repSelect').addEventListener('change', reload);
    $('weekSelect').addEventListener('change', reload);
    $('showProd').addEventListener('change', reload);

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) e.preventDefault();
    });

    $('districtFilter').value = '1';
    await loadWeeks();
    await loadReps();
    await loadRepWeek();
  } catch (err) {
    console.error('[admin]', err);
    showInitError(err);
  }
})();
