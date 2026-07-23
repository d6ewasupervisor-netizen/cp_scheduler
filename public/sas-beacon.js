// sas-beacon.js — sticky SAS PROD auth health + silent background refresh
// Polls status; re-auths on its own when down/stale or on a warm interval.
// Never displays tokens/secrets. No user prompts, toasts, or button taps required.

(function () {
  'use strict';

  const POLL_MS = 30000;
  /** Proactive warm refresh so sessions don't expire mid-day. */
  const AUTO_REFRESH_MS = 15 * 60 * 1000;
  /** Re-auth when session age exceeds this (minutes), even if still "ok". */
  const STALE_REFRESH_MIN = 25;
  /** Back off after a failed silent refresh before trying again. */
  const FAIL_BACKOFF_MS = 2 * 60 * 1000;
  const API_STATUS = '/api/central-pet/shift-day/sas-status';
  const API_REFRESH = '/api/central-pet/shift-day/sas-refresh';

  let pollTimer = null;
  let refreshTimer = null;
  let refreshing = false;
  let lastStatus = null;
  let lastRefreshAt = 0;
  let lastFailAt = 0;
  let bootDone = false;

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
      '</div>',
    ].join('');

    const body = document.body;
    if (body.firstChild) body.insertBefore(bar, body.firstChild);
    else body.appendChild(bar);
    body.classList.add('has-sas-beacon');
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
  }

  function needsRefresh(status) {
    if (!status) return true;
    if (!status.ok || status.state === 'down') return true;
    if (status.stale || status.state === 'warn') return true;
    const age = Number(status.ageMinutes);
    if (Number.isFinite(age) && age >= STALE_REFRESH_MIN) return true;
    return false;
  }

  function canAttemptRefresh() {
    if (refreshing) return false;
    if (document.hidden) return false;
    if (lastFailAt && Date.now() - lastFailAt < FAIL_BACKOFF_MS) return false;
    return true;
  }

  async function fetchStatus() {
    ensureDom();
    try {
      const res = await window.cpAuthFetch(API_STATUS, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      const status = {
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
      };
      applyStatus(status);

      // Silent auto-heal when status looks bad / stale
      if (needsRefresh(status) && canAttemptRefresh()) {
        refreshAuth({ silent: true, force: true, reason: 'status' });
      }
      return data;
    } catch (err) {
      applyStatus({
        ok: false,
        healthy: false,
        state: 'down',
        label: 'SAS PROD · offline',
        error: err.message || 'Could not reach status API',
      });
      if (canAttemptRefresh()) {
        refreshAuth({ silent: true, force: true, reason: 'status-error' });
      }
      return null;
    }
  }

  /**
   * @param {{ silent?: boolean, force?: boolean, reason?: string }} [opts]
   */
  async function refreshAuth(opts) {
    const silent = opts?.silent !== false;
    const force = opts?.force !== false;
    if (refreshing) return lastStatus;
    if (silent && !canAttemptRefresh()) return lastStatus;

    refreshing = true;
    const prevOk = !!lastStatus?.ok;

    if (!silent) {
      applyStatus(
        lastStatus || { ok: false, state: 'warn', label: 'SAS PROD · refreshing…' },
        'requesting re-auth…'
      );
    }

    try {
      const res = await window.cpAuthFetch(`${API_REFRESH}?force=${force ? '1' : '0'}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      const data = await res.json().catch(() => ({}));
      const status = data.status || data;
      const triggerMsg = data.trigger?.message || data.trigger?.error || null;
      const next = {
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
      };
      applyStatus(next, silent ? null : triggerMsg && status.ok ? triggerMsg : status.ok ? 'auth refreshed' : null);

      lastRefreshAt = Date.now();
      if (status.ok) lastFailAt = 0;
      else lastFailAt = Date.now();

      // Only nudge pages when auth recovers (down → ok). Quiet warm refreshes stay quiet.
      const recovered = !prevOk && !!status.ok;
      if (recovered || !silent) {
        try {
          window.dispatchEvent(
            new CustomEvent('cp-sas-auth', {
              detail: {
                ok: !!status.ok,
                status: next,
                trigger: data.trigger,
                pull: data.pull,
                silent: !!silent,
                recovered,
              },
            })
          );
        } catch (_) {}
      }

      return next;
    } catch (err) {
      lastFailAt = Date.now();
      applyStatus(
        {
          ok: false,
          healthy: false,
          state: 'down',
          label: 'SAS PROD · offline',
          error: err.message || 'Refresh failed',
        },
        silent ? null : 'refresh failed'
      );
      return null;
    } finally {
      refreshing = false;
      if (!silent) {
        setTimeout(() => fetchStatus(), 2000);
      }
    }
  }

  function scheduleWarmRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!canAttemptRefresh()) return;
      // Warm even when live so morning-auth stays current
      refreshAuth({ silent: true, force: true, reason: 'warm' });
    }, AUTO_REFRESH_MS);
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
    if (bootDone) return;
    bootDone = true;
    ensureDom();
    const tryStart = () => {
      if (typeof window.cpAuthFetch !== 'function') {
        setTimeout(tryStart, 50);
        return;
      }
      fetchStatus().then(() => {
        // Always warm once shortly after boot (status path may already have triggered)
        setTimeout(() => {
          if (canAttemptRefresh() && (!lastRefreshAt || Date.now() - lastRefreshAt > 5000)) {
            refreshAuth({ silent: true, force: true, reason: 'boot' });
          }
        }, 4000);
      });
      startPolling();
      scheduleWarmRefresh();
    };
    tryStart();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        fetchStatus();
        if (canAttemptRefresh() && needsRefresh(lastStatus)) {
          refreshAuth({ silent: true, force: true, reason: 'visible' });
        }
      }
    });
  }

  window.cpSasBeacon = {
    /** Programmatic force refresh (still silent — no toasts). */
    refresh: () => refreshAuth({ silent: true, force: true, reason: 'api' }),
    poll: fetchStatus,
    getLast: () => lastStatus,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
