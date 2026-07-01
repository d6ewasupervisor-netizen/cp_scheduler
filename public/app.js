const API = '/api/central-pet';
const AUTH_API = '/api/auth';
const WORK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

let state = {
  user: null,
  layer: 'rep',
  reps: [],
  rep: null,
  week: null,
  placements: [],
  slots: [],
  draftId: null,
  prodShifts: [],
  drag: null,
  placementSource: null,
  weeklyTemplate: null,
};

function repKey(rep) {
  return rep?.repKey || rep?.name;
}

function isAdmin() {
  return state.layer === 'admin';
}

async function api(path, opts = {}) {
  const res = await window.cpAuthFetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function applyLayer() {
  document.body.classList.toggle('rep-layer', state.layer === 'rep');
  document.body.classList.toggle('admin-layer', state.layer === 'admin');

  const badge = document.getElementById('layerBadge');
  badge.textContent = state.layer === 'admin' ? 'Admin' : 'Rep view';
  badge.className = 'layer-badge ' + state.layer;

  document.getElementById('userEmail').textContent = state.user?.email || '';
  document.getElementById('userBar').hidden = false;

  document.getElementById('pageSubtitle').textContent =
    state.layer === 'admin'
      ? 'Admin — build templates, approve weeks, export handoffs'
      : 'Your week — drag each store to a valid day, then save';

  document.getElementById('guideTitle').textContent =
    state.layer === 'admin' ? 'Admin options' : 'Your steps each week';

  const guide = state.user?.help || [];
  document.getElementById('guideList').innerHTML = guide.map((g) => `<li>${g}</li>`).join('');

  if (state.user?.email && !document.getElementById('approverEmail').value) {
    document.getElementById('approverEmail').value = state.user.email;
  }
}

function slotKey(p) {
  return `${p.storeNum}:${p.visitIndex ?? 0}`;
}

function findSlot(p) {
  return state.slots.find(
    (s) => s.storeNum === p.storeNum && (s.visitIndex ?? 0) === (p.visitIndex ?? 0)
  );
}

function placementsByDay() {
  const map = Object.fromEntries(WORK_DAYS.map((d) => [d, []]));
  for (const p of state.placements) {
    if (map[p.dayOfWeek]) map[p.dayOfWeek].push(p);
  }
  return map;
}

function dayAllowedForAnySlot(day) {
  return state.slots.some((s) => s.allowedDays.includes(day));
}

async function loadWeeks() {
  const weeks = await api('/weeks');
  const sel = document.getElementById('weekSelect');
  sel.innerHTML = weeks
    .map((w) => `<option value="${w.start}">${w.label} (${w.start} – ${w.end})</option>`)
    .join('');
  sel.value = weeks.find((w) => w.label === 'P06W2')?.start || weeks[0]?.start;
}

async function loadReps() {
  const district = document.getElementById('districtFilter').value;
  const q = district ? `?district=${district}` : '';
  state.reps = await api(`/reps${q}`);
  const sel = document.getElementById('repSelect');
  sel.innerHTML = state.reps
    .map((r) => `<option value="${encodeURIComponent(repKey(r))}">${r.name} (D${r.district})</option>`)
    .join('');

  const districtNum = district ? Number(district) : null;
  const preferred =
    (districtNum === 8 && state.reps.find((r) => r.isD8Pool)) ||
    (districtNum === 1 && state.reps.find((r) => r.name.includes('Patricia'))) ||
    state.reps.find((r) => r.name.includes('Patricia')) ||
    state.reps[0];
  if (preferred) sel.value = encodeURIComponent(repKey(preferred));
}

async function loadWeeklyTemplateStatus(fromDefault) {
  if (!isAdmin()) {
    state.weeklyTemplate = fromDefault || null;
    document.getElementById('btnClearTemplate').hidden = true;
    return;
  }
  const repKeyVal = repKey(state.rep);
  const data = await api(`/schedule/weekly-template?rep=${encodeURIComponent(repKeyVal)}`);
  state.weeklyTemplate = data.template;
  document.getElementById('btnClearTemplate').hidden = !state.weeklyTemplate;
}

function renderTemplateBanner() {
  const banner = document.getElementById('templateBanner');
  if (!isAdmin() || !state.weeklyTemplate) {
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
    banner.innerHTML = `<strong>Weekly template active.</strong> This week started from your saved Mon–Fri layout${fromWeek}. Per-week drafts still override the template.`;
  } else if (state.draftId) {
    banner.innerHTML = `<strong>Weekly template on file${fromWeek}.</strong> This week has its own saved draft. New weeks without a draft will use the template. Last updated ${updated}.`;
  } else {
    banner.innerHTML = `<strong>Weekly template on file${fromWeek}.</strong> Weeks without a saved draft use this layout. Last updated ${updated}.`;
  }
}

async function loadRepWeek() {
  const repKeyVal = decodeURIComponent(document.getElementById('repSelect').value);
  const weekStart = document.getElementById('weekSelect').value;
  state.rep = await api(`/reps/${encodeURIComponent(repKeyVal)}`);
  state.week = (await api('/weeks')).find((w) => w.start === weekStart);
  state.slots = state.rep.visitSlots;

  let defaultWeeklyTemplate = null;
  const drafts = await api(
    `/schedule/draft?rep=${encodeURIComponent(repKeyVal)}&weekStart=${weekStart}`
  );
  if (drafts.length) {
    state.placements = drafts[0].placements;
    state.draftId = drafts[0].id;
    state.placementSource = 'draft';
  } else {
    const def = await api(
      `/schedule/default?rep=${encodeURIComponent(repKeyVal)}&weekStart=${weekStart}`
    );
    state.placements = def.placements;
    state.draftId = null;
    state.placementSource = def.source || 'masterRoute';
    defaultWeeklyTemplate = def.weeklyTemplate;
  }

  await loadWeeklyTemplateStatus(defaultWeeklyTemplate);
  renderTemplateBanner();

  if (isAdmin() && document.getElementById('showProd').checked && state.rep.employeeId) {
    try {
      const prod = await api(
        `/schedule/prod?rep=${encodeURIComponent(repKeyVal)}&weekStart=${weekStart}`
      );
      state.prodShifts = prod.shifts || [];
    } catch {
      state.prodShifts = [];
    }
  } else {
    state.prodShifts = [];
  }

  await validateAndRender();
}

async function validateAndRender() {
  const { results, warnings, allValid } = await api('/schedule/validate', {
    method: 'POST',
    body: JSON.stringify({
      repKey: repKey(state.rep),
      weekStart: state.week.start,
      placements: state.placements,
    }),
  });

  for (const p of state.placements) {
    const r = results.find((x) => slotKey(x) === slotKey(p));
    p._valid = r?.valid ?? false;
    p._message = r?.message;
  }

  renderCalendar(warnings, allValid);
}

function renderCalendar(warnings, allValid) {
  const d8Note =
    state.rep.isD8Pool && isAdmin()
      ? ' · Proposed assignees: Brian Campbell, Kimberly Claflin, James Duchene (planning only — nothing sent)'
      : state.rep.isD8Pool
        ? ' · Pick who should take each D8 visit'
        : '';
  document.getElementById('weekHeader').textContent =
    `${state.rep.name} · ${state.week.label} · ${state.placements.length} visits · ${allValid ? 'All Master Route checks pass' : 'Some placements need fixing'}${d8Note}`;

  const byDay = placementsByDay();
  const cal = document.getElementById('calendar');
  cal.innerHTML = '';

  for (const day of WORK_DAYS) {
    const col = document.createElement('div');
    col.className = 'day-col' + (dayAllowedForAnySlot(day) ? ' allowed' : '');
    col.dataset.day = day;

    const date = state.placements.find((p) => p.dayOfWeek === day)?.scheduledDate || '';
    col.innerHTML = `<div class="day-head">${day}<small>${date}</small></div><div class="day-body"></div>`;
    const body = col.querySelector('.day-body');

    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      const slot = state.drag ? findSlot(state.drag) : null;
      const ok = slot?.allowedDays.includes(day);
      col.classList.toggle('drag-over-ok', ok);
      col.classList.toggle('drag-over-bad', !ok);
    });
    col.addEventListener('dragleave', () => {
      col.classList.remove('drag-over-ok', 'drag-over-bad');
    });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drag-over-ok', 'drag-over-bad');
      if (!state.drag) return;
      const slot = findSlot(state.drag);
      if (!slot?.allowedDays.includes(day)) {
        alert(
          `Store ${state.drag.storeNum} cannot go on ${day}.\nAllowed: ${slot?.allowedDays.join(', ')}`
        );
        return;
      }
      state.drag.dayOfWeek = day;
      state.drag.scheduledDate = dateForDay(day);
      validateAndRender();
    });

    for (const p of byDay[day] || []) {
      body.appendChild(makeChit(p));
    }

    if (isAdmin() && document.getElementById('showProd').checked) {
      for (const s of state.prodShifts.filter((x) => dayFromDate(x.scheduledDate) === day)) {
        const ghost = document.createElement('div');
        ghost.className = 'chit prod-ghost';
        ghost.innerHTML = `<div class="chit-store">${s.storeNum} PROD</div><div class="chit-action">visit ${s.visitId}</div>`;
        body.appendChild(ghost);
      }
    }

    cal.appendChild(col);
  }

  const warnEl = document.getElementById('warnings');
  const d8Unassigned = state.rep.isD8Pool
    ? state.placements.filter((p) => !p.proposedAssignee).length
    : 0;
  const allWarnings = [...(warnings || [])];
  if (d8Unassigned) {
    allWarnings.unshift({
      message: `${d8Unassigned} D8 visit(s) still need a proposed assignee.`,
    });
  }

  if (allWarnings.length) {
    warnEl.classList.add('show');
    warnEl.innerHTML =
      '<strong>Fix these before saving</strong><ul>' +
      allWarnings.map((w) => `<li>${w.message}</li>`).join('') +
      '</ul>';
  } else {
    warnEl.classList.remove('show');
    warnEl.innerHTML = '';
  }
}

