/**
 * Global buffering overlay — shows the cat asset when the UI is unusable.
 * Reference-counted so nested ops don't dismiss early.
 * Debounces short flashes (~280ms) unless force: true.
 * Once shown, stays up at least MIN_VISIBLE_MS (fun cat flash even on cache hits).
 * Night → bufferingcat.gif · Light → buffering_light.gif
 */

const DEBOUNCE_MS = 280;
const MIN_VISIBLE_MS = 480;
const ASSET_DARK = '/assets/bufferingcat.gif';
const ASSET_LIGHT = '/assets/buffering_light.gif';

let depth = 0;
let showTimer = null;
let hideTimer = null;
let overlayEl = null;
let labelEl = null;
let imgEl = null;
let shownAt = 0;

function resolvedTheme() {
  return document.documentElement?.dataset?.theme === 'light' ? 'light' : 'dark';
}

export function bufferingAssetForTheme(theme = resolvedTheme()) {
  return theme === 'light' ? ASSET_LIGHT : ASSET_DARK;
}

function syncAssetSrc() {
  if (!imgEl) return;
  const next = bufferingAssetForTheme();
  if (imgEl.getAttribute('src') !== next) imgEl.setAttribute('src', next);
}

function ensureOverlay() {
  if (overlayEl) {
    syncAssetSrc();
    return overlayEl;
  }
  overlayEl = document.createElement('div');
  overlayEl.id = 'cpBuffering';
  overlayEl.className = 'cp-buffering';
  overlayEl.hidden = true;
  overlayEl.setAttribute('role', 'status');
  overlayEl.setAttribute('aria-live', 'assertive');
  overlayEl.setAttribute('aria-busy', 'false');
  overlayEl.innerHTML = `
    <div class="cp-buffering-card">
      <img class="cp-buffering-img" src="${bufferingAssetForTheme()}" alt="" width="120" height="120" decoding="async" />
      <p class="cp-buffering-label">Buffering…</p>
    </div>`;
  labelEl = overlayEl.querySelector('.cp-buffering-label');
  imgEl = overlayEl.querySelector('.cp-buffering-img');
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function paintOpen(label) {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const el = ensureOverlay();
  syncAssetSrc();
  if (labelEl) labelEl.textContent = label || 'Buffering…';
  const wasHidden = el.hidden;
  el.hidden = false;
  el.setAttribute('aria-busy', 'true');
  document.documentElement.classList.add('cp-busy');
  if (wasHidden) shownAt = Date.now();
}

function paintCloseNow() {
  if (!overlayEl) return;
  overlayEl.hidden = true;
  overlayEl.setAttribute('aria-busy', 'false');
  document.documentElement.classList.remove('cp-busy');
  shownAt = 0;
}

function paintClose() {
  if (!overlayEl || overlayEl.hidden) {
    paintCloseNow();
    return;
  }
  const elapsed = shownAt ? Date.now() - shownAt : MIN_VISIBLE_MS;
  const remain = Math.max(0, MIN_VISIBLE_MS - elapsed);
  if (remain <= 0) {
    paintCloseNow();
    return;
  }
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (depth === 0) paintCloseNow();
  }, remain);
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
  if (depth === 1 && !showTimer && overlayEl?.hidden !== false) {
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
    // Never opened — no min flash needed
    return;
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

export async function busyFetch(input, init = {}, busyOpts = {}) {
  const label = busyOpts.label || 'Buffering…';
  const force = !!busyOpts.force;
  beginBusy(label, { force });
  try {
    const fetchFn =
      typeof window !== 'undefined' && window.cpAuthFetch
        ? window.cpAuthFetch.bind(window)
        : fetch;
    return await fetchFn(input, init);
  } finally {
    endBusy();
  }
}

if (typeof window !== 'undefined') {
  window.cpBeginBusy = beginBusy;
  window.cpEndBusy = endBusy;
  window.cpWithBusy = withBusy;
  window.addEventListener('cp-theme-change', () => {
    syncAssetSrc();
  });
}
