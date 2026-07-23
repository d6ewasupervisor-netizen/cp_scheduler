// visit-flow-ui.js — mobile visit flow (Shift Day surface).
// STILL READ-ONLY vs prod: every call here hits /shift-day/visit/* which only
// touches the local JSON draft store — no SAS writes.

import { toast } from '/shared.js';
import { createPhotoUploadQueue } from '/photo-upload-queue.js';
import { beginBusy, endBusy, withBusy } from '/ux/buffering.js';
import { confirmLeaveVisit, setNavGuardHooks, installBeforeUnload } from '/ux/nav-guard.js';
import {
  putPendingPhoto,
  markPhotoDone,
  markPhotoFailed,
  listPendingPhotos,
  putDraftPatch,
  listDraftPatches,
  deleteDraftPatch,
} from '/ux/offline-store.js';

const REP_SURVEY_IDS = new Set(['q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11']);

const LEGACY_STEP_REDIRECT = {
  before_photos: 'visit',
  survey: 'visit',
  after_photos: 'visit',
  time: 'visit',
  load_check: 'visit',
  write_order_checklist: 'visit',
  category_photos: 'visit',
  shift_log: 'visit',
  review: 'visit',
};

/** Inline category photos on survey answers (must match visit-flow.js). */
const SURVEY_INLINE_PHOTOS = {
  q3: { categoryId: 'cp-serviced-section', label: 'Photo of stocked section' },
  q5: { categoryId: 'clipstrips', label: 'Photo of clip strips' },
  q7: { categoryId: 'cat-litter-pan-liners', label: 'Photo of cat litter top shelf' },
  q9: { categoryId: 'butcher-block-rack', label: 'Photo of Butcher Block rack' },
};

function surveyAnswerNeedsCategoryPhoto(questionId, answer) {
  if (answer == null || answer === '') return false;
  if (questionId === 'q3') return answer !== 'Did not stock';
  if (questionId === 'q5') return String(answer).toLowerCase() === 'yes';
  if (questionId === 'q7') return answer === 'Yes';
  if (questionId === 'q9') return String(answer).toLowerCase() === 'yes';
  return false;
}

const STEP_HINTS = {
  visit: 'Work top to bottom — start time, before photos, questions (with photos as needed), after photos, then confirm stop time and mileage.',
  before_photos:
    'Photograph the Pet Supplies aisle when you arrive. Two 4ft sections per photo. Open the camera once and take every before shot.',
  survey: 'Answer these the same way you would in SAS. When a question needs a photo, take it right below that answer.',
  after_photos: 'Photograph the finished Pet Supplies aisle when you are done. Two 4ft sections per photo.',
  time: 'Set your stop time and calculate mileage to finish.',
};

const STEP_LABELS = {
  visit: 'Visit',
  before_photos: 'Before photos',
  load_check: 'Load',
  write_order_checklist: 'Order Checklist',
  category_photos: 'Category Photos',
  survey: 'Questions',
  after_photos: 'After photos',
  time: 'Confirm time',
  shift_log: 'Outcome & Notes',
  review: 'Review & Finish',
};

const API = '/api/central-pet';

/**
 * Live camera zoom — HARDWARE ONLY below 1×. A digital "0.5×" cannot see wider
 * than the lens; it just shrinks the picture, so it was removed. Real wide
 * comes from opening the phone's actual ultrawide lens (auto-picked by probe).
 */
const LIVE_CAMERA_ZOOM_MAX_DIGITAL = 4;
const LENS_PROBE_CACHE_KEY = 'vfLensProbe_v2';

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

const STATUS_LABELS = {
  empty: 'Empty',
  in_progress: 'In progress',
  complete: 'Complete',
  needs_attention: 'Needs attention',
};

/** PROD field-app travel-type labels (dropdown / table headers). */
const TRAVEL_TYPE_LABELS = {
  'home-to-store': 'Home To Store',
  'store-to-store': 'Store To Store',
  'store-to-home': 'Store To Home',
  'same-store': 'Same Store',
  unresolved: 'Mileage not found',
};

function formatTravelEndpoint(ep) {
  if (ep == null || ep === '') return '—';
  if (String(ep).toLowerCase() === 'home') return 'Home';
  return `Store ${ep}`;
}

/** Rep-facing mileage line — mirrors PROD travel types, never says "leg". */
function formatMileageTravel(travel) {
  if (!travel) return 'Not calculated yet.';
  const type = TRAVEL_TYPE_LABELS[travel.source] || 'Travel';
  const miles = travel.miles == null ? 'miles not found' : `${travel.miles} mi`;
  const route = `${formatTravelEndpoint(travel.from)} → ${formatTravelEndpoint(travel.to)}`;
  const base = `${type} · ${miles} · ${route}`;
  return travel.warning ? `${base} — ${travel.warning}` : base;
}

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

/** Sections of the single scroll page — sidebar links + status dots. */
const VISIT_SECTIONS = [
  { id: 'shift-start', label: 'Start of shift' },
  { id: 'before-photos', label: 'Before photos' },
  { id: 'survey-section', label: 'Questions' },
  { id: 'after-photos', label: 'After photos' },
  { id: 'time-section', label: 'Confirm time & mileage' },
];

/** Map an unmet-requirement anchor to its page section id. */
function sectionForAnchor(anchor) {
  if (!anchor) return 'time-section';
  if (anchor === 'shift-start') return 'shift-start';
  if (anchor === 'before-photos') return 'before-photos';
  if (anchor.startsWith('survey-')) return 'survey-section';
  if (anchor.startsWith('after-photos')) return 'after-photos';
  return 'time-section'; // time-stop, time-mileage, time
}

