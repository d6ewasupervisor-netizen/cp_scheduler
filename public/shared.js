// shared.js — common utilities for rep.html and index.html (admin)
// No page-specific rendering lives here.

const API = '/api/central-pet';
const AUTH_API = '/api/auth';

export const WORK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

export const REP_AVAILABILITY = {
  AVAILABLE: 'available',
  NOT_AVAILABLE: 'not_available',
};

export function normalizeRepAvailability(value) {
  return value === REP_AVAILABILITY.NOT_AVAILABLE
    ? REP_AVAILABILITY.NOT_AVAILABLE
    : REP_AVAILABILITY.AVAILABLE;
}

/**
 * Normalize SAS PROD visitStatus (keep in sync with src/lib/shift-run-status.js).
 * @param {string|null|undefined} visitStatus
 */
export function normalizeProdVisitStatus(visitStatus) {
  const raw = String(visitStatus || '')
    .toLowerCase()
    .trim()
    .replace(/_/g, '-');
  if (!raw) return { key: 'unknown', label: 'Status unknown' };
  if (raw === 'completed' || raw === 'complete') {
    return { key: 'completed', label: 'Completed' };
  }
  if (raw === 'in-progress' || raw === 'in progress' || raw === 'active') {
    return { key: 'in_progress', label: 'In progress' };
  }
  if (raw === 'not started' || raw === 'not-started' || raw === 'scheduled') {
    return { key: 'not_started', label: 'Not started' };
  }
  if (raw === 'deleted') return { key: 'deleted', label: 'Deleted' };
  return { key: 'other', label: String(visitStatus) };
}

/**
 * Human-facing run status for calendar / dashboard (reps + admin).
 * Priority: PROD completed → PROD in progress → sealed (Already ran) →
 * draft in progress → PROD not started → unknown.
 * Keep in sync with src/lib/shift-run-status.js.
 */
export function shiftRunStatus({ visitStatus = null, draftStatus = null } = {}) {
  const prod = normalizeProdVisitStatus(visitStatus);
  if (prod.key === 'completed') {
    return {
      key: 'completed',
      label: 'Completed',
      source: 'prod',
      title: 'Shift completed in SAS PROD — already ran',
    };
  }
  if (prod.key === 'in_progress') {
    return {
      key: 'in_progress',
      label: 'In progress',
      source: 'prod',
      title: 'Shift in progress in SAS PROD — you can still finish photos, times, and seal in the app',
    };
  }
  if (draftStatus === 'ready_for_prod') {
    return {
      key: 'already_ran',
      label: 'Already ran',
      source: 'draft',
      title: 'Visit sealed in the app — already ran locally; PROD may still be open',
    };
  }
  if (draftStatus === 'in_progress') {
    return {
      key: 'in_progress',
      label: 'In progress',
      source: 'draft',
      title: 'Visit draft open in the app',
    };
  }
  if (prod.key === 'not_started') {
    return {
      key: 'not_started',
      label: 'Not started',
      source: 'prod',
      title: 'Not started in SAS PROD',
    };
  }
  if (prod.key === 'deleted') {
    return {
      key: 'deleted',
      label: 'Deleted',
      source: 'prod',
      title: 'Visit deleted in SAS PROD',
    };
  }
  if (prod.key === 'other') {
    return {
      key: 'other',
      label: prod.label,
      source: 'prod',
      title: `PROD status: ${prod.label}`,
    };
  }
  return {
    key: 'unknown',
    label: 'Status unknown',
    source: null,
    title: 'Resync from PROD to refresh shift status',
  };
}

/** Badge HTML for shift run status (shared class prefix: run-status / dash-run). */
export function shiftRunStatusBadgeHtml(status, { className = 'sd-badge' } = {}) {
  if (!status) return '';
  const cls = `${className} run-${status.key}`;
  const title = status.title ? ` title="${String(status.title).replace(/"/g, '&quot;')}"` : '';
  return `<span class="${cls}"${title}>${status.label}</span>`;
}

/** Set or clear rep availability on a placement (clears when available). */
export function applyRepAvailability(placement, value) {
  if (normalizeRepAvailability(value) === REP_AVAILABILITY.NOT_AVAILABLE) {
    placement.repAvailability = REP_AVAILABILITY.NOT_AVAILABLE;
  } else {
    delete placement.repAvailability;
  }
}

export function isCoverageNeeded(p) {
  return normalizeRepAvailability(p?.repAvailability) === REP_AVAILABILITY.NOT_AVAILABLE;
}

export function coverageNeededCount(placements) {
  return (placements || []).filter(isCoverageNeeded).length;
}

export function d8UnassignedCount(rep, placements) {
  return rep?.isD8Pool ? (placements || []).filter((p) => !p.proposedAssignee).length : 0;
}

/** Stop card tap/drag from swallowing native <select> interaction (mobile). */
export function stopSelectBubble(el) {
  for (const evt of ['mousedown', 'click', 'touchstart']) {
    el.addEventListener(evt, (e) => e.stopPropagation());
  }
}

export function chitFlagLabel(p, rep, { admin = false, hideD8Lead = false } = {}) {
  if (!p._valid) return admin ? 'Conflict' : 'Wrong day';
  if (isCoverageNeeded(p)) return 'Needs coverage';
  if (rep?.isD8Pool) {
    if (p.proposedAssignee) return `Lead: ${p.proposedAssignee}`;
    if (hideD8Lead) return '';
    return admin ? 'Unassigned' : 'Pick a lead';
  }
  return '';
}

