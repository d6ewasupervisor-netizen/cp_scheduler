// sas-beacon.js — sticky SAS PROD auth health indicator + refresh (all pages)
// Polls like the EOD app connection dots; never displays tokens/secrets.

(function () {
  'use strict';

  const POLL_MS = 30000;
  const API_STATUS = '/api/central-pet/shift-day/sas-status';
  const API_REFRESH = '/api/central-pet/shift-day/sas-refresh';

  let pollTimer = null;
  let refreshing = false;
  let lastStatus = null;

  function el(id) {
    return document.getElementById(id);
  }

  function ensureDom() {
    if (el('sasBeacon')) return el('sasBeacon');
    const bar = document.createElement('div');
    bar.id = 'sasBeacon';
    bar.className = 'sas-beacon state-unknown';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.innerHTML = [
      '<div class="sas-beacon-inner">',
      '  <span class="sas-beacon-dot" id="sasBeaconDot" aria-hidden="true"></span>',
      '  <div class="sas-beacon-text">',
      '    <strong id="sasBeaconLabel">SAS PROD · checking…</strong>',
      '    <span id="sasBeaconDetail">Connecting to morning auth…</span>',
      '  </div>',
      '  <button type="button" class="sas-beacon-refresh" id="sasBeaconRefresh" title="Force-refresh SAS PROD session via eod-api">',
      '    Refresh auth',
      '  </button>',
      '</div>',
    ].join('');

    // Insert at the very top of the document body so every section sees it.
    const body = document.body;
    if (body.firstChild) body.insertBefore(bar, body.firstChild);
    else body.appendChild(bar);
    body.classList.add('has-sas-beacon');

    el('sasBeaconRefresh').addEventListener('click', () => refreshAuth(true));
    return bar;
  }

  function ageLabel(mins) {
    if (mins == null || !Number.isFinite(mins)) return null;
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
  }

  function applyStatus(status, extraDetail) {
    lastStatus = status;
    ensureDom();
    const bar = el('sasBeacon');
    const label = el('sasBeaconLabel');
    const detail = el('sasBeaconDetail');
    const btn = el('sasBeaconRefresh');

    const state = status?.state || (status?.ok ? 'live' : 'down');
    bar.className = `sas-beacon state-${state}`;
    bar.dataset.state = state;

    label.textContent = status?.label || (status?.ok ? 'SAS PROD · live' : 'SAS PROD · offline');

    const bits = [];
    if (status?.ok) {
      const age = ageLabel(status.ageMinutes);
      if (age) bits.push(`session ${age}`);
      if (status.hasCsrf) bits.push('csrf');
      if (status.hasCookie) bits.push('cookie');
      if (status.source) bits.push(String(status.source).replace(/^https?:\/\//, '').slice(0, 48));
    } else {
      const err = status?.error || status?.code || 'session unavailable';
      bits.push(err.length > 140 ? `${err.slice(0, 140)}…` : err);
      if (status?.bridge && !status.bridge.secretConfigured) {
        bits.push('bridge secret missing');
      } else if (status?.bridge && !status.bridge.sessionUrlConfigured) {
        bits.push('bridge URL missing');
      }
    }
    if (extraDetail) bits.unshift(extraDetail);
    detail.textContent = bits.join(' · ') || '—';
    detail.title = status?.error || detail.textContent;

    if (btn && !refreshing) {
      btn.disabled = false;
      btn.textContent = 'Refresh auth';
    }
  }

  async function fetchStatus() {
    ensureDom();
    try {
      const res = await window.cpAuthFetch(API_STATUS, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      applyStatus({
        ok: !!data.ok || res.ok,
        healthy: data.healthy ?? data.ok,
        stale: data.stale,
        state: data.state || (data.ok ? (data.stale ? 'warn' : 'live') : 'down'),
        label: data.label,
        error: data.error,
        code: data.code,
        source: data.source,
        generatedAt: data.generatedAt,
        ageMinutes: data.ageMinutes,
        hasCsrf: data.hasCsrf,
        hasCookie: data.hasCookie,
        bridge: data.bridge,
      });
      return data;
    } catch (err) {
      applyStatus({
        ok: false,
        healthy: false,
        state: 'down',
        label: 'SAS PROD · offline',
        error: err.message || 'Could not reach status API',
      });
      return null;
    }
  }

  async function refreshAuth(force) {
    if (refreshing) return;
    refreshing = true;
    const btn = el('sasBeaconRefresh');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
    }
    applyStatus(
      lastStatus || { ok: false, state: 'warn', label: 'SAS PROD · refreshing…' },
      'requesting re-auth…'
    );

    try {
      const res = await window.cpAuthFetch(`${API_REFRESH}?force=${force ? '1' : '0'}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      const data = await res.json().catch(() => ({}));
      const status = data.status || data;
      const triggerMsg = data.trigger?.message || data.trigger?.error || null;
      applyStatus(
        {
          ok: !!status.ok,
          healthy: status.healthy ?? status.ok,
          stale: status.stale,
          state: status.state || (status.ok ? 'live' : 'down'),
          label: status.label,
          error: status.error || (!status.ok ? triggerMsg : null),
          code: status.code,
          source: status.source,
          generatedAt: status.generatedAt,
          ageMinutes: status.ageMinutes,
          hasCsrf: status.hasCsrf,
          hasCookie: status.hasCookie,
          bridge: status.bridge,
        },
        triggerMsg && status.ok ? triggerMsg : status.ok ? 'auth refreshed' : null
      );

      // Notify pages that may want to re-sync after auth recovers
      try {
        window.dispatchEvent(
          new CustomEvent('cp-sas-auth', {
            detail: { ok: !!status.ok, status, trigger: data.trigger, pull: data.pull },
          })
        );
      } catch (_) {}

      if (window.cpToast) {
        if (status.ok) window.cpToast(triggerMsg || 'SAS PROD auth is live', 'ok', 4000);
        else window.cpToast(status.error || triggerMsg || 'SAS auth still offline', 'bad', 7000);
      }
    } catch (err) {
      applyStatus(
        {
          ok: false,
          healthy: false,
          state: 'down',
          label: 'SAS PROD · offline',
          error: err.message || 'Refresh failed',
        },
        'refresh failed'
      );
      if (window.cpToast) window.cpToast(`Auth refresh failed: ${err.message}`, 'bad', 6000);
    } finally {
      refreshing = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Refresh auth';
      }
      // Re-probe shortly after so age/source settle
      setTimeout(() => fetchStatus(), 2000);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!document.hidden && !refreshing) fetchStatus();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function boot() {
    ensureDom();
    // Wait for auth-gate to expose cpAuthFetch when possible
    const tryStart = () => {
      if (typeof window.cpAuthFetch !== 'function') {
        setTimeout(tryStart, 50);
        return;
      }
      fetchStatus();
      startPolling();
    };
    tryStart();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) fetchStatus();
    });
  }

  // Public API for pages
  window.cpSasBeacon = {
    refresh: () => refreshAuth(true),
    poll: fetchStatus,
    getLast: () => lastStatus,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
