// visit-flow-ui.js — Stage 3 free-navigation visit sections (Shift Day surface).
// STILL READ-ONLY vs prod: every call here hits /shift-day/visit/* which only
// touches the local JSON draft store — no SAS writes.
//
// Navigation is free: any section is tappable any time. Seal-time (Finish Visit
// on Review) is the only gate.

import { toast } from '/shared.js';

const API = '/api/central-pet';

async function apiCall(path, opts = {}) {
  const res = await window.cpAuthFetch(`${API}${path}`, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.code = data.code;
    err.unmet = data.unmet;
    throw err;
  }
  return data;
}

const STEP_LABELS = {
  before_photos: 'Before Photos',
  load_check: 'Load',
  write_order_checklist: 'Order Checklist',
  category_photos: 'Category Photos',
  survey: 'Survey',
  after_photos: 'After Photos',
  time: 'Time',
  review: 'Review & Finish',
};

const STATUS_LABELS = {
  empty: 'Empty',
  in_progress: 'In progress',
  complete: 'Complete',
  needs_attention: 'Needs attention',
};

/** Mirrors src/lib/visit-flow.js surveyVisibility so the UI can react live
 *  to answers without a round trip per keystroke. */
function evalCondition(cond, answers) {
  if (!cond) return true;
  const actual = answers?.[cond.questionId];
  if (actual == null) return false;
  if (cond.op === 'equals') return actual === cond.value;
  if (cond.op === 'notEquals') return actual !== cond.value;
  return true;
}