function dayFromDate(dateStr) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return names[new Date(`${dateStr}T12:00:00`).getDay()];
}

function dateForDay(dayName) {
  const start = new Date(`${state.week.start}T12:00:00`);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const target = names.indexOf(dayName);
  let delta = target - start.getDay();
  if (delta < 0) delta += 7;
  const d = new Date(start);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function taskLineForChit(p) {
  const slot = findSlot(p);
  if (!slot) return '';
  if (slot.pickDay && slot.deliveryDay) {
    return `Pick ${slot.pickDay} · deliver ${slot.deliveryDay}`;
  }
  if ((slot.visitIndex ?? 0) > 0 && !slot.pickDay && !slot.deliveryDay) {
    return `Follow-up · anchor ${slot.anchorServiceDay}`;
  }
  return `Service anchor ${slot.anchorServiceDay}`;
}

function makeChit(p) {
  const tpl = document.getElementById('chitTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  if (!p._valid) el.classList.add('invalid');
  if (state.rep.isD8Pool && !p.proposedAssignee) el.classList.add('unassigned');
  el.querySelector('.chit-store').textContent = `#${p.storeNum}`;
  el.querySelector('.chit-task').textContent = taskLineForChit(p);
  el.querySelector('.chit-account').textContent = p.account || '';
  el.querySelector('.chit-action').textContent = (p.action || '').slice(0, 48);

  if (state.rep.isD8Pool) {
    const assigneeWrap = el.querySelector('.chit-assignee-wrap');
    assigneeWrap.hidden = false;
    const select = assigneeWrap.querySelector('.chit-assignee');
    select.innerHTML =
      '<option value="">Choose proposed assignee…</option>' +
      (state.rep.proposedAssignees || [])
        .map(
          (a) =>
            `<option value="${a.name}"${p.proposedAssignee === a.name ? ' selected' : ''}>${a.label || a.name}</option>`
        )
        .join('');
    select.addEventListener('mousedown', (e) => e.stopPropagation());
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      p.proposedAssignee = select.value;
      validateAndRender();
    });
  }

  el.addEventListener('dragstart', () => {
    state.drag = p;
  });
  el.addEventListener('dragend', () => {
    state.drag = null;
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('.chit-assignee')) return;
    showSlotDetail(p);
  });
  return el;
}