export function createVisitFlowController({ $, getRepKey, onDraftChanged, isAdmin = () => false }) {
  const vf = {
    shift: null,
    draft: null,
    scopeChecklist: null,
    survey: null,
    categoryTargets: null,
    afterCoach: null,
    outcomeOptions: null,
    storeNotes: [],
    pendingAnchor: null,
    /** @type {null | { key: string, input: HTMLInputElement | null }} */
    burst: null,
    photoEditMode: false,
    /** @type {null | { kind: string, stream: MediaStream, count: number, extra: object }} */
    liveCam: null,
    /** path -> object URL for authenticated photo previews */
    previewCache: new Map(),
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
    onEnqueued: (item) => {
      if (!vf.draft) return;
      putPendingPhoto({
        id: item.id,
        repKey: getRepKey(),
        date: vf.draft.date,
        actualStore: vf.draft.actualStore,
        extra: item.extra,
        file: item.file,
      }).catch(() => {
        /* offline store optional on private mode */
      });
    },
    onUploaded: (item) => {
      markPhotoDone(item.id).catch(() => {});
    },
    onFailed: (item, err) => {
      markPhotoFailed(item.id, err?.message || String(err)).catch(() => {});
    },
    onChange: (snap) => {
      updatePhotoQueueSaveState(snap);
      // Soft refresh: keep capture control free; only re-render photo UI when useful
      if (vf.draft) {
        // Prefer light thumb refresh when still on a photo-heavy section
        const step = vf.draft.currentStep;
        if (step === 'visit' || step === 'before_photos' || step === 'after_photos') {
          // When an upload finishes, merge draft from latest successful result
          const lastDone = [...photoQueue.items].reverse().find((i) => i.status === 'done' && i.result);
          if (lastDone?.result) {
            vf.draft = lastDone.result;
            onDraftChanged?.(vf.draft);
            photoQueue.pruneDone();
          }
          // Avoid full re-render thrash while burst/live camera is open
          if (!vf.burst && !vf.liveCam) renderAll();
          else {
            updateBurstStatus();
            updateLiveCameraChrome();
            updateFinishButton();
          }
        }
      }
      if (snap.failed > 0 && snap.inFlight === 0) {
        toast(`${snap.failed} photo(s) failed to upload — tap Retry on the red thumb`, 'bad', 5000);
      }
    },
  });

  setNavGuardHooks({
    hasBlockingWork: () => photoQueue.snapshot().inFlight > 0,
    isVisitOpen: () => !!(vf.draft && workspaceEl() && !workspaceEl().hidden),
  });
  installBeforeUnload();

  async function ensureStaticData() {
    if (!vf.scopeChecklist) vf.scopeChecklist = await apiCall('/shift-day/visit-flow/scope-checklist');
    if (!vf.survey) vf.survey = await apiCall('/shift-day/visit-flow/survey');
    if (!vf.categoryTargets) vf.categoryTargets = await apiCall('/shift-day/visit-flow/category-targets');
    if (!vf.afterCoach) {
      try {
        vf.afterCoach = await apiCall('/shift-day/visit-flow/after-coach');
      } catch {
        vf.afterCoach = { coach: vf.categoryTargets || [], classifyEnabled: false };
      }
    }
    if (!vf.outcomeOptions) vf.outcomeOptions = await apiCall('/shift-day/visit-flow/outcome-options');
  }

  function setSaveState(s, label) {
    const el = $('vfSaveState');
    if (!el) return;
    el.dataset.state = s;
    el.textContent =
      label ||
      (s === 'saving' ? 'Saving…' : s === 'error' ? 'Upload error' : 'Saved');
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

  /**
   * Offline-durable text mutation (shift-log / stage note / next-visit note).
   * On network failure the patch is persisted to IndexedDB and replayed on
   * reconnect — the rep keeps working and never loses input. `body` MUST carry
   * repKey/date/actualStore so the patch can be keyed and flushed later.
   */
  async function saveTextMutation(path, body, { after } = {}) {
    setSaveState('saving');
    try {
      vf.draft = await apiCall(path, { method: 'POST', body: JSON.stringify(body) });
      updatePhotoQueueSaveState();
      onDraftChanged?.(vf.draft);
      after?.();
      return vf.draft;
    } catch (err) {
      try {
        await putDraftPatch({
          repKey: body.repKey,
          date: body.date,
          actualStore: body.actualStore,
          path,
          body,
        });
        toast('Saved locally — will sync when back online', 'warn', 3500);
        setSaveState('saved', 'Saved locally');
      } catch {
        toast(`Autosave failed: ${err.message}`, 'bad', 4500);
      }
      return null;
    }
  }

  /** Replay any queued text patches for this visit, oldest first, on reconnect. */
  async function flushPendingPatches() {
    if (!vf.draft) return;
    let patches;
    try {
      patches = await listDraftPatches({
        repKey: getRepKey(),
        date: vf.draft.date,
        actualStore: vf.draft.actualStore,
      });
    } catch {
      return;
    }
    if (!patches?.length) return;
    patches.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let applied = 0;
    for (const p of patches) {
      try {
        vf.draft = await apiCall(p.path, { method: 'POST', body: JSON.stringify(p.body) });
        await deleteDraftPatch(p.id);
        applied += 1;
      } catch {
        break; // stop on first failure; leave the rest queued
      }
    }
    if (applied) {
      onDraftChanged?.(vf.draft);
      renderAll();
      toast(`Synced ${applied} saved note(s)`, 'ok', 3000);
    }
  }

  /* ---------- Photo capture (shared by before/after/category/load/checklist) ---------- */

  function burstKey(extra) {
    const e = extra || {};
    return `${e.target || ''}|${e.categoryId || ''}|${e.itemId || ''}|${e.status || ''}`;
  }

  function stopBurst() {
    vf.burst = null;
    const bar = document.getElementById('vfBurstBar');
    if (bar) bar.hidden = true;
  }

  function startBurst(key, inputEl) {
    vf.burst = { key, input: inputEl };
    let bar = document.getElementById('vfBurstBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'vfBurstBar';
      bar.className = 'vf-burst-bar';
      bar.innerHTML = `
        <span class="vf-burst-status" id="vfBurstStatus">Capturing…</span>
        <button type="button" class="primary" id="vfBurstDone">Done capturing</button>`;
      const main = document.querySelector('.vf-main') || workspaceEl();
      if (main) main.appendChild(bar);
      bar.querySelector('#vfBurstDone').addEventListener('click', async () => {
        const wasAfter = vf.burst?.key?.includes('after') || vf.draft?.currentStep === 'after_photos';
        stopBurst();
        renderAll();
        toast('Photo capture finished', 'ok', 2000);
        if (wasAfter) await classifyAfterPhotosQuiet();
      });
    }
    bar.hidden = false;
    updateBurstStatus();
  }

  function updateBurstStatus() {
    const el = document.getElementById('vfBurstStatus');
    if (!el || !vf.draft) return;
    const q = photoQueue.snapshot();
    el.textContent = `Capturing… ${q.inFlight ? `${q.inFlight} uploading` : 'ready for next'} · tap Done when finished`;
  }

  function reOpenCamera(inputEl) {
    // Best-effort: iOS may block programmatic re-open without a fresh gesture.
    try {
      requestAnimationFrame(() => {
        try {
          inputEl.click();
        } catch {
          toast('Tap Capture again for the next photo', 'info', 2500);
        }
      });
    } catch {
      toast('Tap Capture again for the next photo', 'info', 2500);
    }
  }

  /* ---------- Live camera (stays open for full before/after bursts) ---------- */

  function stopLiveCamera({ rerender = true } = {}) {
    const cam = vf.liveCam;
    if (cam?.stream) {
      try {
        cam.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
    }
    vf.liveCam = null;
    const overlay = document.getElementById('vfLiveCamera');
    if (overlay) overlay.hidden = true;
    const video = document.getElementById('vfLiveVideo');
    if (video) {
      try {
        video.srcObject = null;
        video.style.transform = '';
        video.style.transformOrigin = '';
      } catch {
        /* ignore */
      }
    }
    if (rerender) renderAll();
  }

  function ensureLiveCameraDom() {
    let overlay = document.getElementById('vfLiveCamera');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'vfLiveCamera';
    overlay.className = 'vf-live-camera';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="vf-live-camera-inner">
        <div class="vf-live-video-stage">
          <video id="vfLiveVideo" class="vf-live-video" playsinline autoplay muted></video>
        </div>
        <canvas id="vfLiveCanvas" class="vf-live-canvas" hidden></canvas>
        <div class="vf-live-top">
          <span id="vfLiveTitle" class="vf-live-title">Camera</span>
          <span id="vfLiveCount" class="vf-live-count">0 captured</span>
          <span class="vf-live-tools">
            <button type="button" class="vf-live-tool" id="vfLiveTorch" aria-label="Flashlight" hidden>🔦</button>
            <button type="button" class="vf-live-tool" id="vfLiveSwitch" aria-label="Switch camera" hidden>⟲</button>
          </span>
        </div>
        <button type="button" class="vf-live-photo-toggle" id="vfLivePhotoToggle" aria-expanded="false">Photos (0)</button>
        <div class="vf-live-photo-drawer" id="vfLivePhotoDrawer">
          <div class="vf-live-photo-drawer-title">Captured</div>
          <div class="vf-live-thumbs" id="vfLiveThumbs"></div>
        </div>
        <div class="vf-live-zoom" id="vfLiveZoomBar">
          <button type="button" class="vf-live-zoom-btn" id="vfLiveZoomOut" aria-label="Zoom out">−</button>
          <input type="range" class="vf-live-zoom-range" id="vfLiveZoomRange" min="1" max="4" step="0.05" value="1">
          <span id="vfLiveZoomLabel" class="vf-live-zoom-label" aria-live="polite">0.5×</span>
          <button type="button" class="vf-live-zoom-btn" id="vfLiveZoomIn" aria-label="Zoom in">+</button>
        </div>
        <div class="vf-live-controls">
          <button type="button" class="subtle" id="vfLiveClose">Close</button>
          <button type="button" class="primary vf-live-shutter" id="vfLiveShutter" aria-label="Take photo">●</button>
          <button type="button" class="primary" id="vfLiveDone">Done</button>
        </div>
        <p class="vf-live-hint" id="vfLiveHint">Tap the shutter for each photo, then Done. Turn your phone sideways if needed.</p>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#vfLiveClose').addEventListener('click', () => {
      stopLiveCamera({ rerender: true });
      toast('Camera closed', 'ok', 1800);
    });
    overlay.querySelector('#vfLiveDone').addEventListener('click', async () => {
      const n = vf.liveCam?.count || 0;
      const wasAfter = vf.liveCam?.kind === 'after';
      stopLiveCamera({ rerender: true });
      toast(n ? `Saved ${n} photo(s)` : 'Camera closed', 'ok', 2200);
      if (wasAfter) await classifyAfterPhotosQuiet();
    });
    overlay.querySelector('#vfLiveShutter').addEventListener('click', () => captureLiveFrame());
    overlay.querySelector('#vfLiveSwitch')?.addEventListener('click', () => switchLiveCamera());
    overlay.querySelector('#vfLiveTorch')?.addEventListener('click', () => toggleLiveTorch());
    overlay.querySelector('#vfLivePhotoToggle')?.addEventListener('click', () => toggleLivePhotoDrawer());
    overlay.querySelector('#vfLiveZoomRange')?.addEventListener('input', (e) =>
      applyLiveZoom(Number(e.target.value))
    );
    overlay.querySelector('#vfLiveZoomOut')?.addEventListener('click', () => nudgeLiveZoom(-0.1));
    overlay.querySelector('#vfLiveZoomIn')?.addEventListener('click', () => nudgeLiveZoom(0.1));
    return overlay;
  }

  function formatLiveZoomLabel(zoom) {
    const z = Number(zoom);
    if (!Number.isFinite(z)) return '1×';
    const text = z >= 1 ? z.toFixed(z >= 10 ? 0 : 1) : z.toFixed(1);
    return `${text.replace(/\.0$/, '')}×`;
  }

  function isRearLabel(label) {
    return /back|rear|environment|trás|arrière|trasera/i.test(String(label || ''));
  }

  function isUltraWideLabel(label) {
    return /ultra\s*wide|ultrawide|0\.5|wide.?angle|grand.?angle|gran angular/i.test(String(label || ''));
  }

  /**
   * Probe every rear lens ONCE (cached): open each briefly at low resolution
   * and read its real zoom capabilities. This is how we find the true
   * ultrawide even when the label is just "camera2 2, facing back".
   */
  async function probeRearLenses() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let videos = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videos = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
    } catch {
      return [];
    }
    // Front cameras are never useful for aisle shots; keep unknown labels (pre-permission).
    const rear = videos.filter((d) => !d.label || isRearLabel(d.label));
    if (!rear.length) return [];

    const cacheKey = rear.map((d) => d.deviceId).sort().join('|');
    try {
      const cached = JSON.parse(localStorage.getItem(LENS_PROBE_CACHE_KEY) || 'null');
      if (cached?.key === cacheKey && Array.isArray(cached.lenses) && cached.lenses.length) {
        return cached.lenses;
      }
    } catch {
      /* re-probe */
    }

    const lenses = [];
    for (const d of rear) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: d.deviceId }, width: { ideal: 320 }, height: { ideal: 240 } },
        });
        const track = stream.getVideoTracks()[0];
        let caps = null;
        try {
          caps = track.getCapabilities?.() || null;
        } catch {
          caps = null;
        }
        const label = track.label || d.label || '';
        lenses.push({
          deviceId: d.deviceId,
          label,
          zoomMin: caps?.zoom?.min ?? null,
          zoomMax: caps?.zoom?.max ?? null,
          torch: !!caps?.torch,
          ultraWideLabel: isUltraWideLabel(label),
        });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // Lens locked / blocked — skip it, keep probing the rest.
      }
    }
    try {
      localStorage.setItem(LENS_PROBE_CACHE_KEY, JSON.stringify({ key: cacheKey, lenses }));
    } catch {
      /* private mode */
    }
    return lenses;
  }

  /**
   * Widest real lens: explicit ultrawide label wins, then any lens whose
   * hardware zoom goes below 1× (logical multi-camera), then the default.
   */
  function pickWidestLens(lenses) {
    if (!lenses?.length) return null;
    const byLabel = lenses.find((l) => l.ultraWideLabel);
    if (byLabel) return byLabel;
    const subOne = lenses
      .filter((l) => l.zoomMin != null && l.zoomMin < 1)
      .sort((a, b) => a.zoomMin - b.zoomMin)[0];
    if (subOne) return subOne;
    return null; // no detectable wide lens — use the default environment camera
  }

  function updateLiveVideoPreview() {
    const cam = vf.liveCam;
    const video = document.getElementById('vfLiveVideo');
    if (!cam || !video) return;
    // Preview always fills the stage. Only digital zoom-IN (no hardware zoom)
    // scales the video up to mimic the crop that capture will apply.
    const digitalZoomIn = !cam.hardwareCapable && cam.zoom > 1.001;
    if (digitalZoomIn) {
      video.style.transformOrigin = 'center center';
      video.style.transform = `scale(${cam.zoom})`;
    } else {
      video.style.transform = '';
      video.style.transformOrigin = '';
    }
  }

  function updateLiveZoomChrome() {
    const cam = vf.liveCam;
    if (!cam) return;
    const range = document.getElementById('vfLiveZoomRange');
    const label = document.getElementById('vfLiveZoomLabel');
    if (range) range.value = String(cam.zoom);
    if (label) label.textContent = formatLiveZoomLabel(cam.zoom);
    updateLiveVideoPreview();
  }

  function toggleLivePhotoDrawer(forceOpen) {
    const cam = vf.liveCam;
    if (!cam) return;
    const drawer = document.getElementById('vfLivePhotoDrawer');
    const toggle = document.getElementById('vfLivePhotoToggle');
    if (!drawer || !toggle) return;
    const open = forceOpen != null ? forceOpen : !cam.photoDrawerOpen;
    cam.photoDrawerOpen = open;
    drawer.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  async function applyLiveZoom(value) {
    const cam = vf.liveCam;
    if (!cam) return;
    const clamped = Math.min(cam.zoomMax, Math.max(cam.zoomMin, value));
    cam.zoom = clamped;
    updateLiveZoomChrome();

    if (!cam.hardwareCapable || !cam.track?.applyConstraints) return;

    const hwTarget = Math.max(cam.hardwareMin, clamped);
    try {
      await cam.track.applyConstraints({ advanced: [{ zoom: hwTarget }] });
    } catch {
      cam.hardwareCapable = false;
      updateLiveVideoPreview();
    }
  }

  function nudgeLiveZoom(delta) {
    const cam = vf.liveCam;
    if (!cam) return;
    applyLiveZoom(cam.zoom + delta);
  }

  function setupLiveCameraZoom() {
    const cam = vf.liveCam;
    if (!cam) return;
    const bar = document.getElementById('vfLiveZoomBar');
    const range = document.getElementById('vfLiveZoomRange');
    if (!bar || !range) return;
    bar.hidden = false;
    range.min = String(cam.zoomMin);
    range.max = String(cam.zoomMax);
    range.step = '0.05';
    updateLiveZoomChrome();
  }

  function updateLiveCameraChrome() {
    const cam = vf.liveCam;
    if (!cam) return;
    const countEl = document.getElementById('vfLiveCount');
    const titleEl = document.getElementById('vfLiveTitle');
    const q = photoQueue.snapshot();
    if (titleEl) {
      titleEl.textContent =
        cam.kind === 'before' ? 'Before photos' : cam.kind === 'after' ? 'After photos' : 'Camera';
    }
    if (countEl) {
      countEl.textContent = `${cam.count} captured${q.inFlight ? ` · ${q.inFlight} uploading` : ''}`;
    }
    const toggle = document.getElementById('vfLivePhotoToggle');
    if (toggle) toggle.textContent = `Photos (${cam.count})`;
  }

  async function captureLiveFrame() {
    const cam = vf.liveCam;
    if (!cam) return;
    const video = document.getElementById('vfLiveVideo');
    const canvas = document.getElementById('vfLiveCanvas');
    if (!video || !canvas) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    if (!w || !h) {
      toast('Camera not ready yet — wait a moment', 'warn', 2500);
      return;
    }
    const z = cam.zoom;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!cam.hardwareCapable && z > 1.001) {
      // Digital zoom-in: crop the center to match the scaled preview.
      const cropW = w / z;
      const cropH = h / z;
      ctx.drawImage(video, (w - cropW) / 2, (h - cropH) / 2, cropW, cropH, 0, 0, w, h);
    } else {
      // Hardware zoom (incl. real 0.5× ultrawide) — the sensor already shows it.
      ctx.drawImage(video, 0, 0, w, h);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) {
      toast('Could not capture frame', 'bad', 3000);
      return;
    }
    const file = new File([blob], `live-${cam.kind}-${Date.now()}.jpg`, { type: 'image/jpeg' });
    try {
      queuePhoto(file, cam.extra);
      cam.count += 1;
      updateLiveCameraChrome();
      // Local thumb strip
      const thumbs = document.getElementById('vfLiveThumbs');
      if (thumbs) {
        const url = URL.createObjectURL(blob);
        const el = document.createElement('div');
        el.className = 'vf-live-thumb';
        el.style.backgroundImage = `url('${url}')`;
        thumbs.prepend(el);
      }
      toggleLivePhotoDrawer(true);
    } catch (err) {
      toast(`Could not queue photo: ${err.message}`, 'bad', 4000);
    }
  }

  /**
   * Start (or restart) the live stream on a specific device.
   * No artificial caps: asks for the sensor's max resolution and exposes the
   * hardware's full zoom range, torch, and every lens the device has.
   */
  async function startLiveStream({ deviceId = null } = {}) {
    const cam = vf.liveCam;
    if (!cam) return;

    // Stop any existing tracks before opening the next lens.
    if (cam.stream) {
      try {
        cam.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
    }

    const videoConstraints = {
      width: { ideal: 4096 },
      height: { ideal: 2160 },
    };
    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    } else {
      videoConstraints.facingMode = { ideal: 'environment' };
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints,
    });
    const track = stream.getVideoTracks()[0];

    let hardwareMin = 1;
    let hardwareMax = LIVE_CAMERA_ZOOM_MAX_DIGITAL;
    let hardwareCapable = false;
    let torchCapable = false;
    try {
      const caps = track.getCapabilities?.();
      if (caps?.zoom) {
        hardwareCapable = true;
        hardwareMin = caps.zoom.min ?? 1;
        hardwareMax = caps.zoom.max ?? LIVE_CAMERA_ZOOM_MAX_DIGITAL;
      }
      torchCapable = !!caps?.torch;
    } catch {
      /* digital preview/capture fallback */
    }

    cam.stream = stream;
    cam.track = track;
    cam.deviceId = track.getSettings?.().deviceId || deviceId || null;
    cam.hardwareMin = hardwareMin;
    cam.hardwareMax = hardwareMax;
    cam.hardwareCapable = hardwareCapable;
    cam.torchCapable = torchCapable;
    cam.torchOn = false;
    // Honest zoom range only: the hardware's own limits, or a digital
    // zoom-IN fallback. Nothing below what the lens can really see.
    if (hardwareCapable) {
      cam.zoomMin = hardwareMin;
      cam.zoomMax = Math.max(hardwareMax, hardwareMin);
    } else {
      cam.zoomMin = 1;
      cam.zoomMax = LIVE_CAMERA_ZOOM_MAX_DIGITAL;
    }
    // Always open at the widest view this lens offers.
    cam.zoom = cam.zoomMin;

    const video = document.getElementById('vfLiveVideo');
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* autoplay policies — still usually works after gesture */
    }

    // Labels only populate after permission — refresh the lens list now.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cam.devices = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
    } catch {
      cam.devices = [];
    }

    const switchBtn = document.getElementById('vfLiveSwitch');
    if (switchBtn) switchBtn.hidden = (cam.devices?.length || 0) < 2;
    const torchBtn = document.getElementById('vfLiveTorch');
    if (torchBtn) {
      torchBtn.hidden = !torchCapable;
      torchBtn.classList.remove('on');
    }

    setupLiveCameraZoom();
    await applyLiveZoom(cam.zoom);
  }

  /** Cycle to the device's next lens/camera — captured photos keep flowing to the same visit. */
  async function switchLiveCamera() {
    const cam = vf.liveCam;
    if (!cam || !(cam.devices?.length > 1)) return;
    const idx = cam.devices.findIndex((d) => d.deviceId === cam.deviceId);
    const next = cam.devices[(idx + 1) % cam.devices.length];
    try {
      await startLiveStream({ deviceId: next.deviceId });
      updateLiveCameraChrome();
      const label = next.label || `Camera ${((idx + 1) % cam.devices.length) + 1}`;
      toast(label, 'ok', 1800);
    } catch (err) {
      toast(`Could not switch camera: ${err.message || err.name}`, 'bad', 3500);
    }
  }

  async function toggleLiveTorch() {
    const cam = vf.liveCam;
    if (!cam?.torchCapable || !cam.track?.applyConstraints) return;
    const on = !cam.torchOn;
    try {
      await cam.track.applyConstraints({ advanced: [{ torch: on }] });
      cam.torchOn = on;
      document.getElementById('vfLiveTorch')?.classList.toggle('on', on);
    } catch {
      toast('Flashlight not available on this lens', 'warn', 2500);
    }
  }

  async function openLiveCamera(kind) {
    if (!vf.draft) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Live camera not supported on this device — use the file capture button', 'warn', 4500);
      return;
    }
    stopBurst();
    stopLiveCamera({ rerender: false });
    const overlay = ensureLiveCameraDom();
    try {
      // Find the phone's REAL widest rear lens (probe once, cached).
      let wideLens = null;
      try {
        wideLens = pickWidestLens(await probeRearLenses());
      } catch {
        wideLens = null;
      }
      vf.liveCam = {
        kind,
        stream: null,
        track: null,
        count: 0,
        extra: { target: kind },
        devices: [],
        deviceId: null,
        zoomMin: 1,
        zoomMax: LIVE_CAMERA_ZOOM_MAX_DIGITAL,
        zoom: null, // set to the lens's widest once capabilities are read
        hardwareMin: 1,
        hardwareMax: LIVE_CAMERA_ZOOM_MAX_DIGITAL,
        hardwareCapable: false,
        torchCapable: false,
        torchOn: false,
        photoDrawerOpen: false,
      };
      try {
        await startLiveStream({ deviceId: wideLens?.deviceId || null });
      } catch {
        // Stale/blocked device id — fall back to the default environment camera.
        await startLiveStream({ deviceId: null });
      }
      if (wideLens && vf.liveCam) {
        toast(`Using widest lens: ${wideLens.label || 'wide camera'}`, 'ok', 2500);
      } else if (vf.liveCam && (vf.liveCam.devices?.length || 0) > 1) {
        toast('Tip: tap ⟲ to try each lens — one may be wider', 'info', 3500);
      }
      const thumbs = document.getElementById('vfLiveThumbs');
      if (thumbs) thumbs.innerHTML = '';
      toggleLivePhotoDrawer(false);
      updateLiveCameraChrome();
      overlay.hidden = false;
    } catch (err) {
      stopLiveCamera({ rerender: false });
      vf.liveCam = null;
      toast(
        `Could not open camera: ${err.message || err.name || 'permission denied'}. Use the file capture button instead.`,
        'bad',
        6000
      );
    }
  }

  /** Authenticated photo preview (Bearer auth can't go on <img src>). */
  async function ensurePhotoPreview(photo) {
    if (!photo?.path || !vf.draft) return null;
    if (vf.previewCache.has(photo.path)) return vf.previewCache.get(photo.path);
    const file = String(photo.path).split(/[/\\]/).pop();
    if (!file) return null;
    const qs = new URLSearchParams({
      repKey: getRepKey(),
      date: vf.draft.date,
      actualStore: String(vf.draft.actualStore),
      file,
    });
    try {
      const res = await window.cpAuthFetch(`${API}/shift-day/visit/photo-file?${qs}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      vf.previewCache.set(photo.path, url);
      return url;
    } catch {
      return null;
    }
  }

  function fillPhotoThumbs(root) {
    if (!root) return;
    root.querySelectorAll('[data-photo-path]').forEach((el) => {
      const p = el.dataset.photoPath;
      if (!p) return;
      ensurePhotoPreview({ path: p }).then((url) => {
        if (!url || !el.isConnected) return;
        el.style.backgroundImage = `url('${url}')`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      });
    });
  }

  function photoThumbHtml(p, i, { showRemove = false, extraClass = '' } = {}) {
    const seq = p.seq ?? i + 1;
    const pathAttr = p.path ? ` data-photo-path="${escapeHtml(p.path)}"` : '';
    return `<div class="vf-photo-thumb vf-photo-ok ${extraClass}" data-seq="${seq}" title="Saved #${seq}"${pathAttr}>
      <span class="vf-photo-badge">#${seq}</span>${
        showRemove
          ? `<button type="button" class="vf-photo-remove" data-seq="${seq}" aria-label="Remove photo">×</button>`
          : ''
      }</div>`;
  }

  function photoCaptureBlock({
    label,
    photos,
    minRequired = 0,
    onCapture,
    onRemove,
    anchorId,
    pending = [],
    extra = {},
    liveKind = null,
  }) {
    const wrap = document.createElement('div');
    wrap.className = 'vf-photo-block';
    if (anchorId) wrap.id = anchorId;
    const uploaded = photos?.length || 0;
    const pendingCount = (pending || []).filter((p) => p.status !== 'failed').length;
    const failedCount = (pending || []).filter((p) => p.status === 'failed').length;
    let countLabel = `${uploaded} saved`;
    if (pendingCount) countLabel += ` · ${pendingCount} sending`;
    if (failedCount) countLabel += ` · ${failedCount} failed`;
    if (minRequired) countLabel += ` (min ${minRequired})`;
    const bKey = burstKey(extra);
    const bursting = vf.burst?.key === bKey;
    const liveOpen = vf.liveCam && liveKind && vf.liveCam.kind === liveKind;

    const showRemove = vf.photoEditMode && onRemove;
    const serverThumbs = (photos || [])
      .map((p, i) => photoThumbHtml(p, i, { showRemove }))
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

    const liveBtn =
      liveKind != null
        ? `<button type="button" class="primary vf-live-open-btn">${
            liveOpen ? 'Camera open…' : 'Open camera (keep open)'
          }</button>`
        : '';

    wrap.innerHTML = `
      <div class="vf-photo-head">
        <strong>${label}</strong>
        <span class="vf-photo-count">${countLabel}</span>
      </div>
      <div class="vf-photo-grid">${serverThumbs}${pendingThumbs}</div>
      <div class="vf-photo-actions">
        ${liveBtn}
        <label class="vf-photo-input ${liveKind ? 'subtle' : 'primary'}">
          ${liveKind ? (bursting ? 'Add one more (file)' : 'Add from files') : bursting ? 'Next photo' : 'Start capturing'}
          <input type="file" accept="image/*" capture="environment" hidden>
        </label>
        ${
          onRemove
            ? `<button type="button" class="subtle vf-photo-edit-toggle">${
                vf.photoEditMode ? 'Done editing' : 'Edit / remove'
              }</button>`
            : ''
        }
      </div>
      <p class="vf-photo-hint overlay-meta">${
        liveKind
          ? 'Open the camera once, take every shot, then tap <strong>Done</strong>. Photos upload in the background.'
          : 'Shots upload in the background. Keep capturing until you tap <strong>Done capturing</strong>.'
      }</p>`;

    wrap.querySelector('.vf-live-open-btn')?.addEventListener('click', () => openLiveCamera(liveKind));

    const input = wrap.querySelector('input[type=file]');
    input.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        onCapture(file);
        // File-input path: keep optional burst re-open for single-shot sections
        // (load/checklist) and as a fallback for before/after.
        if (!liveKind) {
          if (!vf.burst || vf.burst.key !== bKey) startBurst(bKey, input);
          updateBurstStatus();
          reOpenCamera(input);
        } else {
          renderAll();
        }
      } catch (err) {
        toast(`Could not queue photo: ${err.message}`, 'bad', 4000);
      }
    });
    wrap.querySelector('.vf-photo-edit-toggle')?.addEventListener('click', () => {
      vf.photoEditMode = !vf.photoEditMode;
      renderAll();
    });
    if (showRemove) {
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
    fillPhotoThumbs(wrap);
    return wrap;
  }

  /** Queue photo for background upload — returns immediately. */
  function queuePhoto(file, extra) {
    photoQueue.enqueue(file, extra);
    // Instant UI feedback without waiting for network (skip full re-render in burst/live)
    if (vf.burst || vf.liveCam) {
      updateBurstStatus();
      updateLiveCameraChrome();
      updatePhotoQueueSaveState(photoQueue.snapshot());
    } else {
      renderAll();
    }
  }

  async function removePhoto(target, seq, extra = {}) {
    await autosave(() =>
      apiCall('/shift-day/visit/photo/remove', {
        method: 'POST',
        body: JSON.stringify({
          repKey: getRepKey(),
          date: vf.draft.date,
          actualStore: vf.draft.actualStore,
          target,
          seq,
          ...extra,
        }),
      })
    );
    renderAll();
  }

  async function assignCategoryFromAfter(categoryId, afterSeq) {
    await autosave(() =>
      apiCall('/shift-day/visit/photo/assign-category', {
        method: 'POST',
        body: JSON.stringify({
          repKey: getRepKey(),
          date: vf.draft.date,
          actualStore: vf.draft.actualStore,
          categoryId,
          afterSeq,
        }),
      })
    );
    renderAll();
  }

  /** Backend Gemini sort — silent for the rep unless it fails hard. */
  async function classifyAfterPhotosQuiet() {
    if (!vf.draft?.afterPhotos?.length) return;
    // Wait briefly for in-flight after uploads so the classifier sees them
    for (let i = 0; i < 40; i++) {
      const q = photoQueue.snapshot();
      if (q.inFlight === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      const result = await apiCall('/shift-day/visit/photos/classify', {
        method: 'POST',
        body: JSON.stringify({
          repKey: getRepKey(),
          date: vf.draft.date,
          actualStore: vf.draft.actualStore,
        }),
      });
      if (result.draft) {
        vf.draft = result.draft;
        onDraftChanged?.(vf.draft);
        renderSidebar();
        updateFinishButton();
      }
      if (result.classification?.skipped) return;
      if (result.classification?.ok) {
        toast('After photos placed for you', 'ok', 2200);
      }
    } catch (err) {
      // Non-blocking — seal-time classify + unmet list still apply
      console.warn('[classify]', err.message);
    }
  }

  /* ---------- Section renderers ---------- */

  function visitBlock(title, anchorId) {
    const sec = document.createElement('section');
    sec.className = 'vf-visit-block';
    if (anchorId) sec.id = anchorId;
    const head = document.createElement('h2');
    head.className = 'vf-block-head';
    const isSection = VISIT_SECTIONS.some((s) => s.id === anchorId);
    if (isSection) {
      const status = sectionDotStatuses()[anchorId] || 'todo';
      const dot = document.createElement('span');
      dot.className = 'vf-status-dot';
      dot.dataset.section = anchorId;
      dot.dataset.status = status;
      head.appendChild(dot);
    }
    head.appendChild(document.createTextNode(title));
    sec.appendChild(head);
    return sec;
  }

  function appendSurveyInlinePhoto(wrap, q) {
    // Q2 (Central Pet order in store?) — offer a load photo right on the answer.
    if (q.id === 'q2') {
      const ans = vf.draft.survey?.q2;
      if (ans !== 'Yes') return;
      const photo = vf.draft.loadCheck?.photo;
      const extra = { target: 'load', status: 'yes' };
      wrap.appendChild(
        photoCaptureBlock({
          label: 'Photo of the order / load (optional — retaking replaces it)',
          photos: photo ? [photo] : [],
          minRequired: 0,
          anchorId: 'survey-q2-photo',
          pending: photoQueue.pendingFor(extra),
          extra,
          onCapture: (file) => queuePhoto(file, extra),
        })
      );
      return;
    }
    const spec = SURVEY_INLINE_PHOTOS[q.id];
    if (!spec) return;
    const ans = vf.draft.survey?.[q.id];
    if (!surveyAnswerNeedsCategoryPhoto(q.id, ans)) return;
    const photos = vf.draft.categoryPhotos?.[spec.categoryId] || [];
    const extra = { target: 'category', categoryId: spec.categoryId };
    wrap.appendChild(
      photoCaptureBlock({
        label: spec.label,
        photos,
        minRequired: 1,
        anchorId: `survey-${q.id}-photo`,
        pending: photoQueue.pendingFor(extra),
        extra,
        onCapture: (file) => queuePhoto(file, extra),
        onRemove: (seq) => removePhoto('category', seq, { categoryId: spec.categoryId }),
      })
    );
  }

  function renderShiftStartBlock(body) {
    const d = vf.draft;
    const sec = visitBlock('Start of shift', 'shift-start');
    const day = d.date
      ? new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        })
      : '';
    const meta = document.createElement('p');
    meta.className = 'overlay-meta';
    meta.textContent = day ? `${day} · Store ${d.actualStore}` : `Store ${d.actualStore}`;
    sec.appendChild(meta);

    if (d.scheduledStore != null && Number(d.scheduledStore) !== Number(d.actualStore)) {
      const b = document.createElement('div');
      b.className = 'vf-store-redirect';
      b.innerHTML = `Running as store <strong>${d.actualStore}</strong> — scheduled under <strong>${d.scheduledStore}</strong>`;
      sec.appendChild(b);
    }

    if (vf.storeNotes?.length) {
      const box = document.createElement('div');
      box.className = 'vf-carryforward';
      const head = document.createElement('div');
      head.className = 'vf-carryforward-head';
      head.textContent = 'Notes from a previous visit to this store';
      box.appendChild(head);
      for (const n of vf.storeNotes) {
        const rowEl = document.createElement('div');
        rowEl.className = 'vf-carryforward-note';
        const txt = document.createElement('span');
        txt.className = 'vf-carryforward-text';
        txt.textContent = n.note;
        rowEl.appendChild(txt);
        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'subtle';
        done.textContent = 'Done';
        done.addEventListener('click', async () => {
          try {
            await apiCall(`/shift-day/store-notes/${n.id}/resolve`, {
              method: 'POST',
              body: JSON.stringify({}),
            });
            vf.storeNotes = vf.storeNotes.filter((x) => String(x.id) !== String(n.id));
            renderSectionBody();
          } catch (e) {
            toast(`Could not resolve: ${e.message}`, 'bad');
          }
        });
        rowEl.appendChild(done);
        box.appendChild(rowEl);
      }
      sec.appendChild(box);
    }

    const card = document.createElement('div');
    card.className = 'vf-time-card vf-time-card-compact';
    card.innerHTML = `
      <label class="field">When did you start this visit?
        <input type="datetime-local" id="vfStartTop" value="${toLocalInput(d.visitStart.actual)}">
      </label>
      <button type="button" id="vfNowStartTop" class="subtle">Set start to now</button>`;
    sec.appendChild(card);
    body.appendChild(sec);

    async function saveStartTop(iso) {
      await autosave(() =>
        apiCall('/shift-day/visit/time', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: d.date,
            actualStore: d.actualStore,
            startActual: iso,
          }),
        })
      );
      updateFinishButton();
    }
    card.querySelector('#vfStartTop')?.addEventListener('change', (e) =>
      saveStartTop(new Date(e.target.value).toISOString())
    );
    card.querySelector('#vfNowStartTop')?.addEventListener('click', () => {
      const now = new Date();
      const input = card.querySelector('#vfStartTop');
      if (input) input.value = toLocalInput(now.toISOString());
      saveStartTop(now.toISOString());
    });
  }

  function renderBeforePhotosBlock(body) {
    const sec = visitBlock('Before photos', 'before-photos');
    const p = document.createElement('p');
    p.className = 'overlay-meta';
    p.textContent =
      'Take BEFORE photos of the Pet Supplies aisle when you arrive. Two 4ft sections per photo.';
    sec.appendChild(p);
    const guide = document.createElement('p');
    guide.className = 'vf-step-guide';
    guide.textContent = STEP_HINTS.before_photos;
    sec.appendChild(guide);
    const extra = { target: 'before' };
    sec.appendChild(
      photoCaptureBlock({
        label: 'Before photos',
        photos: vf.draft.beforePhotos,
        minRequired: 1,
        pending: photoQueue.pendingFor(extra),
        extra,
        liveKind: 'before',
        onCapture: (file) => queuePhoto(file, extra),
        onRemove: (seq) => removePhoto('before', seq),
      })
    );
    body.appendChild(sec);
  }

  /** Q11 (additional feedback) must always identify the store, e.g. "This is for store 53." */
  function storeFeedbackLine() {
    const store = vf.draft?.actualStore;
    if (store == null || store === '') return '';
    return `This is for store ${store}.`;
  }

  /** Prepend the store line to feedback text when it's missing (idempotent). */
  function withStoreFeedbackLine(text) {
    const line = storeFeedbackLine();
    if (!line) return String(text || '');
    const current = String(text || '');
    const store = String(vf.draft.actualStore).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`this is for store\\s*#?\\s*${store}\\b`, 'i').test(current)) return current;
    return current.trim() ? `${line} ${current}` : line;
  }

  /** Ensure the saved Q11 answer carries the store line — runs on every visit open. */
  async function ensureQ11StoreLine() {
    if (!vf.draft) return;
    const current = vf.draft.survey?.q11 || '';
    const wanted = withStoreFeedbackLine(current);
    if (wanted === current) return;
    try {
      await autosave(() =>
        apiCall('/shift-day/visit/survey', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            answers: { q11: wanted },
          }),
        })
      );
    } catch {
      /* offline — blur guard will re-apply when the rep touches the field */
    }
  }

  function renderSurveyBlock(body) {
    const sec = visitBlock('Questions', 'survey-section');
    const helper = document.createElement('p');
    helper.className = 'overlay-meta';
    helper.textContent = STEP_HINTS.survey;
    sec.appendChild(helper);

    const visibility = surveyVisibility();
    const answers = vf.draft.survey || {};
    for (const q of vf.survey.questions.slice().sort((a, b) => a.order - b.order)) {
      if (!REP_SURVEY_IDS.has(q.id)) continue;
      if (!visibility[q.id]) continue;
      const wrap = document.createElement('div');
      wrap.className = 'vf-survey-q';
      wrap.id = `survey-${q.id}`;
      const label = document.createElement('div');
      label.className = 'vf-survey-label';
      label.textContent = q.text;
      wrap.appendChild(label);

      if (q.type === 'yesno' || q.type === 'single-select') {
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
        textarea.value = q.id === 'q11' ? withStoreFeedbackLine(answers[q.id]) : answers[q.id] || '';
        textarea.addEventListener('blur', () => {
          // Q11 always keeps its "This is for store N." line, even after edits.
          if (q.id === 'q11') textarea.value = withStoreFeedbackLine(textarea.value);
          return autosave(() =>
            apiCall('/shift-day/visit/survey', {
              method: 'POST',
              body: JSON.stringify({
                repKey: getRepKey(),
                date: vf.draft.date,
                actualStore: vf.draft.actualStore,
                answers: { [q.id]: textarea.value },
              }),
            })
          ).then(() => {
            updateFinishButton();
          });
        });
        wrap.appendChild(textarea);
      }
      appendSurveyInlinePhoto(wrap, q);
      sec.appendChild(wrap);
    }
    body.appendChild(sec);
  }

  function renderAfterPhotosBlock(body) {
    const sec = visitBlock('After photos', 'after-photos');
    const p = document.createElement('p');
    p.className = 'overlay-meta';
    p.textContent =
      'Take AFTER photos of the Pet Supplies aisle when you are finished. Two 4ft sections per photo.';
    sec.appendChild(p);
    const guide = document.createElement('p');
    guide.className = 'vf-step-guide';
    guide.textContent = STEP_HINTS.after_photos;
    sec.appendChild(guide);

    const selectedGroups = vf.draft.optionalFixtures || {};
    const optionalGroups = vf.afterCoach?.optionalGroups || [
      {
        id: 'endcaps-wings',
        label: 'End caps / wings',
        tip: 'Only if you serviced endcaps or wing panels this visit.',
        categoryIds: ['endcaps', 'wing-panels'],
      },
    ];

    for (const group of optionalGroups) {
      const opt = document.createElement('label');
      opt.className = 'vf-optional-fixture';
      opt.innerHTML = `
        <input type="checkbox" data-optional-group="${escapeHtml(group.id)}" ${
          selectedGroups[group.id] ? 'checked' : ''
        } />
        <span>
          <strong>Include ${escapeHtml(group.label)}</strong>
          <span class="overlay-meta"> — optional. ${escapeHtml(group.tip || '')}</span>
        </span>`;
      sec.appendChild(opt);
      opt.querySelector('input')?.addEventListener('change', async (e) => {
        const on = !!e.target.checked;
        try {
          await autosave(() =>
            apiCall('/shift-day/visit/optional-fixtures', {
              method: 'POST',
              body: JSON.stringify({
                repKey: getRepKey(),
                date: vf.draft.date,
                actualStore: vf.draft.actualStore,
                groupId: group.id,
                selected: on,
              }),
            })
          );
          renderAll();
        } catch {
          e.target.checked = !on;
        }
      });
    }

    if (selectedGroups['endcaps-wings']) {
      for (const catId of ['endcaps', 'wing-panels']) {
        const cat = (vf.categoryTargets || []).find((c) => c.id === catId);
        const photos = vf.draft.categoryPhotos?.[catId] || [];
        const extra = { target: 'category', categoryId: catId };
        sec.appendChild(
          photoCaptureBlock({
            label: cat?.label || catId,
            photos,
            minRequired: 1,
            anchorId: `after-photos-${catId}`,
            pending: photoQueue.pendingFor(extra),
            extra,
            onCapture: (file) => queuePhoto(file, extra),
            onRemove: (seq) => removePhoto('category', seq, { categoryId: catId }),
          })
        );
      }
    }

    const extra = { target: 'after' };
    sec.appendChild(
      photoCaptureBlock({
        label: 'After photos',
        photos: vf.draft.afterPhotos,
        minRequired: 1,
        pending: photoQueue.pendingFor(extra),
        extra,
        liveKind: 'after',
        onCapture: (file) => queuePhoto(file, extra),
        onRemove: (seq) => removePhoto('after', seq),
      })
    );
    body.appendChild(sec);
  }

  function renderTimeUnmet(body) {
    const unmet = vf.draft.unmetRequirements || [];
    if (!unmet.length) return;
    const box = document.createElement('div');
    box.className = 'vf-time-unmet';
    box.innerHTML = `<h3>Still need</h3><ul>${unmet
      .map(
        (u) =>
          `<li><button type="button" class="vf-deep-link" data-section="${escapeHtml(
            u.section
          )}" data-anchor="${escapeHtml(u.anchor || '')}">${escapeHtml(u.message)}</button></li>`
      )
      .join('')}</ul>`;
    box.querySelectorAll('.vf-deep-link').forEach((btn) => {
      btn.addEventListener('click', () => goToSection(btn.dataset.section, btn.dataset.anchor || null));
    });
    body.appendChild(box);
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
    const amp = document.createElement('div');
    amp.className = 'vf-amp-callout';
    amp.innerHTML = `
      <div class="vf-amp-title">Write the order in Amp by Movista</div>
      <ol class="vf-amp-steps">
        <li>Open the <strong>Amp by Movista</strong> app on this phone.</li>
        <li>Scan <strong>product tags on the item</strong> (not shelf tags) for items that aren't missing.</li>
        <li>Write the order in Amp, then return here and check off each scope item below.</li>
      </ol>
      <p class="overlay-meta" style="margin:0">Tip: stay on this step until the order is submitted in Amp — checklist is your proof of work in our app.</p>`;
    body.appendChild(amp);

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
            extra: clExtra,
            onCapture: (file) => queuePhoto(file, clExtra),
          })
        );
      }
    }
  }

  function renderCategoryPhotos() {
    goToSection('visit', 'after-photos');
  }

  function surveyVisibility() {
    const answers = vf.draft.survey || {};
    return Object.fromEntries(vf.survey.questions.map((q) => [q.id, evalCondition(q.visibleIf, answers)]));
  }

  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderTimeBlock(body) {
    const sec = visitBlock('Confirm time & mileage', 'time-section');
    const guide = document.createElement('p');
    guide.className = 'vf-step-guide';
    guide.textContent = STEP_HINTS.time;
    sec.appendChild(guide);

    const card = document.createElement('div');
    card.className = 'vf-time-card';
    card.innerHTML = `
      <label class="field" id="time-stop">Stop time
        <input type="datetime-local" id="vfStop" value="${toLocalInput(vf.draft.visitStop.actual)}">
      </label>
      <div class="vf-btn-row" style="margin:.35rem 0 .6rem">
        <button type="button" id="vfNowStop" class="subtle">Set stop to now</button>
      </div>
      <label class="field" style="flex-direction:row;align-items:center;gap:.5rem">
        <input type="checkbox" id="vfLastStop" ${vf.draft.isLastStopOfDay ? 'checked' : ''}> Last stop of the day
      </label>
      <button type="button" id="vfCalcMileage" class="primary">Calculate Mileage</button>
      <div id="time-mileage" class="overlay-meta" style="margin-top:.5rem"></div>
      <label class="field">Note if mileage looks wrong
        <textarea id="vfMileageNote" rows="2">${vf.draft.mileage?.repNote || ''}</textarea>
      </label>`;
    sec.appendChild(card);
    body.appendChild(sec);

    renderTimeUnmet(sec);

    const renderMileage = () => {
      const el = $('time-mileage');
      if (el) el.textContent = formatMileageTravel(vf.draft.mileage?.leg);
    };
    renderMileage();

    async function saveStop(iso) {
      await autosave(() =>
        apiCall('/shift-day/visit/time', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            stopActual: iso,
          }),
        })
      );
      updateFinishButton();
    }

    card.querySelector('#vfStop')?.addEventListener('change', (e) =>
      saveStop(new Date(e.target.value).toISOString())
    );
    card.querySelector('#vfNowStop')?.addEventListener('click', () => {
      const now = new Date();
      const input = card.querySelector('#vfStop');
      if (input) input.value = toLocalInput(now.toISOString());
      saveStop(now.toISOString());
    });
    card.querySelector('#vfLastStop')?.addEventListener('change', (e) =>
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
      ).then(updateFinishButton)
    );
    card.querySelector('#vfCalcMileage')?.addEventListener('click', () =>
      autosave(() =>
        apiCall('/shift-day/visit/mileage', {
          method: 'POST',
          body: JSON.stringify({ repKey: getRepKey(), date: vf.draft.date, actualStore: vf.draft.actualStore }),
        })
      ).then(() => {
        renderMileage();
        updateFinishButton();
        sec.querySelector('.vf-time-unmet')?.remove();
        renderTimeUnmet(sec);
      })
    );
    card.querySelector('#vfMileageNote')?.addEventListener('blur', (e) =>
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

  function renderVisitPage() {
    const body = $('vfBody');
    body.innerHTML = '';
    const intro = document.createElement('p');
    intro.className = 'vf-visit-intro overlay-meta';
    intro.textContent = STEP_HINTS.visit;
    body.appendChild(intro);
    renderShiftStartBlock(body);
    renderBeforePhotosBlock(body);
    renderSurveyBlock(body);
    renderAfterPhotosBlock(body);
    renderTimeBlock(body);
  }

  function renderLoadCheck() {
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
        <div><dt>Mileage</dt><dd>${d.mileage?.leg ? formatMileageTravel(d.mileage.leg) : '—'}</dd></div>
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

  /** Per-section done/todo from the draft's unmet list (green = complete). */
  function sectionDotStatuses() {
    const unmet = vf.draft?.unmetRequirements || [];
    const open = new Set(unmet.map((u) => sectionForAnchor(u.anchor)));
    return Object.fromEntries(VISIT_SECTIONS.map((s) => [s.id, open.has(s.id) ? 'todo' : 'done']));
  }

  function statusDotHtml(status) {
    const label = status === 'done' ? 'Complete' : 'Not done yet';
    return `<span class="vf-status-dot" data-status="${status}" title="${label}" aria-label="${label}"></span>`;
  }

  /** Refresh every status dot in place (sidebar + block headers) — cheap. */
  function updateSectionDots() {
    if (!vf.draft) return;
    const statuses = sectionDotStatuses();
    for (const s of VISIT_SECTIONS) {
      document
        .querySelectorAll(`.vf-status-dot[data-section="${s.id}"]`)
        .forEach((el) => el.setAttribute('data-status', statuses[s.id]));
    }
  }

  function renderSidebarSections() {
    const host = $('vfSidebarSections');
    if (!host || !vf.draft) return;
    const statuses = sectionDotStatuses();
    host.innerHTML = VISIT_SECTIONS.map(
      (s) => `
      <button type="button" class="vf-nav-item vf-section-link" data-anchor="${s.id}">
        <span class="vf-nav-label"><span class="vf-status-dot" data-section="${s.id}" data-status="${statuses[s.id]}"></span>${s.label}</span>
      </button>`
    ).join('');
    host.querySelectorAll('.vf-section-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeSidebarDrawer();
        goToSection('visit', btn.dataset.anchor);
      });
    });
  }

  function updateShareButton() {
    const btn = $('vfShareVisit');
    if (!btn) return;
    const show = !!vf.draft && isAdmin();
    btn.hidden = !show;
    if (!show || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      if (!vf.draft) return;
      btn.disabled = true;
      try {
        const data = await apiCall('/shift-day/visit/share', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
          }),
        });
        const share = data.share;
        let copied = false;
        try {
          await navigator.clipboard.writeText(share.url);
          copied = true;
        } catch {
          /* clipboard blocked — show the link instead */
        }
        const hours = Math.max(1, Math.round((new Date(share.expiresAt) - Date.now()) / 3600000));
        toast(
          copied
            ? `Share link copied — anyone with it can view photos for ~${hours}h (${share.viewCount} view(s) so far)`
            : `Share link ready (~${hours}h): ${share.url}`,
          'ok',
          copied ? 6000 : 12000
        );
        if (navigator.share && !copied) {
          try {
            await navigator.share({ title: `Store ${vf.draft.actualStore} visit photos`, url: share.url });
          } catch {
            /* user cancelled */
          }
        }
      } catch (err) {
        toast(`Could not create share link: ${err.message}`, 'bad', 5000);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderSidebar() {
    updateFinishButton();
    updateSidebarMeta();
    renderSidebarSections();
    updateShareButton();
  }

  function updateSidebarMeta() {
    const meta = $('vfSidebarMeta');
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
    const status = d.status === 'ready_for_prod' ? 'Finished' : 'In progress';
    const scheduled =
      d.scheduledStore != null && Number(d.scheduledStore) !== Number(d.actualStore)
        ? `<div class="vf-sidebar-status">Scheduled as store ${d.scheduledStore}</div>`
        : '';
    meta.innerHTML = `<div class="vf-sidebar-date">${escapeHtml(day)}</div><div class="vf-sidebar-status">${escapeHtml(
      status
    )}</div>${scheduled}`;
    const abandon = $('vfAbandon');
    if (abandon) abandon.hidden = d.status === 'ready_for_prod';
    updateOnlineBadge();
  }

  function updateOnlineBadge() {
    const meta = $('vfSidebarMeta');
    if (!meta || !vf.draft) return;
    let el = document.getElementById('vfOnlineBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vfOnlineBadge';
      el.className = 'vf-sidebar-status vf-online-badge';
      meta.appendChild(el);
    }
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const q = photoQueue.snapshot();
    if (!online) {
      el.dataset.state = 'offline';
      el.textContent = 'Offline — photos saved on this phone';
    } else if (q.inFlight > 0) {
      el.dataset.state = 'syncing';
      el.textContent = `Syncing ${q.inFlight} photo(s)…`;
    } else {
      el.dataset.state = 'online';
      el.textContent = 'Online';
    }
  }

  function updateFinishButton() {
    updateSectionDots();
    const btn = $('vfFinish');
    if (!btn || !vf.draft) return;
    btn.hidden = false;
    const q = photoQueue.snapshot();
    const uploadsBlocking = q.inFlight > 0 || q.failed > 0;
    const can = !!vf.draft.canSeal && !uploadsBlocking;
    btn.disabled = !can;
    if (q.inFlight > 0) {
      btn.title = `Wait for ${q.inFlight} photo upload(s) to finish`;
    } else if (q.failed > 0) {
      btn.title = `${q.failed} photo upload(s) failed — tap Retry before finishing`;
    } else if (can) {
      btn.title = 'Finish this visit';
    } else {
      btn.title = 'Complete the items listed above before finishing';
    }
  }

  /* ---------- Mandatory Outcome & Notes step ---------- */

  function renderShiftLog() {
    const body = $('vfBody');
    const d = vf.draft;
    const opts = vf.outcomeOptions?.options || [];
    const selected = new Set((d.shiftLog?.outcomes || []).map((o) => o.optionId));

    body.innerHTML = `<p class="vf-step-guide" id="shift-log">${STEP_HINTS.shift_log}</p>`;

    const currentOutcomes = () =>
      opts.filter((o) => selected.has(o.id)).map((o) => ({ optionId: o.id, kind: o.kind, label: o.label }));

    let customEl;
    const saveOutcomes = () =>
      saveTextMutation(
        '/shift-day/visit/shift-log',
        {
          repKey: getRepKey(),
          date: d.date,
          actualStore: d.actualStore,
          outcomes: currentOutcomes(),
          custom: customEl ? customEl.value : d.shiftLog?.custom || '',
        },
        { after: () => { renderSidebar(); updateFinishButton(); } }
      );

    const groups = [
      { kind: 'outcome', title: 'What you did' },
      { kind: 'variance', title: 'Variances / issues (if any)' },
    ];
    for (const g of groups) {
      const groupOpts = opts.filter((o) => o.kind === g.kind);
      if (!groupOpts.length) continue;
      const head = document.createElement('div');
      head.className = 'vf-survey-label';
      head.textContent = g.title;
      body.appendChild(head);
      const row = document.createElement('div');
      row.className = 'vf-btn-row vf-wrap';
      for (const o of groupOpts) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = o.label;
        if (selected.has(o.id)) btn.className = 'primary';
        btn.addEventListener('click', () => {
          if (selected.has(o.id)) selected.delete(o.id);
          else selected.add(o.id);
          btn.className = selected.has(o.id) ? 'primary' : '';
          if (customWrap) customWrap.dataset.required = selected.has('other') ? '1' : '';
          saveOutcomes();
        });
        row.appendChild(btn);
      }
      body.appendChild(row);
    }

    const customWrap = document.createElement('label');
    customWrap.className = 'field';
    customWrap.id = 'shift-log-custom';
    customWrap.dataset.required = selected.has('other') ? '1' : '';
    customWrap.innerHTML =
      'Anything else about this shift? <span class="vf-help">(required if you picked “Other”)</span>';
    customEl = document.createElement('textarea');
    customEl.rows = 2;
    customEl.value = d.shiftLog?.custom || '';
    customEl.addEventListener('blur', saveOutcomes);
    customWrap.appendChild(customEl);
    body.appendChild(customWrap);

    const nvWrap = document.createElement('label');
    nvWrap.className = 'field';
    nvWrap.innerHTML =
      'Note for the next visit to this store <span class="vf-help">— passed to whoever services this store next, including you</span>';
    const nvEl = document.createElement('textarea');
    nvEl.rows = 2;
    nvEl.placeholder = 'e.g. Extra pads on top stock · stashed water dishes behind leashes & collars · order more X next time';
    nvEl.value = d.nextVisitNote || '';
    nvEl.addEventListener('blur', () =>
      saveTextMutation('/shift-day/visit/next-visit-note', {
        repKey: getRepKey(),
        date: d.date,
        actualStore: d.actualStore,
        text: nvEl.value,
      })
    );
    nvWrap.appendChild(nvEl);
    body.appendChild(nvWrap);
  }

  /* ---------- Universal per-stage note (optional, never gates) ---------- */

  function renderStageNote(step) {
    const body = $('vfBody');
    const existing = vf.draft.stageNotes?.[step];
    const wrap = document.createElement('label');
    wrap.className = 'field vf-stage-note';
    wrap.innerHTML =
      'Note / issue for this step <span class="vf-help">(optional — documented on the shift for later recall)</span>';
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Anything worth documenting at this step…';
    ta.value = existing?.text || '';
    ta.addEventListener('blur', () =>
      saveTextMutation(
        '/shift-day/visit/note',
        {
          repKey: getRepKey(),
          date: vf.draft.date,
          actualStore: vf.draft.actualStore,
          step,
          text: ta.value,
        },
        { after: renderSidebar }
      )
    );
    wrap.appendChild(ta);
    body.appendChild(wrap);
  }

  function renderSectionBody() {
    const d = vf.draft;
    $('vfStoreTitle').textContent = `Store ${d.actualStore}`;

    if (LEGACY_STEP_REDIRECT[d.currentStep] && d.currentStep !== 'visit') {
      goToSection('visit');
      return;
    }

    renderVisitPage();

    if (vf.pendingAnchor) {
      const anchor = vf.pendingAnchor;
      vf.pendingAnchor = null;
      requestAnimationFrame(() => {
        const el = document.getElementById(anchor);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.classList.add('vf-anchor-flash');
          setTimeout(() => el.classList.remove('vf-anchor-flash'), 1600);
        }
      });
    }
  }

  function renderAll() {
    renderSidebar();
    renderSectionBody();
    updateSidebarMeta();
  }

  async function restoreOfflinePhotos() {
    if (!vf.draft) return;
    try {
      const pending = await listPendingPhotos({
        repKey: getRepKey(),
        date: vf.draft.date,
        actualStore: vf.draft.actualStore,
      });
      if (!pending.length) return;
      beginBusy(`Restoring ${pending.length} saved photo(s)…`, { force: true });
      try {
        for (const row of pending) {
          if (photoQueue.items.some((i) => i.id === row.id)) continue;
          const blob = row.file;
          if (!blob) continue;
          const file =
            blob instanceof File
              ? blob
              : new File([blob], row.fileName || 'photo.jpg', { type: row.fileType || 'image/jpeg' });
          photoQueue.enqueue(file, row.extra || {}, { id: row.id });
        }
        toast(`Restored ${pending.length} photo(s) from local backup`, 'ok', 3500);
      } finally {
        endBusy();
      }
    } catch {
      /* IDB unavailable */
    }
  }

  async function goToSection(sectionId, anchor = null) {
    if (!vf.draft) return;
    if (sectionId && LEGACY_STEP_REDIRECT[sectionId]) sectionId = LEGACY_STEP_REDIRECT[sectionId];
    vf.pendingAnchor = anchor || null;
    if (sectionId && sectionId !== vf.draft.currentStep && vf.draft.steps.includes(sectionId)) {
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
    }
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
    // Sort afters into category buckets before the local canSeal gate
    await classifyAfterPhotosQuiet();
    if (!vf.draft.canSeal) {
      toast('Finish blocked — see what is still needed below', 'bad', 4000);
      renderSectionBody();
      return;
    }
    try {
      await withBusy(
        () =>
          autosave(() =>
            apiCall('/shift-day/visit/finish', {
              method: 'POST',
              body: JSON.stringify({
                repKey: getRepKey(),
                date: vf.draft.date,
                actualStore: vf.draft.actualStore,
              }),
            })
          ),
        'Finishing visit…',
        { force: true }
      );
      toast('Visit finished', 'ok');
      stopBurst();
      close();
    } catch (err) {
      if (err.code === 'SEAL_BLOCKED' && err.unmet) {
        vf.draft.unmetRequirements = err.unmet;
        vf.draft.canSeal = false;
        toast('Still need a few things before you can finish', 'bad', 4500);
        renderSectionBody();
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
    stopBurst();
    stopLiveCamera({ rerender: false });
    setVisitShellOpen(false);
    closeSidebarDrawer();
    vf.shift = null;
  }

  async function requestClose() {
    const ok = await confirmLeaveVisit();
    if (!ok) return false;
    close();
    return true;
  }

  async function open(shift) {
    vf.shift = shift;
    stopBurst();
    stopLiveCamera({ rerender: false });
    vf.photoEditMode = false;
    await withBusy(async () => {
      await ensureStaticData();
      vf.draft = await apiCall('/shift-day/visit/start', {
        method: 'POST',
        body: JSON.stringify({
          repKey: getRepKey(),
          weekStart: shift.weekStart,
          shiftId: shift.id,
        }),
      });
      if (vf.draft.currentStep !== 'visit' && vf.draft.steps.includes('visit')) {
        vf.draft = await apiCall('/shift-day/visit/step', {
          method: 'POST',
          body: JSON.stringify({
            repKey: getRepKey(),
            date: vf.draft.date,
            actualStore: vf.draft.actualStore,
            step: 'visit',
          }),
        });
      }
    }, 'Opening visit…', { force: true });
    // Every shift's additional-feedback answer identifies its store up front.
    await ensureQ11StoreLine();
    onDraftChanged?.(vf.draft);
    updateSidebarMeta();
    setVisitShellOpen(true);
    closeSidebarDrawer();
    window.scrollTo(0, 0);
    // Carry-forward notes left by the last servicer of this store (best-effort).
    vf.storeNotes = [];
    try {
      const sn = await apiCall(`/shift-day/store-notes?store=${vf.draft.actualStore}`);
      vf.storeNotes = sn.notes || [];
    } catch {
      /* offline / no DB — banner just stays empty */
    }
    renderAll();
    await restoreOfflinePhotos();
    await flushPendingPatches();
    // Assist mode chrome when admin previews another rep
    const assist = document.getElementById('vfAssistBanner');
    if (assist) {
      const q = new URLSearchParams(location.search);
      if (q.get('preview') === '1' && q.get('rep')) {
        assist.hidden = false;
        assist.textContent = `Assisting ${q.get('rep')} — edits save to their local draft`;
      } else {
        assist.hidden = true;
      }
    }
  }

  async function abandon() {
    if (!vf.draft) return null;
    if (vf.draft.status === 'ready_for_prod') {
      toast('Sealed visits cannot be discarded', 'bad', 4000);
      return null;
    }
    stopLiveCamera({ rerender: false });
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
  $('vfBackToSchedule')?.addEventListener('click', () => requestClose());
  $('vfClose')?.addEventListener('click', () => requestClose());
  $('vfSidebarToggle')?.addEventListener('click', toggleSidebarDrawer);

  // Tap anywhere off the open sidebar drawer → collapse it.
  document.addEventListener('pointerdown', (e) => {
    const ws = workspaceEl();
    if (!ws || ws.hidden || !ws.classList.contains('vf-sidebar-open')) return;
    const sidebar = $('vfSidebar');
    const toggle = $('vfSidebarToggle');
    if (sidebar?.contains(e.target) || toggle?.contains(e.target)) return;
    closeSidebarDrawer();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      updateOnlineBadge();
      if (vf.draft) {
        restoreOfflinePhotos();
        flushPendingPatches();
      }
    });
    window.addEventListener('offline', () => updateOnlineBadge());
  }

  return {
    open,
    close,
    requestClose,
    abandon,
    refreshDraft,
    goToSection,
    getDraft: () => vf.draft,
    photoQueueSnapshot: () => photoQueue.snapshot(),
  };
}
