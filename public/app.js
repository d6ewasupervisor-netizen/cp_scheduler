const API = '/api/central-pet';
const WORK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

let state = {
  reps: [],
  rep: null,
  week: null,
  placements: [],
  slots: [],
  draftId: null,
  prodShifts: [],
  drag: null,
};

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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
  sel.innerHTML = state.reps.map((r) => `<option value="${r.name}">${r.name} (D${r.district})</option>`).join('');
  const patricia = state.reps.find((r) => r.name.includes('Patricia'));
  if (patricia) sel.value = patricia.name;
}

async function loadRepWeek() {
  const repName = document.getElementById('repSelect').value;
  const weekStart = document.getElementById('weekSelect').value;
  state.rep = await api(`/reps/${encodeURIComponent(repName)}`);
  state.week = (await api('/weeks')).find((w) => w.start === weekStart);
  state.slots = state.rep.visitSlots;

  const drafts = await api(`/schedule/draft?rep=${encodeURIComponent(repName)}&weekStart=${weekStart}`);
  if (drafts.length) {
    state.placements = drafts[0].placements;
    state.draftId = drafts[0].id;
  } else {
    const def = await api(`/schedule/default?rep=${encodeURIComponent(repName)}&weekStart=${weekStart}`);
    state.placements = def.placements;
    state.draftId = null;
  }

  if (document.getElementById('showProd').checked && state.rep.employeeId) {
    try {
      const prod = await api(
        `/schedule/prod?rep=${encodeURIComponent(repName)}&weekStart=${weekStart}`
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
      repKey: state.rep.name,
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
  document.getElementById('weekHeader').textContent =
    `${state.rep.name} · ${state.week.label} · ${state.placements.length} visits · ${allValid ? 'All Master Route checks pass' : 'Some placements invalid'}`;

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
        alert(`Store ${state.drag.storeNum} cannot be scheduled on ${day}.\nAllowed: ${slot?.allowedDays.join(', ')}`);
        return;
      }
      state.drag.dayOfWeek = day;
      state.drag.scheduledDate = dateForDay(day);
      validateAndRender();
    });

    for (const p of byDay[day] || []) {
      body.appendChild(makeChit(p));
    }

    if (document.getElementById('showProd').checked) {
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
  if (warnings?.length) {
    warnEl.classList.add('show');
    warnEl.innerHTML = '<strong>Warnings</strong><ul>' + warnings.map((w) => `<li>${w.message}</li>`).join('') + '</ul>';
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

function makeChit(p) {
  const tpl = document.getElementById('chitTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  if (!p._valid) el.classList.add('invalid');
  el.querySelector('.chit-store').textContent = `#${p.storeNum}`;
  el.querySelector('.chit-account').textContent = p.account || '';
  el.querySelector('.chit-action').textContent = (p.action || '').slice(0, 40);
  el.addEventListener('dragstart', () => {
    state.drag = p;
  });
  el.addEventListener('dragend', () => {
    state.drag = null;
  });
  el.addEventListener('click', () => showSlotDetail(p));
  return el;
}

function showSlotDetail(p) {
  const slot = findSlot(p);
  document.getElementById('slotDetail').textContent = slot
    ? `Store ${p.storeNum}\nAccount: ${p.account}\nAction: ${p.action}\nAnchor: ${slot.anchorServiceDay}\nAllowed: ${slot.allowedDays.join(', ')}\nPick: ${slot.pickDay || '-'}\nDelivery: ${slot.deliveryDay || '-'}\nPlaced: ${p.dayOfWeek} (${p.scheduledDate})\nValid: ${p._valid ? 'YES' : 'NO'}`
    : 'No slot metadata';
}

async function saveDraft() {
  const draft = await api('/schedule/draft', {
    method: 'POST',
    body: JSON.stringify({
      repKey: state.rep.name,
      weekStart: state.week.start,
      weekEnd: state.week.end,
      weekLabel: state.week.label,
      placements: state.placements,
      createdBy: document.getElementById('approverEmail').value || 'local',
    }),
  });
  state.draftId = draft.id;
  alert(`Draft saved (${draft.id})`);
}

async function approveWeek() {
  if (!state.draftId) await saveDraft();
  const approvedBy = document.getElementById('approverEmail').value || 'supervisor';
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
document.getElementById('districtFilter').addEventListener('change', async () => {
  await loadReps();
  await loadRepWeek();
});
document.getElementById('repSelect').addEventListener('change', loadRepWeek);
document.getElementById('weekSelect').addEventListener('change', loadRepWeek);
document.getElementById('showProd').addEventListener('change', loadRepWeek);

(async function init() {
  await loadWeeks();
  await loadReps();
  await loadRepWeek();
})();