async function showSlotDetail(p) {
  try {
    const detail = await api('/schedule/visit-detail', {
      method: 'POST',
      body: JSON.stringify({
        repKey: repKey(state.rep),
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
    document.getElementById('slotDetail').textContent = lines.join('\n');

    document.getElementById('visitChecklist').innerHTML =
      `<div class="visit-type">Checklist</div><ul>` +
      detail.checklist.map((c) => `<li>${c}</li>`).join('') +
      `</ul>`;
  } catch {
    document.getElementById('slotDetail').textContent = 'Could not load visit details.';
    document.getElementById('visitChecklist').innerHTML = '';
  }
}

async function saveDraft() {
  const draft = await api('/schedule/draft', {
    method: 'POST',
    body: JSON.stringify({
      repKey: repKey(state.rep),
      weekStart: state.week.start,
      weekEnd: state.week.end,
      weekLabel: state.week.label,
      placements: state.placements,
      createdBy: state.user?.email || document.getElementById('approverEmail').value || 'local',
    }),
  });
  state.draftId = draft.id;
  state.placementSource = 'draft';
  renderTemplateBanner();
  alert(`Week saved (${draft.id})`);
}

async function saveWeeklyTemplate() {
  const ok = confirm(
    `Save this Mon–Fri layout as the default starting point for ${state.rep.name}?\n\nAny week without its own saved draft will open with this pattern.`
  );
  if (!ok) return;

  const { template } = await api('/schedule/weekly-template', {
    method: 'POST',
    body: JSON.stringify({
      repKey: repKey(state.rep),
      placements: state.placements,
      setFromWeekLabel: state.week.label,
      setBy: state.user?.email || 'admin',
    }),
  });
  state.weeklyTemplate = template;
  document.getElementById('btnClearTemplate').hidden = false;
  renderTemplateBanner();
  alert(`Weekly template saved from ${state.week.label}.`);
}

async function clearWeeklyTemplate() {
  const ok = confirm(`Clear the weekly template for ${state.rep.name}?`);
  if (!ok) return;

  await api(`/schedule/weekly-template?rep=${encodeURIComponent(repKey(state.rep))}`, {
    method: 'DELETE',
  });
  state.weeklyTemplate = null;
  document.getElementById('btnClearTemplate').hidden = true;
  if (!state.draftId) await loadRepWeek();
  else renderTemplateBanner();
  alert('Weekly template cleared.');
}

async function approveWeek() {
  if (!state.draftId) await saveDraft();
  const approvedBy = state.user?.email || document.getElementById('approverEmail').value || 'supervisor';
  const { handoff } = await api('/schedule/approve', {
    method: 'POST',
    body: JSON.stringify({
      draftId: state.draftId,
      approvedBy,
      prodShifts: state.prodShifts,
    }),
  });
  state.handoff = handoff;
  document.getElementById('reviewPane').textContent = handoff.markdown.slice(0, 4000) + '\n…';
  alert('Week approved — handoff ready (Copy Markdown / JSON / Download bundle)');
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  alert('Copied to clipboard');
}

document.getElementById('btnReload').addEventListener('click', loadRepWeek);
document.getElementById('btnSave').addEventListener('click', saveDraft);
document.getElementById('btnSaveTemplate').addEventListener('click', saveWeeklyTemplate);
document.getElementById('btnClearTemplate').addEventListener('click', clearWeeklyTemplate);
document.getElementById('btnApprove').addEventListener('click', approveWeek);
document.getElementById('btnCopyMd').addEventListener('click', async () => {
  if (!state.draftId) return alert('Approve first');
  const h = await api(`/schedule/handoff/${state.draftId}`);
  copyText(h.markdown);
});
document.getElementById('btnCopyJson').addEventListener('click', async () => {
  if (!state.draftId) return alert('Approve first');
  const h = await api(`/schedule/handoff/${state.draftId}`);
  copyText(JSON.stringify(h.json, null, 2));
});
document.getElementById('btnDownload').addEventListener('click', () => {
  if (!state.draftId) return alert('Approve first');
  window.location.href = `${API}/schedule/export/${state.draftId}?format=handoff`;
});
document.getElementById('btnSignOut').addEventListener('click', () => window.cpSignOut());
document.getElementById('districtFilter').addEventListener('change', async () => {
  await loadReps();
  await loadRepWeek();
});
document.getElementById('repSelect').addEventListener('change', loadRepWeek);
document.getElementById('weekSelect').addEventListener('change', loadRepWeek);
document.getElementById('showProd').addEventListener('change', loadRepWeek);

(async function init() {
  await window.cpAuth.bootPromise;

  const meRes = await window.cpAuthFetch(`${AUTH_API}/me`);
  if (!meRes.ok) throw new Error('Could not load account');
  state.user = await meRes.json();
  state.layer = state.user.layer || 'rep';
  applyLayer();

  document.getElementById('districtFilter').value = '1';
  await loadWeeks();
  await loadReps();
  await loadRepWeek();
})();
