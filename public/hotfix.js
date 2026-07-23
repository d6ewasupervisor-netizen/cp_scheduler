/**
 * Hotfix auto-update (same idea as EOD on the-dump-bin).
 *
 * Keep CP_APP_VERSION in lockstep with /app-version.json — a mismatch
 * triggers an unattended reload so field devices pick up Railway deploys
 * without reinstalling. Drafts/photos live on the server (and IndexedDB
 * queue), so a reload is safe for in-progress visits.
 *
 * When bumping: edit BOTH this constant and app-version.json in the same commit.
 */
(function () {
  'use strict';

  var CP_APP_VERSION = '1.1.4';
  var CP_VERSION_URL = '/app-version.json';
  var CP_PENDING_VERSION_KEY = 'cpPendingHotfixVersion';
  var CP_SNOOZE_KEY = 'cpHotfixSnoozeUntil';
  var CP_UPDATE_CHECK_MS = 2 * 60 * 1000;
  var CP_UPDATE_AUTO_RELOAD_MS = 3500;

  if (window.__cpHotfixWatchStarted) return;
  window.__cpHotfixWatchStarted = true;
  window.CP_APP_VERSION = CP_APP_VERSION;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureBanner() {
    var banner = document.getElementById('cpUpdateBanner');
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'cpUpdateBanner';
    banner.className = 'cp-update-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    var host = document.body;
    if (host.firstChild) host.insertBefore(banner, host.firstChild);
    else host.appendChild(banner);
    return banner;
  }

  function liveCameraOpen() {
    return !!document.querySelector('.vf-live-camera');
  }

  function snoozed() {
    try {
      var until = Number(sessionStorage.getItem(CP_SNOOZE_KEY) || 0);
      return until && Date.now() < until;
    } catch (_) {
      return false;
    }
  }

  function setSnooze(ms) {
    try {
      sessionStorage.setItem(CP_SNOOZE_KEY, String(Date.now() + ms));
    } catch (_) {}
  }

  async function fetchLiveVersion() {
    try {
      var resp = await fetch(CP_VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) return null;
      var data = await resp.json();
      return data && data.version ? String(data.version).trim() : null;
    } catch (_) {
      return null;
    }
  }

  function showStaleCacheBanner(remoteVersion) {
    var banner = ensureBanner();
    banner.classList.add('visible');
    banner.innerHTML =
      '<strong>Update ready — hard refresh needed</strong><br>' +
      'This tab is still on v' +
      escapeHtml(CP_APP_VERSION) +
      ' (server is v' +
      escapeHtml(remoteVersion) +
      '). Progress is saved on the server. Hard refresh: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac).';
  }

  function showCameraDeferBanner(remoteVersion) {
    var banner = ensureBanner();
    banner.classList.add('visible');
    banner.innerHTML =
      '<strong>App update waiting</strong><br>' +
      'v' +
      escapeHtml(remoteVersion) +
      ' is ready. Finish or close the camera — we will reload automatically so you do not lose the shot.';
  }

  function triggerHotfixReload(remoteVersion) {
    try {
      sessionStorage.setItem(CP_PENDING_VERSION_KEY, remoteVersion);
      sessionStorage.removeItem(CP_SNOOZE_KEY);
    } catch (_) {}
    var banner = ensureBanner();
    banner.classList.add('visible');
    banner.innerHTML =
      '<strong>App update installing</strong><br>' +
      'A new version is available. Visit progress and uploaded photos are saved on the server. Reloading automatically…';
    setTimeout(function () {
      try {
        var u = new URL(window.location.href);
        u.searchParams.set('cpv', remoteVersion);
        u.searchParams.set('_', String(Date.now()));
        window.location.replace(u.toString());
      } catch (_) {
        window.location.reload();
      }
    }, CP_UPDATE_AUTO_RELOAD_MS);
  }

  async function checkVersion() {
    if (snoozed()) return;

    var remote = await fetchLiveVersion();
    if (!remote || remote === CP_APP_VERSION) {
      try {
        if (sessionStorage.getItem(CP_PENDING_VERSION_KEY) === remote) {
          sessionStorage.removeItem(CP_PENDING_VERSION_KEY);
        }
      } catch (_) {}
      var banner = document.getElementById('cpUpdateBanner');
      if (banner && remote === CP_APP_VERSION) banner.classList.remove('visible');
      return;
    }

    var pending = null;
    try {
      pending = sessionStorage.getItem(CP_PENDING_VERSION_KEY);
    } catch (_) {}
    if (pending === remote) {
      showStaleCacheBanner(remote);
      return;
    }

    // Don't yank the live camera mid-shot — retry on next poll / focus.
    if (liveCameraOpen()) {
      showCameraDeferBanner(remote);
      return;
    }

    triggerHotfixReload(remote);
  }

  function start() {
    try {
      var pending = sessionStorage.getItem(CP_PENDING_VERSION_KEY);
      if (pending && pending === CP_APP_VERSION) {
        sessionStorage.removeItem(CP_PENDING_VERSION_KEY);
      }
    } catch (_) {}

    checkVersion();
    setInterval(checkVersion, CP_UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkVersion();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Expose for optional “Not now” UI / tests.
  window.cpHotfix = {
    version: CP_APP_VERSION,
    checkNow: checkVersion,
    snooze: function (minutes) {
      setSnooze(Math.max(1, Number(minutes) || 15) * 60 * 1000);
      var banner = document.getElementById('cpUpdateBanner');
      if (banner) banner.classList.remove('visible');
    },
  };
})();