export function createVisitFlowController({ $, getRepKey, onDraftChanged }) {
  const vf = {
    shift: null,
    draft: null,
    scopeChecklist: null,
    survey: null,
    categoryTargets: null,
    pendingAnchor: null,
  };

  async function ensureStaticData() {
    if (!vf.scopeChecklist) vf.scopeChecklist = await apiCall('/shift-day/visit-flow/scope-checklist');
    if (!vf.survey) vf.survey = await apiCall('/shift-day/visit-flow/survey');
    if (!vf.categoryTargets) vf.categoryTargets = await apiCall('/shift-day/visit-flow/category-targets');
  }

  function setSaveState(s) {
    const el = $('vfSaveState');
    el.dataset.state = s;
    el.textContent = s === 'saving' ? 'Saving…' : 'Saved';
  }

  async function refreshDraft() {
    vf.draft = await apiCall(
      `/shift-day/visit?rep=${encodeURIComponent(getRepKey())}&date=${vf.draft.date}&store=${vf.draft.actualStore}`
    );
    onDraftChanged?.(vf.draft);
    renderAll();
    return vf.draft;
  }

  async function autosave(fn) {
    setSaveState('saving');
    try {
      vf.draft = await fn();
      setSaveState('saved');
      onDraftChanged?.(vf.draft);
    } catch (err) {
      toast(`Autosave failed: ${err.message}`, 'bad', 4500);
      throw err;
    }
  }

  /* ---------- Photo capture (shared by before/after/category/load/checklist) ---------- */

  function photoCaptureBlock({ label, photos, minRequired = 0, onCapture, onRemove, anchorId }) {
    const wrap = document.createElement('div');
    wrap.className = 'vf-photo-block';
    if (anchorId) wrap.id = anchorId;
    const count = photos?.length || 0;
    wrap.innerHTML = `
      <div class="vf-photo-head">
        <strong>${label}</strong>
        <span class="vf-photo-count">${count} photo${count === 1 ? '' : 's'}${minRequired ? ` (min ${minRequired})` : ''}</span>
      </div>
      <div class="vf-photo-grid">${(photos || [])
        .map(
          (p, i) =>
            `<div class="vf-photo-thumb" data-seq="${p.seq ?? i + 1}">#${i + 1}${
              onRemove ? `<button type="button" class="vf-photo-remove" data-seq="${p.seq ?? i + 1}" aria-label="Remove photo">×</button>` : ''
            }</div>`
        )
        .join('')}</div>
      <label class="vf-photo-input primary">
        Capture photo
        <input type="file" accept="image/*" capture="environment" hidden>
      </label>`;
    wrap.querySelector('input[type=file]').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      await onCapture(file);
    });
    if (onRemove) {
      wrap.querySelectorAll('.vf-photo-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove(Number(btn.dataset.seq));
        });
      });
    }
    return wrap;
  }

  async function uploadPhoto(file, extra) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('repKey', getRepKey());
    fd.append('date', vf.draft.date);
    fd.append('actualStore', vf.draft.actualStore);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    await autosave(() => apiCall('/shift-day/visit/photo', { method: 'POST', body: fd }));
    renderAll();
  }

  async function removePhoto(target, seq) {
    await autosave(() =>
      apiCall('/shift-day/visit/photo/remove', {
        method: 'POST',
        body: JSON.stringify({
          repKey: getRepKey(),
          date: vf.draft.date,
          actualStore: vf.draft.actualStore,
          target,
          seq,
        }),
      })
    );
    renderAll();
  }

  /* ---------- Section renderers ---------- */

  function renderBeforeAfter(kind) {
    const body = $('vfBody');
    body.innerHTML = '';
    const photos = kind === 'before' ? vf.draft.beforePhotos : vf.draft.afterPhotos;
    const p = document.createElement('p');
    p.className = 'overlay-meta';
    p.textContent =
      kind === 'before'
        ? 'Photograph the Pet Supplies aisle — two 4ft sections per photo. At least 1 photo required; more is better coverage. (Time-sensitive: capture on arrival.)'
        : 'Same as before: two 4ft sections per photo, full coverage of the Pet Supplies aisle.';
    body.appendChild(p);
    body.appendChild(
      photoCaptureBlock({
        label: kind === 'before' ? 'Before photos' : 'After photos',
        photos,
        minRequired: 1,
        anchorId: kind === 'before' ? 'before-photos' : 'after-photos',
        onCapture: (file) => uploadPhoto(file, { target: kind }),
        onRemove: (seq) => removePhoto(kind, seq),
      })
    );
  }

  function renderLoadCheck() {
    const body = $('vfBody');
    body.innerHTML = '';
    const status = vf.draft.loadCheck?.status || null;
    const askEl = document.createElement('div');
    askEl.className = 'overlay-meta';
    askEl.id = 'load-check';
    askEl.innerHTML = `<strong>Did you find the load?</strong>`;
    body.appendChild(askEl);

    const btnRow = document.createElement('div');
    btnRow.className = 'vf-btn-row';
    btnRow.innerHTML = `
      <button type="button" id="vfLoadYes" class="${status === 'yes' ? 'primary' : ''}">Yes</button>
      <button type="button" id="vfLoadNo" class="${status && status !== 'yes' ? 'primary' : ''}">No</button>`;
    body.appendChild(btnRow);

    const instr = document.createElement('p');
    instr.className = 'overlay-meta';
    body.appendChild(instr);

    if (status === 'yes') {
      instr.textContent = 'Great — take a photo of the load, then work it to the shelf.';
      body.appendChild(
        photoCaptureBlock({
          label: 'Load photo',
          photos: vf.draft.loadCheck?.photo ? [vf.draft.loadCheck.photo] : [],
          minRequired: 1,
          anchorId: 'load-photo',
          onCapture: (file) => uploadPhoto(file, { target: 'load', status: 'yes' }),
        })
      );
    } else if (status === 'no_found_later') {
      instr.textContent =
        "Check the racks in the back of the warehouse. Look behind everything, and confirm the load wasn't already placed on the floor or near the pet area.";
      const stillNot = document.createElement('button');
      stillNot.type = 'button';
      stillNot.className = 'subtle';
      stillNot.textContent = 'Still not found — contact supervisor';
      stillNot.addEventListener('click', () =>
        autosave(() =>
          apiCall('/shift-day/visit/load-check', {
            method: 'POST',
            body: JSON.stringify({
              repKey: getRepKey(),
              date: vf.draft.date,
              actualStore: vf.draft.actualStore,
              status: 'no_escalated',
            }),
          })
        ).then(renderAll)
      );
      body.appendChild(stillNot);
    } else if (status === 'no_escalated') {
      instr.textContent = `Contact me so I can check if tracking is available for your store — include the store number you are physically at (store ${vf.draft.actualStore}). Escalation counts as a complete load outcome.`;
    }

    $('vfLoadYes').addEventListener('click', () =>
      autosave(() =>
        apiCall('/shift-day/visit/load-check', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            status: 'yes',
          }),
        })
      ).then(renderAll)
    );
    $('vfLoadNo').addEventListener('click', () =>
      autosave(() =>
        apiCall('/shift-day/visit/load-check', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            status: 'no_found_later',
          }),
        })
      ).then(renderAll)
    );
  }

  function writeOrderItems() {
    const items = [];
    for (const section of vf.scopeChecklist.sections) {
      for (const item of section.items) {
        if (item.appliesTo === 'order' || item.appliesTo === 'both') {
          items.push({ ...item, sectionTitle: section.title });
        }
      }
    }
    return items;
  }

  function renderChecklist() {
    const body = $('vfBody');
    body.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'overlay-meta';
    note.innerHTML =
      'Amp by Movista: scan item tags on the product itself (not shelf tags) for items that aren\'t missing, where available.';
    body.appendChild(note);

    let lastSection = null;
    for (const item of writeOrderItems()) {
      if (item.sectionTitle !== lastSection) {
        const h = document.createElement('h3');
        h.className = 'vf-section-head';
        h.textContent = item.sectionTitle;
        body.appendChild(h);
        lastSection = item.sectionTitle;
      }
      const row = document.createElement('label');
      row.className = 'vf-checklist-row';
      row.id = `checklist-${item.id}`;
      const checked = !!vf.draft.checklist[item.id]?.checked;
      row.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}> <span>${item.text}</span>`;
      row.querySelector('input').addEventListener('change', (e) =>
        autosave(() =>
          apiCall('/shift-day/visit/checklist', {
            method: 'POST',
            body: JSON.stringify({
              repKey: getRepKey(),
              date: vf.draft.date,
              actualStore: vf.draft.actualStore,
              itemId: item.id,
              checked: e.target.checked,
            }),
          })
        ).then(renderSidebar)
      );
      body.appendChild(row);
      if (item.photoRequired) {
        body.appendChild(
          photoCaptureBlock({
            label: `${item.id} photo`,
            photos: vf.draft.checklist[item.id]?.photo ? [vf.draft.checklist[item.id].photo] : [],
            minRequired: 1,
            anchorId: `checklist-photo-${item.id}`,
            onCapture: (file) => uploadPhoto(file, { target: 'checklist', itemId: item.id }),
          })
        );
      }
    }
  }

  function renderCategoryPhotos() {
    const body = $('vfBody');
    body.innerHTML = '';
    for (const cat of vf.categoryTargets) {
      const h = document.createElement('h3');
      h.className = 'vf-section-head';
      h.id = `category-${cat.id}`;
      h.textContent = cat.label;
      body.appendChild(h);
      body.appendChild(
        photoCaptureBlock({
          label: cat.label,
          photos: vf.draft.categoryPhotos[cat.id] || [],
          minRequired: 1,
          anchorId: `category-block-${cat.id}`,
          onCapture: (file) => uploadPhoto(file, { target: 'category', categoryId: cat.id }),
        })
      );
    }
  }

  function surveyVisibility() {
    const answers = vf.draft.survey || {};
    return Object.fromEntries(vf.survey.questions.map((q) => [q.id, evalCondition(q.visibleIf, answers)]));
  }

  function renderSurvey() {
    const body = $('vfBody');
    body.innerHTML = '';
    if (vf.survey._meta?.pending) {
      const warn = document.createElement('p');
      warn.className = 'overlay-flag';
      warn.textContent = 'Survey wording pending — placeholder questions shown until exact text is supplied.';
      body.appendChild(warn);
    }
    const visibility = surveyVisibility();
    const answers = vf.draft.survey || {};
    // Follow-ups hide/show reactively; hidden answers stay in the draft (not deleted).
    for (const q of vf.survey.questions.slice().sort((a, b) => a.order - b.order)) {
      if (!visibility[q.id]) continue;
      const wrap = document.createElement('div');
      wrap.className = 'vf-survey-q';
      wrap.id = `survey-${q.id}`;
      const label = document.createElement('div');
      label.className = 'vf-survey-label';
      label.textContent = `Q${q.order}. ${q.text}`;
      wrap.appendChild(label);

      if (q.autoFill && answers[q.id] != null) {
        const badge = document.createElement('span');
        badge.className = 'sd-badge order';
        badge.textContent = `Auto-filled: ${answers[q.id]}`;
        wrap.appendChild(badge);
      } else if (q.type === 'yesno' || q.type === 'single-select') {
        const row = document.createElement('div');
        row.className = 'vf-btn-row';
        for (const opt of q.options) {
          const btn = document.createElement('button');
          btn.type = 'button';
          if (answers[q.id] === opt) btn.className = 'primary';
          btn.textContent = opt;
          btn.addEventListener('click', () =>
            autosave(() =>
              apiCall('/shift-day/visit/survey', {
                method: 'POST',
                body: JSON.stringify({
                  repKey: getRepKey(),
                  date: vf.draft.date,
                  actualStore: vf.draft.actualStore,
                  answers: { [q.id]: opt },
                }),
              })
            ).then(renderAll)
          );
          row.appendChild(btn);
        }
        wrap.appendChild(row);
      } else {
        const textarea = document.createElement('textarea');
        textarea.rows = 2;
        textarea.value = answers[q.id] || '';
        textarea.addEventListener('blur', () =>
          autosave(() =>
            apiCall('/shift-day/visit/survey', {
              method: 'POST',
              body: JSON.stringify({
                repKey: getRepKey(),
                date: vf.draft.date,
                actualStore: vf.draft.actualStore,
                answers: { [q.id]: textarea.value },
              }),
            })
          ).then(renderSidebar)
        );
        wrap.appendChild(textarea);
      }
      body.appendChild(wrap);
    }
  }

  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderTime() {
    const body = $('vfBody');
    body.innerHTML = `
      <label class="field" id="time-start">Actual start time
        <input type="datetime-local" id="vfStart" value="${toLocalInput(vf.draft.visitStart.actual)}">
      </label>
      <label class="field" id="time-stop">Stop time
        <input type="datetime-local" id="vfStop" value="${toLocalInput(vf.draft.visitStop.actual)}">
      </label>
      <label class="field" style="flex-direction:row;align-items:center;gap:.5rem">
        <input type="checkbox" id="vfLastStop" ${vf.draft.isLastStopOfDay ? 'checked' : ''}> Last stop of the day
      </label>
      <button type="button" id="vfCalcMileage" class="subtle">Compute mileage leg</button>
      <div id="time-mileage" class="overlay-meta"></div>
      <label class="field">Note (if the leg looks wrong — don't recalculate, just note it)
        <textarea id="vfMileageNote" rows="2">${vf.draft.mileage?.repNote || ''}</textarea>
      </label>`;

    const renderLeg = () => {
      const leg = vf.draft.mileage?.leg;
      $('time-mileage').textContent = leg
        ? `${leg.from} → ${leg.to}: ${leg.miles == null ? 'unresolved' : leg.miles + ' mi'} (${leg.source})${leg.warning ? ' — ' + leg.warning : ''}`
        : 'Not computed yet.';
    };
    renderLeg();

    $('vfStart').addEventListener('change', (e) =>
      autosave(() =>
        apiCall('/shift-day/visit/time', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            startActual: new Date(e.target.value).toISOString(),
          }),
        })
      ).then(renderSidebar)
    );
    $('vfStop').addEventListener('change', (e) =>
      autosave(() =>
        apiCall('/shift-day/visit/time', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            stopActual: new Date(e.target.value).toISOString(),
          }),
        })
      ).then(renderSidebar)
    );
    $('vfLastStop').addEventListener('change', (e) =>
      autosave(() =>
        apiCall('/shift-day/visit/time', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            isLastStopOfDay: e.target.checked,
          }),
        })
      )
    );
    $('vfCalcMileage').addEventListener('click', () =>
      autosave(() =>
        apiCall('/shift-day/visit/mileage', {
          method: 'POST',
          body: JSON.stringify({ repKey: getRepKey(), date: vf.draft.date, actualStore: vf.draft.actualStore }),
        })
      ).then(() => {
        renderLeg();
        renderSidebar();
      })
    );
    $('vfMileageNote').addEventListener('blur', (e) =>
      autosave(() =>
        apiCall('/shift-day/visit/mileage', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            repNote: e.target.value,
          }),
        })
      )
    );
  }

  function renderReview() {
    const body = $('vfBody');
    const d = vf.draft;
    const unmet = d.unmetRequirements || [];
    const bySection = new Map();
    for (const u of unmet) {
      if (!bySection.has(u.section)) bySection.set(u.section, []);
      bySection.get(u.section).push(u);
    }

    let unmetHtml = '';
    if (unmet.length) {
      unmetHtml = `<div class="vf-unmet" id="review">
        <h3 class="vf-section-head">Unmet requirements</h3>
        <p class="overlay-meta">Finish Visit stays disabled until every item below is fixed. Tap a row to jump to that section.</p>
        ${[...bySection.entries()]
          .map(
            ([section, items]) => `
          <div class="vf-unmet-group">
            <strong>${STEP_LABELS[section] || section}</strong>
            <ul>
              ${items
                .map(
                  (u) =>
                    `<li><button type="button" class="vf-deep-link" data-section="${u.section}" data-anchor="${u.anchor || ''}">${escapeHtml(
                      u.message
                    )}</button></li>`
                )
                .join('')}
            </ul>
          </div>`
          )
          .join('')}
      </div>`;
    } else {
      unmetHtml = `<p class="vf-ready" id="review">All requirements met — you can Finish Visit to seal this record for Stage 4.</p>`;
    }

    body.innerHTML = `
      <dl class="sd-detail-meta">
        <div><dt>Before photos</dt><dd>${d.beforePhotos.length}</dd></div>
        ${d.loadCheck ? `<div><dt>Load</dt><dd>${d.loadCheck.status || '—'}</dd></div>` : ''}
        ${d.writeOrder ? `<div><dt>Checklist</dt><dd>${Object.values(d.checklist).filter((c) => c.checked).length} checked</dd></div>` : ''}
        <div><dt>Category photos</dt><dd>${Object.values(d.categoryPhotos).reduce((n, a) => n + a.length, 0)}</dd></div>
        <div><dt>Survey</dt><dd>${Object.keys(d.survey).length} answered</dd></div>
        <div><dt>After photos</dt><dd>${d.afterPhotos.length}</dd></div>
        <div><dt>Start</dt><dd>${d.visitStart.actual || '—'}</dd></div>
        <div><dt>Stop</dt><dd>${d.visitStop.actual || '—'}</dd></div>
        <div><dt>Mileage</dt><dd>${d.mileage?.leg ? `${d.mileage.leg.from} → ${d.mileage.leg.to} (${d.mileage.leg.miles ?? '—'} mi)` : '—'}</dd></div>
      </dl>
      ${unmetHtml}
      <p class="overlay-meta">Every section stays editable until you seal. Use the sidebar to jump anywhere — nothing is locked.</p>`;

    body.querySelectorAll('.vf-deep-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        goToSection(btn.dataset.section, btn.dataset.anchor || null);
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- Sidebar + shell ---------- */

  function renderSidebar() {
    const nav = $('vfSidebar');
    const d = vf.draft;
    const statuses = d.sectionStatuses || d.steps.map((id) => ({ id, label: STEP_LABELS[id], status: 'empty', hint: null }));
    nav.innerHTML = statuses
      .map((s) => {
        const active = s.id === d.currentStep ? 'active' : '';
        const hint = s.hint
          ? `<span class="vf-hint-chip" title="${escapeHtml(s.hint)}">${escapeHtml(s.hint)}</span>`
          : '';
        return `<button type="button" class="vf-nav-item ${active} status-${s.status}" data-section="${s.id}">
          <span class="vf-nav-label">${escapeHtml(s.label)}</span>
          <span class="vf-status-chip status-${s.status}">${STATUS_LABELS[s.status] || s.status}</span>
          ${hint}
        </button>`;
      })
      .join('');

    nav.querySelectorAll('.vf-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        goToSection(btn.dataset.section);
        closeSidebarDrawer();
      });
    });

    updateFinishButton();
  }

  function updateFinishButton() {
    const btn = $('vfFinish');
    const onReview = vf.draft.currentStep === 'review';
    btn.hidden = !onReview;
    const can = !!vf.draft.canSeal;
    btn.disabled = !can;
    btn.title = can
      ? 'Seal this visit for Stage 4'
      : `${(vf.draft.unmetRequirements || []).length} requirement(s) still unmet — see Review list`;
  }

  function renderSectionBody() {
    const d = vf.draft;
    $('vfStoreTitle').textContent = `Store ${d.actualStore} — Visit`;
    $('vfStepLabel').textContent = STEP_LABELS[d.currentStep] || d.currentStep;

    if (d.currentStep === 'before_photos') renderBeforeAfter('before');
    else if (d.currentStep === 'load_check') renderLoadCheck();
    else if (d.currentStep === 'write_order_checklist') renderChecklist();
    else if (d.currentStep === 'category_photos') renderCategoryPhotos();
    else if (d.currentStep === 'survey') renderSurvey();
    else if (d.currentStep === 'after_photos') renderBeforeAfter('after');
    else if (d.currentStep === 'time') renderTime();
    else if (d.currentStep === 'review') renderReview();

    if (vf.pendingAnchor) {
      const anchor = vf.pendingAnchor;
      vf.pendingAnchor = null;
      requestAnimationFrame(() => {
        const el = document.getElementById(anchor);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('vf-anchor-flash');
          setTimeout(() => el.classList.remove('vf-anchor-flash'), 1600);
        }
      });
    }
  }

  function renderAll() {
    renderSidebar();
    renderSectionBody();
  }

  async function goToSection(sectionId, anchor = null) {
    if (!sectionId || !vf.draft) return;
    if (!vf.draft.steps.includes(sectionId)) return;
    vf.pendingAnchor = anchor;
    if (sectionId === vf.draft.currentStep) {
      renderAll();
      return;
    }
    await autosave(() =>
      apiCall('/shift-day/visit/step', {
        method: 'POST',
        body: JSON.stringify({
          repKey: getRepKey(),
          date: vf.draft.date,
          actualStore: vf.draft.actualStore,
          step: sectionId,
        }),
      })
    );
    renderAll();
  }

  async function finish() {
    if (!vf.draft.canSeal) {
      toast('Finish blocked — fix the unmet list on Review first', 'bad', 4000);
      renderReview();
      return;
    }
    try {
      await autosave(() =>
        apiCall('/shift-day/visit/finish', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
          }),
        })
      );
      toast('Visit sealed — ready for Stage 4', 'ok');
      close();
    } catch (err) {
      if (err.code === 'SEAL_BLOCKED' && err.unmet) {
        vf.draft.unmetRequirements = err.unmet;
        vf.draft.canSeal = false;
        toast('Seal blocked — see unmet requirements', 'bad', 4500);
        if (vf.draft.currentStep !== 'review') await goToSection('review');
        else renderReview();
        updateFinishButton();
      } else {
        throw err;
      }
    }
  }

  function closeSidebarDrawer() {
    $('visitFlowOverlay')?.classList.remove('vf-sidebar-open');
  }

  function toggleSidebarDrawer() {
    $('visitFlowOverlay')?.classList.toggle('vf-sidebar-open');
  }

  function close() {
    $('visitFlowOverlay').hidden = true;
    closeSidebarDrawer();
  }

  async function open(shift) {
    vf.shift = shift;
    await ensureStaticData();
    vf.draft = await apiCall('/shift-day/visit/start', {
      method: 'POST',
      body: JSON.stringify({
        repKey: getRepKey(),
        weekStart: shift.weekStart,
        shiftId: shift.id,
      }),
    });
    // Start Visit always lands on Before Photos (starting point, not a lock)
    if (vf.draft.currentStep !== 'before_photos' && vf.draft.steps.includes('before_photos') && vf.draft.status === 'in_progress') {
      // Only force landing when brand-new (no edits yet beyond start tap)
      const fresh =
        !vf.draft.beforePhotos.length &&
        !vf.draft.afterPhotos.length &&
        !Object.keys(vf.draft.survey || {}).length &&
        !(vf.draft.loadCheck && vf.draft.loadCheck.status);
      if (fresh && vf.draft.currentStep !== 'before_photos') {
        vf.draft = await apiCall('/shift-day/visit/step', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            step: 'before_photos',
          }),
        });
      }
    }
    onDraftChanged?.(vf.draft);
    renderAll();
    $('visitFlowOverlay').hidden = false;
    closeSidebarDrawer();
  }

  $('vfFinish').addEventListener('click', () => finish());
  $('vfClose').addEventListener('click', close);
  $('vfBackdrop').addEventListener('click', close);
  $('vfSidebarToggle')?.addEventListener('click', toggleSidebarDrawer);

  return { open, close, refreshDraft, goToSection };
}
