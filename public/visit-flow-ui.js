// visit-flow-ui.js — Stage 3 free-navigation visit sections (Shift Day surface).
// STILL READ-ONLY vs prod: every call here hits /shift-day/visit/* which only
// touches the local JSON draft store — no SAS writes.
//
// Navigation is free: any section is tappable any time. Seal-time (Finish Visit
// on Review) is the only gate.

import { toast } from '/shared.js';
import { createPhotoUploadQueue } from '/photo-upload-queue.js';

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

  /** Background photo uploads — capture never waits for network. */
  // Concurrency 1: visit draft is a single JSON file — parallel POSTs can race.
  // Capture stays non-blocking; uploads simply drain the queue in order.
  const photoQueue = createPhotoUploadQueue({
    maxConcurrent: 1,
    uploadFn: async (item) => {
      if (!vf.draft) throw new Error('No active visit draft');
      const fd = new FormData();
      fd.append('file', item.file);
      fd.append('repKey', getRepKey());
      fd.append('date', vf.draft.date);
      fd.append('actualStore', vf.draft.actualStore);
      for (const [k, v] of Object.entries(item.extra || {})) {
        if (v != null) fd.append(k, v);
      }
      const draft = await apiCall('/shift-day/visit/photo', { method: 'POST', body: fd });
      return draft;
    },
    onChange: (snap) => {
      updatePhotoQueueSaveState(snap);
      // Soft refresh: keep capture control free; only re-render photo UI when useful
      if (vf.draft) {
        // Prefer light thumb refresh when still on a photo-heavy section
        const step = vf.draft.currentStep;
        if (
          step === 'before_photos' ||
          step === 'after_photos' ||
          step === 'category_photos' ||
          step === 'load_check' ||
          step === 'write_order_checklist' ||
          step === 'review'
        ) {
          // When an upload finishes, merge draft from latest successful result
          const lastDone = [...photoQueue.items].reverse().find((i) => i.status === 'done' && i.result);
          if (lastDone?.result) {
            vf.draft = lastDone.result;
            onDraftChanged?.(vf.draft);
            photoQueue.pruneDone();
          }
          renderAll();
        }
      }
      if (snap.failed > 0 && snap.inFlight === 0) {
        toast(`${snap.failed} photo(s) failed to upload — tap Retry on the red thumb`, 'bad', 5000);
      }
    },
  });

  async function ensureStaticData() {
    if (!vf.scopeChecklist) vf.scopeChecklist = await apiCall('/shift-day/visit-flow/scope-checklist');
    if (!vf.survey) vf.survey = await apiCall('/shift-day/visit-flow/survey');
    if (!vf.categoryTargets) vf.categoryTargets = await apiCall('/shift-day/visit-flow/category-targets');
  }

  function setSaveState(s, label) {
    const el = $('vfSaveState');
    if (!el) return;
    el.dataset.state = s;
    el.textContent =
      label ||
      (s === 'saving' ? 'Saving…' : s === 'error' ? 'Upload error' : 'Saved');
  }

  // In-flight photo captures live only in this tab's memory until the server
  // confirms the upload — a refresh/close mid-upload would silently drop them.
  // Warn (native browser prompt) so the rep waits for "Saved" first.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (e) => {
      if (photoQueue.snapshot().inFlight > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  function updatePhotoQueueSaveState(snap) {
    const s = snap || photoQueue.snapshot();
    if (s.inFlight > 0) {
      setSaveState(
        'saving',
        `Uploading ${s.uploading || 0}/${s.inFlight}…${s.queued ? ` (${s.queued} queued)` : ''}`
      );
    } else if (s.failed > 0) {
      setSaveState('error', `${s.failed} photo upload(s) failed`);
    } else {
      setSaveState('saved');
    }
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
      updatePhotoQueueSaveState();
      onDraftChanged?.(vf.draft);
    } catch (err) {
      toast(`Autosave failed: ${err.message}`, 'bad', 4500);
      throw err;
    }
  }

  /* ---------- Photo capture (shared by before/after/category/load/checklist) ---------- */

  function photoCaptureBlock({ label, photos, minRequired = 0, onCapture, onRemove, anchorId, pending = [] }) {
    const wrap = document.createElement('div');
    wrap.className = 'vf-photo-block';
    if (anchorId) wrap.id = anchorId;
    const uploaded = photos?.length || 0;
    const pendingCount = (pending || []).filter((p) => p.status !== 'failed').length;
    const failedCount = (pending || []).filter((p) => p.status === 'failed').length;
    const totalShown = uploaded + (pending || []).length;
    let countLabel = `${uploaded} saved`;
    if (pendingCount) countLabel += ` · ${pendingCount} sending`;
    if (failedCount) countLabel += ` · ${failedCount} failed`;
    if (minRequired) countLabel += ` (min ${minRequired})`;

    const serverThumbs = (photos || [])
      .map(
        (p, i) =>
          `<div class="vf-photo-thumb vf-photo-ok" data-seq="${p.seq ?? i + 1}" title="Saved">#${i + 1}${
            onRemove
              ? `<button type="button" class="vf-photo-remove" data-seq="${p.seq ?? i + 1}" aria-label="Remove photo">×</button>`
              : ''
          }</div>`
      )
      .join('');

    const pendingThumbs = (pending || [])
      .map((p, i) => {
        const n = uploaded + i + 1;
        const st = p.status === 'failed' ? 'failed' : p.status === 'uploading' ? 'uploading' : 'queued';
        const title =
          p.status === 'failed'
            ? `Failed: ${escapeHtml(p.error || 'upload error')}`
            : p.status === 'uploading'
              ? 'Uploading…'
              : 'Queued…';
        const retry =
          p.status === 'failed'
            ? `<button type="button" class="vf-photo-retry" data-qid="${p.id}" aria-label="Retry upload">↻</button>`
            : '';
        const bg = p.previewUrl
          ? `style="background-image:url('${p.previewUrl}');background-size:cover;background-position:center"`
          : '';
        return `<div class="vf-photo-thumb vf-photo-${st}" data-qid="${p.id}" title="${title}" ${bg}>
          <span class="vf-photo-badge">${st === 'failed' ? '!' : n}</span>${retry}
        </div>`;
      })
      .join('');

    wrap.innerHTML = `
      <div class="vf-photo-head">
        <strong>${label}</strong>
        <span class="vf-photo-count">${countLabel}</span>
      </div>
      <div class="vf-photo-grid">${serverThumbs}${pendingThumbs}</div>
      <label class="vf-photo-input primary">
        Capture photo
        <input type="file" accept="image/*" capture="environment" hidden>
      </label>
      <p class="vf-photo-hint overlay-meta">Fire shots as fast as you need — uploads catch up in the background.</p>`;

    // Do NOT await upload — queue immediately so the next capture can open.
    wrap.querySelector('input[type=file]').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        onCapture(file);
      } catch (err) {
        toast(`Could not queue photo: ${err.message}`, 'bad', 4000);
      }
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
    wrap.querySelectorAll('.vf-photo-retry').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        photoQueue.retry(btn.dataset.qid);
      });
    });
    return wrap;
  }

  /** Queue photo for background upload — returns immediately. */
  function queuePhoto(file, extra) {
    photoQueue.enqueue(file, extra);
    // Instant UI feedback without waiting for network
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
    const extra = { target: kind };
    body.appendChild(
      photoCaptureBlock({
        label: kind === 'before' ? 'Before photos' : 'After photos',
        photos,
        minRequired: 1,
        anchorId: kind === 'before' ? 'before-photos' : 'after-photos',
        pending: photoQueue.pendingFor(extra),
        onCapture: (file) => queuePhoto(file, extra),
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
      const loadExtra = { target: 'load', status: 'yes' };
      body.appendChild(
        photoCaptureBlock({
          label: 'Load photo',
          photos: vf.draft.loadCheck?.photo ? [vf.draft.loadCheck.photo] : [],
          minRequired: 1,
          anchorId: 'load-photo',
          pending: photoQueue.pendingFor(loadExtra),
          onCapture: (file) => queuePhoto(file, loadExtra),
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
        const clExtra = { target: 'checklist', itemId: item.id };
        body.appendChild(
          photoCaptureBlock({
            label: `${item.id} photo`,
            photos: vf.draft.checklist[item.id]?.photo ? [vf.draft.checklist[item.id].photo] : [],
            minRequired: 1,
            anchorId: `checklist-photo-${item.id}`,
            pending: photoQueue.pendingFor(clExtra),
            onCapture: (file) => queuePhoto(file, clExtra),
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
      const catExtra = { target: 'category', categoryId: cat.id };
      body.appendChild(
        photoCaptureBlock({
          label: cat.label,
          photos: vf.draft.categoryPhotos[cat.id] || [],
          minRequired: 1,
          anchorId: `category-block-${cat.id}`,
          pending: photoQueue.pendingFor(catExtra),
          onCapture: (file) => queuePhoto(file, catExtra),
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

    const qSnap = photoQueue.snapshot();
    const uploadLine =
      qSnap.inFlight || qSnap.failed
        ? `<div><dt>Photo uploads</dt><dd>${
            qSnap.inFlight ? `${qSnap.inFlight} in progress` : 'idle'
          }${qSnap.failed ? ` · ${qSnap.failed} failed` : ''}</dd></div>`
        : '';
    body.innerHTML = `
      <dl class="sd-detail-meta">
        <div><dt>Before photos</dt><dd>${d.beforePhotos.length}</dd></div>
        ${d.loadCheck ? `<div><dt>Load</dt><dd>${d.loadCheck.status || '—'}</dd></div>` : ''}
        ${d.writeOrder ? `<div><dt>Checklist</dt><dd>${Object.values(d.checklist).filter((c) => c.checked).length} checked</dd></div>` : ''}
        <div><dt>Category photos</dt><dd>${Object.values(d.categoryPhotos).reduce((n, a) => n + a.length, 0)}</dd></div>
        <div><dt>Survey</dt><dd>${Object.keys(d.survey).length} answered</dd></div>
        <div><dt>After photos</dt><dd>${d.afterPhotos.length}</dd></div>
        ${uploadLine}
        <div><dt>Start</dt><dd>${d.visitStart.actual || '—'}</dd></div>
        <div><dt>Stop</dt><dd>${d.visitStop.actual || '—'}</dd></div>
        <div><dt>Mileage</dt><dd>${d.mileage?.leg ? `${d.mileage.leg.from} → ${d.mileage.leg.to} (${d.mileage.leg.miles ?? '—'} mi)` : '—'}</dd></div>
      </dl>
      ${unmetHtml}
      <p class="overlay-meta">Every section stays editable until you seal. Use the sidebar to jump anywhere — nothing is locked. Photo captures upload in the background; Finish stays off until all uploads succeed.</p>`;

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
    const q = photoQueue.snapshot();
    const uploadsBlocking = q.inFlight > 0 || q.failed > 0;
    const can = !!vf.draft.canSeal && !uploadsBlocking;
    btn.disabled = !can;
    if (q.inFlight > 0) {
      btn.title = `Wait for ${q.inFlight} photo upload(s) to finish`;
    } else if (q.failed > 0) {
      btn.title = `${q.failed} photo upload(s) failed — retry or remove before sealing`;
    } else if (can) {
      btn.title = 'Seal this visit for Stage 4';
    } else {
      btn.title = `${(vf.draft.unmetRequirements || []).length} requirement(s) still unmet — see Review list`;
    }
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
    updateVisitMeta();
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
    const q = photoQueue.snapshot();
    if (q.inFlight > 0) {
      toast(`Still uploading ${q.inFlight} photo(s) — finish when the counter says Saved`, 'warn', 4500);
      return;
    }
    if (q.failed > 0) {
      toast(`${q.failed} photo(s) failed — retry the red thumbs before sealing`, 'bad', 5000);
      return;
    }
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

  function workspaceEl() {
    return $('visitWorkspace') || $('visitFlowOverlay');
  }

  function closeSidebarDrawer() {
    workspaceEl()?.classList.remove('vf-sidebar-open');
  }

  function toggleSidebarDrawer() {
    workspaceEl()?.classList.toggle('vf-sidebar-open');
  }

  function setVisitShellOpen(open) {
    const ws = workspaceEl();
    if (!ws) return;
    ws.hidden = !open;
    document.body.classList.toggle('visit-workspace-open', open);
    const schedule = $('sdApp');
    const sticky = $('sdSticky');
    const topbar = document.querySelector('.topbar-shiftday');
    if (open) {
      if (schedule) {
        if (schedule.dataset.wasHidden == null) {
          schedule.dataset.wasHidden = schedule.hidden ? '1' : '0';
        }
        schedule.hidden = true;
      }
      if (sticky) sticky.hidden = true;
      if (topbar) topbar.hidden = true;
    } else {
      if (schedule) {
        schedule.hidden = schedule.dataset.wasHidden === '1';
        delete schedule.dataset.wasHidden;
      }
      if (topbar) topbar.hidden = false;
    }
  }

  function close() {
    setVisitShellOpen(false);
    closeSidebarDrawer();
    vf.shift = null;
  }

  function updateVisitMeta() {
    const meta = $('vfVisitMeta');
    if (!meta || !vf.draft) return;
    const d = vf.draft;
    const day = d.date
      ? new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '—';
    meta.textContent = `${day} · Store ${d.actualStore}${
      d.scheduledStore != null && Number(d.scheduledStore) !== Number(d.actualStore)
        ? ` (scheduled ${d.scheduledStore})`
        : ''
    } · ${d.status === 'ready_for_prod' ? 'Sealed' : 'In progress'}`;
    const abandon = $('vfAbandon');
    if (abandon) abandon.hidden = d.status === 'ready_for_prod';
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
    // Fresh starts land on Before Photos; resumes keep current section
    if (vf.draft.currentStep !== 'before_photos' && vf.draft.steps.includes('before_photos') && vf.draft.status === 'in_progress') {
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
    updateVisitMeta();
    renderAll();
    setVisitShellOpen(true);
    closeSidebarDrawer();
    window.scrollTo(0, 0);
  }

  async function abandon() {
    if (!vf.draft) return null;
    if (vf.draft.status === 'ready_for_prod') {
      toast('Sealed visits cannot be discarded', 'bad', 4000);
      return null;
    }
    const q = photoQueue.snapshot();
    if (q.inFlight > 0) {
      toast('Wait for photo uploads to finish (or fail) before discarding', 'warn', 4500);
      return null;
    }
    const result = await apiCall('/shift-day/visit/abandon', {
      method: 'POST',
      body: JSON.stringify({
        repKey: getRepKey(),
        date: vf.draft.date,
        actualStore: vf.draft.actualStore,
      }),
    });
    photoQueue.pruneDone();
    // clear any remaining queue items for this visit
    for (const item of [...photoQueue.items]) {
      photoQueue.remove(item.id);
    }
    vf.draft = null;
    close();
    toast('Visit discarded — not started in PROD', 'ok', 4000);
    return result;
  }

  $('vfFinish')?.addEventListener('click', () => finish());
  $('vfBackToSchedule')?.addEventListener('click', close);
  $('vfClose')?.addEventListener('click', close);
  $('vfSidebarToggle')?.addEventListener('click', toggleSidebarDrawer);

  return {
    open,
    close,
    abandon,
    refreshDraft,
    goToSection,
    getDraft: () => vf.draft,
  };
}