export const isMobileLayout = () =>
  window.matchMedia('(max-width: 760px)').matches;

/* ---------- API ---------- */

/**
 * @param {string} path
 * @param {RequestInit & { busy?: boolean|string, busyForce?: boolean }} [opts]
 *   busy: true | label string — show buffering overlay for this call
 *   busyForce: open overlay immediately (long PROD ops)
 */
export async function api(path, opts = {}) {
  const { busy, busyForce, ...fetchOpts } = opts;
  const begin = typeof window !== 'undefined' ? window.cpBeginBusy : null;
  const end = typeof window !== 'undefined' ? window.cpEndBusy : null;
  const useBusy = busy === true || typeof busy === 'string';
  if (useBusy && begin) {
    begin(typeof busy === 'string' ? busy : 'Buffering…', { force: !!busyForce });
  }
  try {
    const res = await window.cpAuthFetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) },
      ...fetchOpts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } finally {
    if (useBusy && end) end();
  }
}

export async function loadMe() {
  const res = await window.cpAuthFetch(`${AUTH_API}/me`);
  if (!res.ok) throw new Error('Could not load account');
  return res.json();
}

export function signOut() {
  window.cpSignOut();
}

/* ---------- Placement helpers ---------- */

export function repKeyOf(rep) {
  return rep?.repKey || rep?.name;
}

export function slotKey(p) {
  return `${p.storeNum}:${p.visitIndex ?? 0}`;
}

export function findSlot(slots, p) {
  return slots.find(
    (s) => s.storeNum === p.storeNum && (s.visitIndex ?? 0) === (p.visitIndex ?? 0)
  );
}

export function placementsByDay(placements) {
  const map = Object.fromEntries(WORK_DAYS.map((d) => [d, []]));
  for (const p of placements) {
    if (map[p.dayOfWeek]) map[p.dayOfWeek].push(p);
  }
  return map;
}

export function taskLine(slot) {
  if (!slot) return '';
  if ((slot.visitIndex ?? 0) > 0 && !slot.pickDay && !slot.deliveryDay) {
    return `Follow-up · default ${slot.anchorServiceDay}`;
  }
  return `Default ${slot.anchorServiceDay}`;
}

/** Prior visit at the same store — delivery day for work-load follow-ups. */
export function priorVisitDeliveryDay(slots, slot) {
  if (!slot || !slots?.length) return null;
  const idx = slot.visitIndex ?? 0;
  if (idx === 0) return slot.deliveryDay || null;
  const prev = slots.find(
    (s) => s.storeNum === slot.storeNum && (s.visitIndex ?? 0) === idx - 1
  );
  return prev?.deliveryDay || null;
}

export function isWorkLoadVisit(slot) {
  if (!slot || slot.pickDay || slot.deliveryDay) return false;
  const action = (slot.action || '').toUpperCase();
  return action.includes('WORK LOAD') || (slot.visitIndex ?? 0) > 0;
}

export function isWriteOrderVisit(slot) {
  if (!slot?.pickDay) return false;
  const action = (slot.action || '').toUpperCase();
  return action.includes('WRITE ORDER') || action.includes('WORK LOAD/WRITE ORDER');
}

/** Card subtitle: pick day for write-order visits, delivery day for work-load visits. */
export function orderTimingLine(slot, slots) {
  if (!slot) return '';
  if (isWriteOrderVisit(slot)) {
    return `Order picks ${slot.pickDay}`;
  }
  if (isWorkLoadVisit(slot)) {
    const delivered = priorVisitDeliveryDay(slots, slot);
    if (delivered) return `Order delivered ${delivered}`;
  }
  return taskLine(slot);
}

/* ---------- Dates ---------- */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayFromDate(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T12:00:00`).getDay()];
}

export function dateForDay(weekStart, dayName) {
  const start = new Date(`${weekStart}T12:00:00`);
  const target = DAY_NAMES.indexOf(dayName);
  let delta = target - start.getDay();
  if (delta < 0) delta += 7;
  const d = new Date(start);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function shortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ---------- Validation ---------- */

export async function validatePlacements(repKey, weekStart, placements) {
  const { results, warnings, allValid } = await api('/schedule/validate', {
    method: 'POST',
    body: JSON.stringify({ repKey, weekStart, placements }),
  });
  for (const p of placements) {
    const r = results.find((x) => slotKey(x) === slotKey(p));
    p._valid = r?.valid ?? false;
    p._message = r?.message;
  }
  return { warnings: warnings || [], allValid };
}

/* ---------- Toasts (replaces alert/confirm popups) ---------- */

let toastHost = null;

function ensureToastHost() {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

export function toast(message, kind = 'info', ms = 3200) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// Beacon (non-module) and other scripts call window.cpToast
if (typeof window !== 'undefined') {
  window.cpToast = toast;
}

/* Two-tap confirm: first tap arms the button, second tap within 4s fires. */
export function armButton(btn, armedLabel, onConfirm) {
  const original = btn.textContent;
  btn.addEventListener('click', () => {
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.textContent = original;
      btn.classList.remove('armed');
      onConfirm();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = armedLabel;
    btn.classList.add('armed');
    setTimeout(() => {
      if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = original;
        btn.classList.remove('armed');
      }
    }, 4000);
  });
}

/* ---------- Save-state indicator ---------- */

export function setSaveState(el, stateName) {
  // stateName: 'saved' | 'unsaved' | 'saving'
  el.dataset.state = stateName;
  el.textContent =
    stateName === 'saved' ? 'Saved' : stateName === 'saving' ? 'Saving…' : 'Unsaved changes';
}
