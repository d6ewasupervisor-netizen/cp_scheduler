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
  applyRepAvailability,
  d8UnassignedCount,
  stopSelectBubble,
  chitFlagLabel,
  REP_AVAILABILITY,
} from '/shared.js';
import { initAppShell } from '/ux/app-shell.js';
import { beginBusy, endBusy } from '/ux/buffering.js';

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
  lastValidationWarnings: [],
  lastAllValid: true,
};

let validateGen = 0;

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
  const gen = ++validateGen;
  const { warnings, allValid } = await validatePlacements(
    repKeyOf(state.rep),
    state.week.start,
    state.placements
  );
  if (gen !== validateGen) return;
  render(warnings, allValid);
}

/* ---------- Rendering ---------- */

function render(warnings, allValid) {
  state.lastValidationWarnings = warnings;
  state.lastAllValid = allValid;

  $('weekTitle').textContent = `${state.rep.name} · ${state.week.label}`;
  $('weekDates').textContent = `${shortDate(state.week.start)} – ${shortDate(state.week.end)}`;
  $('d8Legend').hidden = !state.rep.isD8Pool;

  const invalidCount = state.placements.filter((p) => !p._valid).length;
  const coverageCount = state.rep.allowsRepAvailability
    ? coverageNeededCount(state.placements)
    : 0;
  $('d1CoverageLegend').hidden =
    !state.rep.allowsRepAvailability || coverageCount === 0;
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
      applyRepAvailability(p, select.value);
      markDirty();
      if (state.selected && slotKey(state.selected) === slotKey(p)) showDetail(p);
      render(state.lastValidationWarnings, state.lastAllValid);
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

/* ---------- Stage 3: guided visit drafts (read-only Planning Desk view) ---------- */

function photoDeliveryLabel(pd) {
  if (!pd) return { tag: 'tag-unmatched', text: 'photos: —' };
  const s = pd.summary;
  const bits = s
    ? `sent ${s.sent || 0}/${s.total || 0}${s.failed ? ` · failed ${s.failed}` : ''}${s.pending ? ` · pending ${s.pending}` : ''}`
    : pd.status || '—';
  const tag =
    pd.status === 'complete'
      ? 'tag-ambiguous'
      : pd.status === 'failed' || (s && s.failed > 0)
        ? 'tag-unmatched'
        : 'tag-unmatched';
  return { tag, text: `photos: ${pd.status || '—'}${s ? ` (${bits})` : ''}` };
}

async function loadVisitDrafts() {
  const host = $('visitDraftsList');
  if (!host) return;
  try {
    const drafts = await api('/shift-day/visit/drafts');
    if (!drafts.length) {
      host.innerHTML = '<div class="mw-row">No visit drafts yet.</div>';
      return;
    }
    host.innerHTML = drafts
      .map((d) => {
        const tag = d.status === 'ready_for_prod' ? 'tag-ambiguous' : 'tag-unmatched';
        const statusLabel = d.status === 'ready_for_prod' ? 'sealed' : 'in progress';
        const pd = photoDeliveryLabel(d.photoDelivery);
        const failed = d.photoDelivery?.summary?.failed > 0;
        const resendBtn = failed
          ? ` <button type="button" class="subtle btn-resend-photos" data-rep="${escapeHtml(d.repKey)}" data-date="${escapeHtml(d.date)}" data-store="${escapeHtml(String(d.actualStore))}">Re-send failed</button>`
          : '';
        return `<div class="mw-row"><span class="${tag}">${statusLabel}</span> ${escapeHtml(d.repKey)} · ${escapeHtml(d.date)} · store ${escapeHtml(String(d.actualStore))} · step ${escapeHtml(d.currentStep)} · updated ${new Date(d.updatedAt).toLocaleString()} · <span class="${pd.tag}">${escapeHtml(pd.text)}</span>${resendBtn}</div>`;
      })
      .join('');
    host.querySelectorAll('.btn-resend-photos').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await window.cpAuthFetch('/api/central-pet/shift-day/photo-delivery/resend-failed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rep: btn.dataset.rep,
              date: btn.dataset.date,
              store: Number(btn.dataset.store),
            }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || res.statusText);
          const d = body.delivery;
          toast(
            d?.message ||
              `Photo delivery ${d?.status || 'done'}: sent ${d?.summary?.sent || 0}/${d?.summary?.total || 0}`,
            d?.status === 'complete' || d?.status === 'disabled' ? 'ok' : 'warn',
            5000
          );
          await loadVisitDrafts();
        } catch (err) {
          toast(`Re-send failed: ${err.message}`, 'bad', 5000);
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    host.innerHTML = `<div class="mw-row">Could not load visit drafts: ${err.message}</div>`;
  }
}

