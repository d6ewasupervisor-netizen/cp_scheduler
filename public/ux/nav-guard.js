/**
 * Leave / refresh protection with "don't ask again" preferences.
 * Always blocks when photos are in-flight or offline queue has pending work.
 */

const PREF_LEAVE = 'cp_guard_leave_visit';
const PREF_REFRESH = 'cp_guard_refresh';

/** @type {() => boolean} */
let hasBlockingWork = () => false;
/** @type {() => boolean} */
let isVisitOpen = () => false;

let modalEl = null;
let resolvePending = null;

export function setNavGuardHooks({ hasBlockingWork: blockFn, isVisitOpen: openFn } = {}) {
  if (typeof blockFn === 'function') hasBlockingWork = blockFn;
  if (typeof openFn === 'function') isVisitOpen = openFn;
}

function getPref(key) {
  return localStorage.getItem(key) === 'allow' ? 'allow' : 'ask';
}

export function setLeavePref(mode) {
  localStorage.setItem(PREF_LEAVE, mode === 'allow' ? 'allow' : 'ask');
}

export function setRefreshPref(mode) {
  localStorage.setItem(PREF_REFRESH, mode === 'allow' ? 'allow' : 'ask');
}

function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement('div');
  modalEl.id = 'cpNavGuard';
  modalEl.className = 'vf-modal';
  modalEl.hidden = true;
  modalEl.innerHTML = `
    <div class="vf-modal-backdrop" data-ng-cancel></div>
    <div class="vf-modal-card" role="dialog" aria-modal="true" aria-labelledby="cpNavGuardTitle">
      <h2 id="cpNavGuardTitle">Leave this visit?</h2>
      <p class="overlay-meta" id="cpNavGuardBody">Your progress is saved on the server when online. Leaving now will close the visit workspace.</p>
      <label class="cp-guard-check field" style="flex-direction:row;align-items:center;gap:.5rem;margin:.75rem 0">
        <input type="checkbox" id="cpNavGuardDontAsk" />
        <span>Don't ask again for leaving the visit</span>
      </label>
      <div class="vf-modal-actions">
        <button type="button" class="subtle" data-ng-cancel>Stay</button>
        <button type="button" class="primary" data-ng-leave>Leave</button>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  modalEl.querySelector('[data-ng-leave]').addEventListener('click', () => finish(true));
  modalEl.querySelectorAll('[data-ng-cancel]').forEach((el) => {
    el.addEventListener('click', () => finish(false));
  });
  return modalEl;
}

function finish(leave) {
  if (!modalEl) return;
  const dont = modalEl.querySelector('#cpNavGuardDontAsk');
  if (leave && dont?.checked) setLeavePref('allow');
  modalEl.hidden = true;
  document.body.classList.remove('overlay-open');
  const r = resolvePending;
  resolvePending = null;
  if (r) r(leave);
}

/**
 * Ask before leaving the visit workspace (in-app navigation).
 * @param {{ title?: string, body?: string }} [opts]
 * @returns {Promise<boolean>} true if user chose to leave
 */
export function confirmLeaveVisit(opts = {}) {
  if (hasBlockingWork()) {
    return showModal({
      title: 'Uploads still in progress',
      body: 'Photos are still uploading or waiting offline. Stay until the save indicator says Saved, or you may lose captures.',
      force: true,
      leaveLabel: 'Leave anyway',
    });
  }
  if (!isVisitOpen()) return Promise.resolve(true);
  if (getPref(PREF_LEAVE) === 'allow') return Promise.resolve(true);
  return showModal({
    title: opts.title || 'Leave this visit?',
    body:
      opts.body ||
      'Your draft is saved when online. You can resume from the shift card. Leave the workspace?',
    force: false,
  });
}

function showModal({ title, body, force, leaveLabel }) {
  const el = ensureModal();
  el.querySelector('#cpNavGuardTitle').textContent = title;
  el.querySelector('#cpNavGuardBody').textContent = body;
  const check = el.querySelector('#cpNavGuardDontAsk');
  const checkWrap = el.querySelector('.cp-guard-check');
  if (force) {
    checkWrap.hidden = true;
    check.checked = false;
  } else {
    checkWrap.hidden = false;
    check.checked = false;
  }
  const leaveBtn = el.querySelector('[data-ng-leave]');
  leaveBtn.textContent = leaveLabel || 'Leave';
  el.hidden = false;
  document.body.classList.add('overlay-open');
  return new Promise((resolve) => {
    resolvePending = resolve;
  });
}

let beforeUnloadInstalled = false;

/** Wire browser refresh/close protection (once). */
export function installBeforeUnload() {
  if (beforeUnloadInstalled) return;
  beforeUnloadInstalled = true;
  window.addEventListener('beforeunload', (e) => {
    if (hasBlockingWork()) {
      e.preventDefault();
      e.returnValue = '';
      return;
    }
    if (isVisitOpen() && getPref(PREF_REFRESH) !== 'allow') {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/**
 * Guard an in-app navigation. If allowed, runs fn (or assigns href).
 * @param {() => void | string} actionOrHref
 */
export async function guardedNavigate(actionOrHref) {
  const ok = await confirmLeaveVisit();
  if (!ok) return false;
  if (typeof actionOrHref === 'function') actionOrHref();
  else if (typeof actionOrHref === 'string') location.assign(actionOrHref);
  return true;
}

export function initNavGuard(hooks) {
  setNavGuardHooks(hooks || {});
  installBeforeUnload();
}
