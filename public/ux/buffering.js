/**
 * Global buffering overlay — shows the cat asset when the UI is unusable.
 * Reference-counted so nested ops don't dismiss early.
 * Debounces short flashes (~280ms) unless force: true.
 */

const DEBOUNCE_MS = 280;
const ASSET = '/assets/bufferingcat.gif';

let depth = 0;
let showTimer = null;
let overlayEl = null;
let labelEl = null;
let imgEl = null;

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.id = 'cpBuffering';
  overlayEl.className = 'cp-buffering';
  overlayEl.hidden = true;
  overlayEl.setAttribute('role', 'status');
  overlayEl.setAttribute('aria-live', 'assertive');
  overlayEl.setAttribute('aria-busy', 'false');
  overlayEl.innerHTML = `
    <div class="cp-buffering-card">
      <img class="cp-buffering-img" src="${ASSET}" alt="" width="120" height="120" decoding="async" />
      <p class="cp-buffering-label">Buffering…</p>
    </div>`;
  labelEl = overlayEl.querySelector('.cp-buffering-label');
  imgEl = overlayEl.querySelector('.cp-buffering-img');
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function paintOpen(label) {
  const el = ensureOverlay();
  if (labelEl) labelEl.textContent = label || 'Buffering…';
  el.hidden = false;
  el.setAttribute('aria-busy', 'true');
  document.documentElement.classList.add('cp-busy');
}

function paintClose() {
  if (!overlayEl) return;
  overlayEl.hidden = true;
  overlayEl.setAttribute('aria-busy', 'false');
  document.documentElement.classList.remove('cp-busy');
}

/**
 * @param {string} [label]
 * @param {{ force?: boolean }} [opts] force=true opens immediately (long PROD ops)
 */
export function beginBusy(label = 'Buffering…', opts = {}) {
  depth += 1;
  ensureOverlay();
  if (labelEl && label) labelEl.textContent = label;
  if (opts.force) {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    paintOpen(label);
    return;
  }
  if (depth === 1 && !showTimer) {
    showTimer = setTimeout(() => {
      showTimer = null;
      if (depth > 0) paintOpen(labelEl?.textContent || label);
    }, DEBOUNCE_MS);
  }
}

export function endBusy() {
  depth = Math.max(0, depth - 1);
  if (depth > 0) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  paintClose();
}

export function isBusy() {
  return depth > 0;
}

export function setBusyLabel(label) {
  ensureOverlay();
  if (labelEl) labelEl.textContent = label || 'Buffering…';
}

/**
 * Run an async fn under the buffering overlay.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} [label]
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<T>}
 */
export async function withBusy(fn, label = 'Buffering…', opts = {}) {
  beginBusy(label, opts);
  try {
    return await fn();
  } finally {
    endBusy();
  }
}

/** Busy-aware fetch for long API calls (force open for known-slow routes). */
export async function busyFetch(input, init = {}, busyOpts = {}) {
  const label = busyOpts.label || 'Buffering…';
  const force = !!busyOpts.force;
  beginBusy(label, { force });
  try {
    const fetchFn = typeof window !== 'undefined' && window.cpAuthFetch
      ? window.cpAuthFetch.bind(window)
      : fetch;
    return await fetchFn(input, init);
  } finally {
    endBusy();
  }
}

// Non-module callers (sas-beacon, admin inline)
if (typeof window !== 'undefined') {
  window.cpBeginBusy = beginBusy;
  window.cpEndBusy = endBusy;
  window.cpWithBusy = withBusy;
}