/* ---------- Stage 4: prod overlay dry run + gated live transmit ---------- */

const liveUi = {
  liveTransmitEnabled: false,
  allowlist: new Set(),
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function draftIdOf(repKey, date, store) {
  return `${repKey}/${date}-${store}`;
}

async function refreshLiveStatus() {
  const el = $('liveTransmitStatus');
  const badge = $('dryRunLiveBadge');
  try {
    const st = await api('/shift-day/live/status');
    liveUi.liveTransmitEnabled = !!st.liveTransmitEnabled;
    liveUi.allowlist = new Set(st.draftIds || []);
    if (el) {
      el.textContent = st.liveTransmitEnabled
        ? `LIVE_TRANSMIT on · ${st.allowlistCount} draft(s) allowlisted · Transmit (LIVE) appears only for allowlisted visits`
        : 'LIVE_TRANSMIT off — dry-run only (no write path can send)';
    }
    if (badge) {
      badge.textContent = st.liveTransmitEnabled ? 'live armed on server' : 'review only';
      badge.className = st.liveTransmitEnabled ? 'tag-ambiguous' : 'tag-unmatched';
    }
  } catch (err) {
    if (el) el.textContent = `Live status unavailable: ${err.message}`;
  }
}

function renderDryRunCall(call) {
  return `
    <details class="mw-row" style="display:block">
      <summary><span class="tag-unmatched">${call.seq}</span> ${escapeHtml(call.method)} ${escapeHtml(call.url)}${call.reconstructed ? ' <em>(reconstructed)</em>' : ''}</summary>
      <div style="margin:.4rem 0 0 1rem; font-size:.85em">
        <div><strong>sourceRef:</strong> ${escapeHtml(call.sourceRef)}</div>
        ${call.dependsOn?.length ? `<div><strong>dependsOn:</strong> steps ${call.dependsOn.join(', ')}</div>` : ''}
        <div><strong>headers:</strong> <code>${escapeHtml(JSON.stringify(call.headers))}</code></div>
        <div><strong>payload:</strong></div>
        <pre style="white-space:pre-wrap; word-break:break-word">${escapeHtml(JSON.stringify(call.payload, null, 2))}</pre>
      </div>
    </details>`;
}

function renderLiveArmControls({ runId, file, store, draftId, partial, liveState }) {
  if (!liveUi.liveTransmitEnabled || !liveUi.allowlist.has(draftId)) {
    return `<div class="mw-row" style="display:block;border:1px dashed var(--border-strong);padding:.65rem;margin:.5rem 0">
      LIVE controls hidden: flag ${liveUi.liveTransmitEnabled ? 'on' : 'off'}, allowlisted ${liveUi.allowlist.has(draftId) ? 'yes' : 'no'} for <code>${escapeHtml(draftId)}</code>
    </div>`;
  }
  const mode = partial ? 'resume' : 'start';
  const label = partial ? 'Resume transmit (LIVE)' : 'Transmit (LIVE)';
  const stateLine = liveState?.state
    ? `Executor: <code>${escapeHtml(liveState.state.status || '—')}</code> lastOk=${escapeHtml(String(liveState.state.lastSuccessfulSeq ?? '—'))} failed=${escapeHtml(String(liveState.state.failedSeq ?? '—'))}`
    : 'No prior executor state on disk.';
  return `
    <div class="mw-row" style="display:block; border:1px solid var(--warn); padding:.65rem; margin:.5rem 0; border-radius:6px">
      <strong>${escapeHtml(label)}</strong> — two-tap arm: type store number <code>${escapeHtml(String(store))}</code> to confirm.
      <p class="week-status" style="margin:.35rem 0">${stateLine}</p>
      <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.4rem; align-items:end">
        <label class="field" style="margin:0">Confirm store
          <input type="text" id="liveConfirmStore" inputmode="numeric" placeholder="${escapeHtml(String(store))}" value="${partial ? escapeHtml(String(store)) : ''}" autocomplete="off">
        </label>
        <label class="field" style="margin:0; flex:1; min-width:14rem">
          <input type="checkbox" id="liveTestMode" ${partial ? 'checked' : ''}> testMode (round-trip vs golden export)
        </label>
        <label class="field" style="margin:0; flex:2; min-width:16rem">Golden export path (required if testMode)
          <input type="text" id="liveGoldenPath" placeholder="C:/Users/tgaut/Downloads/cp_tests/visit-26822165" value="${partial ? 'C:/Users/tgaut/Downloads/cp_tests/visit-26822165' : ''}" autocomplete="off">
        </label>
        <button type="button" class="primary" id="btnLiveTransmit"
          data-run="${escapeHtml(runId)}" data-file="${escapeHtml(file)}" data-store="${escapeHtml(String(store))}"
          data-draft="${escapeHtml(draftId)}" data-mode="${mode}">${escapeHtml(label)}</button>
      </div>
      <p class="week-status" style="margin:.4rem 0 0">No automatic rollback. Uses morning sas-auth token+CSRF+cookies (not app user DB, not PIN). testMode appends POST …/recomplete/. Completed-visit T&E may soft-skip per automator (in-progress only). Logs under <code>live/${escapeHtml(runId)}/</code>.</p>
      <div id="liveTransmitResult"></div>
      <div style="margin-top:.5rem; display:flex; gap:.5rem; flex-wrap:wrap; align-items:end">
        <label class="field" style="margin:0; flex:2; min-width:16rem">Post-run export path (after re-export)
          <input type="text" id="livePostPath" placeholder="C:\\Users\\…\\Downloads\\cp_tests\\visit-26822165" autocomplete="off">
        </label>
        <button type="button" class="subtle" id="btnRoundtripDiff"
          data-run="${escapeHtml(runId)}" data-file="${escapeHtml(file)}" data-draft="${escapeHtml(draftId)}">Run round-trip diff</button>
      </div>
      <div id="liveRoundtripResult"></div>
    </div>`;
}

async function viewDryRunVisit(runId, file) {
  const host = $('dryRunResult');
  try {
    const assembled = await api(`/shift-day/dryrun/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`);
    let partial = false;
    let liveState = null;
    try {
      liveState = await api(
        `/shift-day/live/state/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`
      );
      partial = liveState?.registry?.status === 'partial' || liveState?.state?.status === 'partial';
    } catch {
      /* live state optional */
    }
    const draftId = draftIdOf(assembled.repKey, assembled.date, assembled.actualStore);
    host.innerHTML =
      `<p class="week-status">${assembled.repKey} · ${assembled.date} · store ${assembled.actualStore} · visit ${assembled.visitId} · ${assembled.calls?.length || 0} calls · draft <code>${escapeHtml(draftId)}</code></p>` +
      renderLiveArmControls({
        runId,
        file,
        store: assembled.actualStore,
        draftId,
        partial,
        liveState,
      }) +
      (assembled.calls || []).map(renderDryRunCall).join('');

    $('btnLiveTransmit')?.addEventListener('click', () => armAndTransmit());
    $('btnRoundtripDiff')?.addEventListener('click', () => runRoundtripDiffUi());
  } catch (err) {
    host.innerHTML = `<div class="mw-row">Could not load visit file: ${escapeHtml(err.message)}</div>`;
  }
}

async function armAndTransmit() {
  const btn = $('btnLiveTransmit');
  if (!btn) return;
  const confirmStore = $('liveConfirmStore')?.value?.trim();
  const expected = btn.dataset.store;
  const testMode = !!$('liveTestMode')?.checked;
  const goldenExportPath = $('liveGoldenPath')?.value?.trim() || null;
  if (!confirmStore) return toast('Type the store number to arm LIVE transmit', 'warn');
  if (confirmStore !== expected) return toast(`Store mismatch — type ${expected} exactly`, 'warn');
  if (testMode && !goldenExportPath) {
    return toast('testMode requires a golden export path (export-cp-shift-full folder)', 'warn');
  }

  const modeLabel = testMode ? 'testMode round-trip LIVE' : 'LIVE';
  if (!window.confirm(`${modeLabel} transmit to prod for store ${expected}? Uses morning sas-auth session. No automatic rollback.`)) return;

  const resultHost = $('liveTransmitResult');
  if (resultHost) resultHost.innerHTML = '<div class="mw-row">Transmitting… watch this panel</div>';
  btn.disabled = true;
  try {
    // Use raw fetch so 409 partial/preflight bodies are still inspectable
    const res = await window.cpAuthFetch('/api/central-pet/shift-day/live/transmit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dryRunId: btn.dataset.run,
        visitFile: btn.dataset.file,
        draftId: btn.dataset.draft,
        confirmStore,
        mode: btn.dataset.mode || 'start',
        testMode,
        goldenExportPath,
      }),
    });
    const result = await res.json().catch(() => ({}));
    // Never echo pin back into the UI
    if (resultHost) {
      resultHost.innerHTML = `<pre style="white-space:pre-wrap;font-size:.85em">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
    }
    if (result.status === 'complete') {
      toast(testMode ? 'testMode transmit+recomplete done — re-export then run diff' : 'LIVE transmit complete', 'ok', 6000);
    } else if (res.status === 403) toast(`LIVE blocked: ${result.error || result.abortReason}`, 'bad', 6000);
    else toast(`LIVE transmit ${result.status || res.status}: ${result.abortReason || result.error || 'see result'}`, 'warn', 6000);
  } catch (err) {
    if (resultHost) resultHost.innerHTML = `<div class="mw-row">Failed: ${escapeHtml(err.message)}</div>`;
    toast(`LIVE transmit failed: ${err.message}`, 'bad', 6000);
  } finally {
    btn.disabled = false;
  }
}

async function runRoundtripDiffUi() {
  const btn = $('btnRoundtripDiff');
  if (!btn) return;
  const goldenExportPath = $('liveGoldenPath')?.value?.trim();
  const postExportPath = $('livePostPath')?.value?.trim();
  if (!goldenExportPath || !postExportPath) {
    return toast('Set golden export path and post-run export path', 'warn');
  }
  const host = $('liveRoundtripResult');
  if (host) host.innerHTML = '<div class="mw-row">Diffing…</div>';
  try {
    const res = await window.cpAuthFetch('/api/central-pet/shift-day/live/roundtrip-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dryRunId: btn.dataset.run,
        visitFile: btn.dataset.file,
        draftId: btn.dataset.draft,
        goldenExportPath,
        postExportPath,
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (host) {
      host.innerHTML = `<pre style="white-space:pre-wrap;font-size:.85em">${escapeHtml(JSON.stringify({
        verdict: result.verdict,
        expectedCount: result.expectedCount,
        unexpectedCount: result.unexpectedCount,
        reportPath: result.reportPath,
        unexpected: result.diff?.unexpected?.slice?.(0, 20),
      }, null, 2))}</pre>`;
    }
    if (result.verdict === 'PASS') toast('Round-trip PASS', 'ok');
    else toast(`Round-trip ${result.verdict || 'FAIL'} — see unexpected diffs`, 'warn', 6000);
  } catch (err) {
    if (host) host.innerHTML = `<div class="mw-row">Diff failed: ${escapeHtml(err.message)}</div>`;
    toast(err.message, 'bad');
  }
}

function renderDryRunManifest(manifest) {
  const host = $('dryRunResult');
  const rows = [
    ...(manifest.visits || []).map((v) => {
      const draftId = draftIdOf(v.repKey, v.date, v.store);
      const liveHint =
        liveUi.liveTransmitEnabled && liveUi.allowlist.has(draftId)
          ? ' <span class="tag-ambiguous">allowlisted</span>'
          : '';
      return (
        `<div class="mw-row"><span class="tag-ambiguous">assembled</span> ${v.repKey} · ${v.date} · store ${v.store} · visit ${v.visitId} · ${v.callCount} calls${liveHint} ` +
        `<button type="button" class="subtle dryrun-view-btn" data-run="${escapeHtml(manifest.runId)}" data-file="${escapeHtml(v.file)}">View calls</button></div>`
      );
    }),
    ...(manifest.aborted || []).map(
      (a) => `<div class="mw-row"><span class="tag-unmatched">aborted</span> ${a.repKey} · ${a.date} · store ${a.store} — ${escapeHtml(a.reason)}</div>`
    ),
  ];
  host.innerHTML =
    `<p class="week-status">run <code>${escapeHtml(manifest.runId)}</code> — eligible ${manifest.summary.eligible} · assembled ${manifest.summary.assembled} · aborted ${manifest.summary.aborted}</p>` +
    (rows.length ? rows.join('') : '<div class="mw-row">Nothing eligible in this run.</div>');

  host.querySelectorAll('.dryrun-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => viewDryRunVisit(btn.dataset.run, btn.dataset.file));
  });
}

async function loadDryRuns() {
  const host = $('dryRunList');
  if (!host) return;
  try {
    const { runs } = await api('/shift-day/dryrun');
    host.innerHTML = runs.length
      ? runs
          .map((r) => `<div class="mw-row"><button type="button" class="subtle dryrun-open-run-btn" data-run="${escapeHtml(r)}">${escapeHtml(r)}</button></div>`)
          .join('')
      : '<div class="mw-row">No dry runs yet.</div>';
    host.querySelectorAll('.dryrun-open-run-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          renderDryRunManifest(await api(`/shift-day/dryrun/${encodeURIComponent(btn.dataset.run)}`));
        } catch (err) {
          toast(err.message, 'bad');
        }
      });
    });
  } catch (err) {
    host.innerHTML = `<div class="mw-row">Could not load runs: ${escapeHtml(err.message)}</div>`;
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
    beginBusy('Loading Planning Desk…', { force: true });
    await window.cpAuth.bootPromise;
    state.user = await loadMe();

    if (state.user.layer === 'rep') {
      endBusy();
      window.location.replace('/rep.html');
      return;
    }

    $('userEmail').textContent = state.user.email || '';
    $('userBar').hidden = false;
    $('stickyBar').hidden = false;
    initAppShell({ isAdmin: true, active: 'planning', bottomNav: true });

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

    const supervisorId = () => localStorage.getItem('cp_supervisor_id') || '800175315';

    async function refreshShiftDayWeekMeta() {
      try {
        const rows = await api('/shift-day/weeks');
        state.shiftDayWeeks = rows;
        const start = state.week?.start || $('weekSelect')?.value;
        state.shiftDayWeek = rows.find((w) => w.start === start) || null;
      } catch {
        state.shiftDayWeeks = [];
        state.shiftDayWeek = null;
      }
      renderWeekSyncStatus();
    }

    function renderWeekSyncStatus() {
      const el = $('weekSyncStatus');
      if (!el) return;
      const week = state.shiftDayWeek || state.week;
      if (!week) {
        el.textContent = 'Select a week to see sync status.';
        return;
      }
      const parts = [
        week.label || week.start,
        week.hasSchedule ? `${week.shiftCount ?? '?'} shifts` : 'no local shift-day schedule',
        week.source ? `source=${week.source}` : null,
        week.matchStale ? 'MATCH STALE — re-sync or re-match' : week.lastMatchedAt ? 'match fresh' : null,
        week.lastSyncedAt ? `synced ${week.lastSyncedAt}` : null,
      ].filter(Boolean);
      el.textContent = parts.join(' · ');
      el.className = week.matchStale ? 'week-status tag-ambiguous' : 'week-status';
    }

    $('btnSyncFromProd')?.addEventListener('click', async () => {
      const week = state.week;
      if (!week) return toast('Pick a week first', 'warn');
      if (
        !confirm(
          `Replace local shift-day schedule for ${week.label || week.start} with a live pull from SAS PROD (cycle/field-data)? Local day moves for this week will be overwritten.`
        )
      ) {
        return;
      }
      try {
        toast('Syncing from PROD…', 'ok', 4000);
        const data = await api('/shift-day/sync-from-prod', {
          method: 'POST',
          body: JSON.stringify({
            weekStart: week.start,
            supervisorId: supervisorId(),
          }),
          busy: 'Syncing from PROD…',
          busyForce: true,
        });
        toast(
          `Synced ${data.shiftCount} shifts from PROD` +
            (data.cycle?.name ? ` (${data.cycle.name})` : '') +
            (data.unmappedEmployeeCount ? ` · ${data.unmappedEmployeeCount} unmapped emp` : ''),
          'ok',
          6000
        );
        await refreshShiftDayWeekMeta();
        await loadRepWeek().catch(() => {});
      } catch (err) {
        toast(err.message, 'bad', 6000);
      }
    });

    async function refreshScheduleWriteStatus() {
      const el = $('scheduleWriteStatus');
      if (!el) return;
      try {
        const st = await api('/shift-day/schedule-write-status');
        el.textContent = st.liveScheduleWrite
          ? 'LIVE_SCHEDULE_WRITE is ON — Apply will mutate SAS team-scheduling.'
          : 'LIVE_SCHEDULE_WRITE is OFF — Preview works; Apply will refuse live writes until the flag is set.';
        el.className = st.liveScheduleWrite ? 'week-status tag-matched' : 'week-status tag-ambiguous';
      } catch (err) {
        el.textContent = `Could not load schedule-write status: ${err.message}`;
      }
    }

    function renderSchedulePushResults(data) {
      const host = $('schedulePushResults');
      if (!host) return;
      const rows = (data.results || []).filter((r) => r.code !== 'in_sync');
      const head = `<p class="week-status">${data.dryRun ? 'DRY-RUN' : 'LIVE'} · to-move ${data.toMoveCount || 0} · moved ${data.movedCount || 0} · failed ${data.failedCount || 0} · skipped ${data.skippedCount || 0}</p>`;
      if (!rows.length) {
        host.innerHTML = head + '<div class="mw-row">No day-moves pending — local board matches PROD dates.</div>';
        return;
      }
      host.innerHTML =
        head +
        rows
          .map((r) => {
            const tag = r.ok === false ? 'unmatched' : r.dryRun || r.code === 'would_reschedule' ? 'ambiguous' : 'matched';
            const store = r.actualStore != null ? ` store ${r.actualStore}` : '';
            const dates =
              r.prodDate && r.localDate
                ? ` ${r.prodDate} → ${r.localDate}`
                : r.fromDate && r.toDate
                  ? ` ${r.fromDate} → ${r.toDate}`
                  : '';
            return `<div class="mw-row"><span class="tag-${tag}">${r.code || (r.ok ? 'ok' : 'fail')}</span> ${r.repKey || ''}${store}${dates} · visit ${r.visitId || r.sourceVisitId || '—'} ${r.destVisitId ? `→ ${r.destVisitId}` : ''} — ${r.message || ''}</div>`;
          })
          .join('');
    }

    $('btnPreviewSchedulePush')?.addEventListener('click', async () => {
      const week = state.week;
      if (!week) return toast('Pick a week first', 'warn');
      try {
        toast('Previewing day-moves vs PROD…', 'ok', 3000);
        const data = await api('/shift-day/push-schedule-to-prod', {
          method: 'POST',
          body: JSON.stringify({ weekStart: week.start, dryRun: true }),
        });
        renderSchedulePushResults(data);
        toast(
          data.toMoveCount
            ? `Preview: ${data.toMoveCount} move(s) would go to PROD`
            : 'Preview: nothing to push (in sync)',
          'ok',
          5000
        );
      } catch (err) {
        toast(err.message, 'bad', 6000);
      }
    });

    $('btnApplySchedulePush')?.addEventListener('click', async () => {
      const week = state.week;
      if (!week) return toast('Pick a week first', 'warn');
      if (
        !confirm(
          `Apply pending day-moves for ${week.label || week.start} to SAS PROD?\n\n` +
            'This creates visits on the new dates, copies reps + store notes, and soft-deletes the old day.\n' +
            'Completed / in-progress visits are skipped.\n\n' +
            'Tap OK only if you intend a LIVE schedule change.'
        )
      ) {
        return;
      }
      // Two-tap
      if (!confirm('Second confirm: push schedule changes to production now?')) return;
      try {
        toast('Applying day-moves to PROD…', 'ok', 4000);
        const data = await api('/shift-day/push-schedule-to-prod', {
          method: 'POST',
          body: JSON.stringify({ weekStart: week.start, dryRun: false }),
        });
        renderSchedulePushResults(data);
        if (data.failedCount) {
          toast(`PROD push finished with ${data.failedCount} failure(s)`, 'bad', 7000);
        } else if (!data.toMoveCount && !data.movedCount) {
          toast('Nothing to push — board already matches PROD', 'warn', 5000);
        } else {
          toast(`Pushed ${data.movedCount} day-move(s) to PROD`, 'ok', 6000);
        }
        // Refresh board from PROD so visit ids stay accurate
        try {
          await api('/shift-day/sync-from-prod', {
            method: 'POST',
            body: JSON.stringify({ weekStart: week.start, supervisorId: supervisorId() }),
          });
          await refreshShiftDayWeekMeta();
        } catch {
          /* preview still useful */
        }
        await refreshScheduleWriteStatus();
      } catch (err) {
        toast(err.message, 'bad', 7000);
      }
    });

    refreshScheduleWriteStatus().catch(() => {});

    $('btnRunMatcher')?.addEventListener('click', async () => {
      const week = state.week;
      if (!week) return;
      try {
        const data = await api(
          `/shift-day/match?weekStart=${encodeURIComponent(week.start)}&supervisorId=${encodeURIComponent(supervisorId())}`
        );
        const host = $('matchWarnings');
        const rows = [
          ...(data.unmatched || []).map((u) => ({
            tag: 'unmatched',
            text: `${u.appShift?.repKey} ${u.appShift?.date} store ${u.appShift?.actualStore} (sched ${u.appShift?.scheduledStore}) — no prod visit`,
          })),
          ...(data.ambiguous || []).map((a) => ({
            tag: 'ambiguous',
            text: `${a.appShift?.repKey} ${a.appShift?.date} store ${a.appShift?.actualStore} — visits ${(a.candidates || []).map((c) => c.visitId).join(', ')}`,
          })),
          ...(data.orphaned || []).map((o) => ({
            tag: 'orphaned',
            text: `prod ${o.prodVisit?.visitId} ${o.prodVisit?.repKey} ${o.prodVisit?.date} decoded ${o.prodVisit?.actualStore} (sched ${o.prodVisit?.scheduledStore}) — no app shift`,
          })),
        ];
        host.innerHTML =
          `<p class="week-status">matched ${data.summary?.matched || 0} · unmatched ${data.summary?.unmatched || 0} · ambiguous ${data.summary?.ambiguous || 0} · orphaned ${data.summary?.orphaned || 0}</p>` +
          (rows.length
            ? rows.map((r) => `<div class="mw-row"><span class="tag-${r.tag}">${r.tag}</span> ${r.text}</div>`).join('')
            : '<div class="mw-row">No warnings for this week.</div>');
        await refreshShiftDayWeekMeta();
        toast('Matcher finished', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    });

    $('btnRefreshVisitDrafts')?.addEventListener('click', loadVisitDrafts);

    $('btnRefreshDryRuns')?.addEventListener('click', loadDryRuns);
    loadDryRuns();
    refreshLiveStatus();

    $('btnRunDryRun')?.addEventListener('click', async () => {
      const week = state.week;
      if (!week) return toast('Pick a week first', 'warn');
      const timeChangeComment = $('dryRunTimeChangeComment')?.value?.trim();
      if (!timeChangeComment) return toast('Time-change comment is required for the dry run', 'warn');
      const repKeys = ($('dryRunRepKeys')?.value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      $('dryRunResult').innerHTML = '<div class="mw-row">Assembling…</div>';
      try {
        const manifest = await api('/shift-day/dryrun', {
          method: 'POST',
          body: JSON.stringify({
            weekStart: week.start,
            supervisorId: supervisorId(),
            repKeys: repKeys.length ? repKeys : undefined,
            timeChangeComment,
          }),
          busy: 'Assembling dry run…',
          busyForce: true,
        });
        renderDryRunManifest(manifest);
        toast(`Dry run assembled (${manifest.summary.assembled} visit(s))`, 'ok');
        loadDryRuns();
      } catch (err) {
        $('dryRunResult').innerHTML = `<div class="mw-row">Dry run failed: ${escapeHtml(err.message)}</div>`;
        toast(`Dry run failed: ${err.message}`, 'bad', 5000);
      }
    });

    $('btnIngestExport')?.addEventListener('click', async () => {
      const file = $('scheduleExportFile')?.files?.[0];
      const week = state.week;
      if (!file || !week) {
        toast('Choose a week and an .xlsx file', 'warn');
        return;
      }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('weekStart', week.start);
      try {
        const res = await window.cpAuthFetch(`/api/central-pet/shift-day/ingest?weekStart=${encodeURIComponent(week.start)}`, {
          method: 'POST',
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        toast(`Ingested ${data.shiftCount} shifts (${data.flagCount || 0} flagged) — match stale`, 'ok');
        await refreshShiftDayWeekMeta();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });

    const reload = async () => {
      if (state.dirty) {
        toast('Unsaved changes discarded on switch', 'warn', 2200);
      }
      try {
        await loadRepWeek();
        await refreshShiftDayWeekMeta();
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
    await refreshShiftDayWeekMeta();
    await loadVisitDrafts();
    endBusy();
  } catch (err) {
    endBusy();
    console.error('[admin]', err);
    showInitError(err);
  }
})();
