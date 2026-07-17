'use strict';

/**
 * Morning sas-auth session loader — same source as sas-retail-automator / kompass-netcap.
 * Returns auth_token + csrfToken + cookieHeader for credentialed prod writes.
 * Automator uses Authorization Token + X-CSRFToken + cookies (credentials: include);
 * Node fetch strips Cookie headers, so callers must use https with cookieHeader.
 *
 * Priority (first match wins):
 *  1. Env snapshot: SAS_AUTH_JSON (full JSON) or SAS_TOKEN (+ optional CSRF/cookie env)
 *  2. SAS_AUTH_SESSION_URL (local auth-server or eod-api /internal/sas-session/export)
 *  3. Disk SAS_AUTH_STATE / default Windows morning-auth path (local only)
 *
 * Railway: set SAS_AUTH_SESSION_URL + SAS_AUTH_SECRET to pull from eod-api.
 * Never log tokens or cookies.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join('C:/Users/tgaut/sas-auth/.sas-session/auth-state.json');
const DEFAULT_SESSION_URL = 'http://127.0.0.1:7291/session';
const DEFAULT_FETCH_TIMEOUT_MS = 8000;
/** Refuse sessions older than this (default 24h). Set SAS_SESSION_MAX_AGE_HOURS=0 to disable. */
const DEFAULT_MAX_AGE_HOURS = 24;

class SasSessionError extends Error {
  constructor(message, code = 'sas_session_unavailable') {
    super(message);
    this.name = 'SasSessionError';
    this.code = code;
  }
}

function normalizeSession(raw, source) {
  if (!raw) return null;
  const token = raw?.auth?.auth_token || raw?.auth_token || raw?.token || raw?.authToken;
  if (!token) return null;
  const csrfToken =
    raw.csrfToken ||
    raw.csrf_token ||
    raw.auth?.csrf_token ||
    raw.cookies?.csrftoken ||
    null;
  const cookieHeader =
    raw.cookieHeader ||
    (raw.cookies && typeof raw.cookies === 'object'
      ? Object.entries(raw.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ')
      : null);
  return {
    token: String(token),
    csrfToken: csrfToken ? String(csrfToken) : null,
    cookieHeader: cookieHeader || null,
    cookies: raw.cookies || null,
    userInfo: raw.auth?.userInfo || raw.userInfo || null,
    generatedAt: raw.generatedAt || raw.receivedAt || null,
    source,
  };
}

function maxAgeHours() {
  const raw = process.env.SAS_SESSION_MAX_AGE_HOURS;
  if (raw === '0' || raw === 'false') return 0;
  const n = raw != null && raw !== '' ? Number(raw) : DEFAULT_MAX_AGE_HOURS;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_AGE_HOURS;
}

function ageMinutes(generatedAt) {
  if (!generatedAt) return null;
  const t = new Date(generatedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 60000);
}

function assertNotStale(session) {
  const maxH = maxAgeHours();
  if (!maxH || !session.generatedAt) return session;
  const ageMin = ageMinutes(session.generatedAt);
  if (ageMin == null) return session;
  if (ageMin > maxH * 60) {
    throw new SasSessionError(
      `sas_session_stale — session age ${ageMin}m exceeds ${maxH}h (source=${session.source}). ` +
        'Run morning auth or wait for eod-api auto-refresh.',
      'sas_session_stale'
    );
  }
  return session;
}

function loadFromEnvSnapshot() {
  // Full JSON blob (auth-state shape) — useful for rare env-based injects.
  const jsonRaw = process.env.SAS_AUTH_JSON;
  if (jsonRaw && String(jsonRaw).trim()) {
    try {
      const session = normalizeSession(JSON.parse(jsonRaw), 'env:SAS_AUTH_JSON');
      if (session) return assertNotStale(session);
    } catch (err) {
      if (err instanceof SasSessionError) throw err;
      throw new SasSessionError(
        `SAS_AUTH_JSON invalid JSON: ${err.message}`,
        'sas_session_unavailable'
      );
    }
  }

  const token = process.env.SAS_TOKEN;
  if (token && String(token).trim()) {
    return assertNotStale({
      token: String(token).trim(),
      csrfToken: process.env.SAS_CSRF_TOKEN || process.env.SAS_CSRF || null,
      cookieHeader: process.env.SAS_COOKIE_HEADER || process.env.SAS_COOKIE || null,
      cookies: null,
      userInfo: null,
      generatedAt: process.env.SAS_TOKEN_GENERATED_AT || null,
      source: 'env:SAS_TOKEN',
    });
  }
  return null;
}

async function loadFromSessionUrl(sessionUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || Number(process.env.SAS_AUTH_FETCH_TIMEOUT_MS) || DEFAULT_FETCH_TIMEOUT_MS;
  const secret = opts.secret ?? process.env.SAS_AUTH_SECRET ?? '';
  const headers = { Accept: 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  let res;
  try {
    res = await fetch(sessionUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `timeout after ${timeoutMs}ms`
      : err.message;
    throw new SasSessionError(
      `sas_session_unavailable — fetch ${sessionUrl} failed: ${reason}`,
      'sas_session_unavailable'
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 401 || res.status === 403) {
    throw new SasSessionError(
      `sas_session_unavailable — ${sessionUrl} returned ${res.status} (check SAS_AUTH_SECRET)`,
      'sas_session_unavailable'
    );
  }

  if (!res.ok) {
    const code = body?.code || 'sas_session_unavailable';
    const detail = body?.error || res.statusText || `HTTP ${res.status}`;
    throw new SasSessionError(
      `${code} — ${sessionUrl}: ${detail}`,
      code === 'sas_session_stale' ? 'sas_session_stale' : 'sas_session_unavailable'
    );
  }

  const session = normalizeSession(body, sessionUrl);
  if (!session) {
    throw new SasSessionError(
      `sas_session_unavailable — ${sessionUrl} response missing auth_token`,
      'sas_session_unavailable'
    );
  }
  return assertNotStale(session);
}

function loadFromDisk(statePath) {
  if (!fs.existsSync(statePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const session = normalizeSession(state, statePath);
    if (!session) return null;
    return assertNotStale(session);
  } catch (err) {
    if (err instanceof SasSessionError) throw err;
    throw new SasSessionError(
      `sas_session_unavailable — failed to read ${statePath}: ${err.message}`,
      'sas_session_unavailable'
    );
  }
}

/**
 * Load a live SAS prod session.
 * @param {object} [opts]
 * @param {string} [opts.statePath]
 * @param {string} [opts.sessionUrl]
 * @param {string} [opts.secret]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{token,csrfToken,cookieHeader,cookies,userInfo,generatedAt,source}>}
 */
async function loadSasSession(opts = {}) {
  // 1) Explicit env snapshot (works on Railway without Windows paths)
  const fromEnv = loadFromEnvSnapshot();
  if (fromEnv) return fromEnv;

  const statePath = opts.statePath || process.env.SAS_AUTH_STATE || DEFAULT_STATE_PATH;
  const envUrl = process.env.SAS_AUTH_SESSION_URL;
  // Prefer explicit env URL; only fall back to localhost when no env is set
  // (local dev). On Railway, always require SAS_AUTH_SESSION_URL or SAS_TOKEN.
  const sessionUrl =
    opts.sessionUrl ||
    envUrl ||
    (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME
      ? null
      : DEFAULT_SESSION_URL);

  const errors = [];

  // 2) HTTP session URL (auth-server or eod-api export bridge)
  if (sessionUrl) {
    try {
      const session = await loadFromSessionUrl(sessionUrl, opts);
      // Merge cookie/csrf from disk if server omits them (local auth-server)
      if ((!session.cookieHeader || !session.csrfToken) && fs.existsSync(statePath)) {
        try {
          const disk = loadFromDisk(statePath);
          if (disk) {
            session.cookieHeader = session.cookieHeader || disk.cookieHeader;
            session.csrfToken = session.csrfToken || disk.csrfToken;
            session.cookies = session.cookies || disk.cookies;
          }
        } catch {
          /* ignore disk merge failures */
        }
      }
      return session;
    } catch (err) {
      errors.push(err.message);
      // If URL was explicitly configured (Railway), do not silently fall through
      // to a Windows path that cannot exist in the container.
      if (envUrl || opts.sessionUrl) {
        throw err instanceof SasSessionError
          ? err
          : new SasSessionError(err.message, 'sas_session_unavailable');
      }
    }
  }

  // 3) Disk auth-state (local morning-auth)
  try {
    const disk = loadFromDisk(statePath);
    if (disk) return disk;
  } catch (err) {
    errors.push(err.message);
    if (err instanceof SasSessionError && err.code === 'sas_session_stale') throw err;
  }

  const tried = [sessionUrl, statePath, 'SAS_TOKEN/SAS_AUTH_JSON'].filter(Boolean).join(', ');
  const detail = errors.length ? ` (${errors.join('; ')})` : '';
  throw new SasSessionError(
    `sas_session_unavailable — No sas-auth session (tried ${tried})${detail}. ` +
      'On Railway set SAS_AUTH_SESSION_URL + SAS_AUTH_SECRET (eod-api export). ' +
      'Locally run morning-auth / auth-server on :7291.',
    'sas_session_unavailable'
  );
}

/**
 * Non-secret bridge config for ops UI (booleans only).
 */
function getSasBridgeConfig() {
  const sessionUrl =
    process.env.SAS_AUTH_SESSION_URL ||
    (!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME)
      ? DEFAULT_SESSION_URL
      : null);
  return {
    sessionUrlConfigured: !!sessionUrl,
    secretConfigured: !!(process.env.SAS_AUTH_SECRET || '').trim(),
    envTokenConfigured: !!(process.env.SAS_TOKEN || process.env.SAS_AUTH_JSON),
    eodApiBase: (
      process.env.EOD_API_BASE_URL ||
      'https://eod-api.the-dump-bin.com'
    ).replace(/\/+$/, ''),
    maxAgeHours: maxAgeHours(),
  };
}

/**
 * Status for UI / ops — never includes token or cookies.
 */
async function getSasSessionStatus(opts = {}) {
  const bridge = getSasBridgeConfig();
  try {
    const session = await loadSasSession(opts);
    const ageMin = ageMinutes(session.generatedAt);
    const maxH = maxAgeHours();
    const stale =
      maxH > 0 && ageMin != null ? ageMin > maxH * 60 * 0.85 : false; // warn before hard fail
    return {
      ok: true,
      healthy: true,
      stale: !!stale,
      state: stale ? 'warn' : 'live',
      label: stale ? 'SAS PROD · aging' : 'SAS PROD · live',
      source: session.source,
      generatedAt: session.generatedAt,
      ageMinutes: ageMin,
      hasCsrf: !!session.csrfToken,
      hasCookie: !!session.cookieHeader,
      bridge,
    };
  } catch (err) {
    const code = err.code || 'sas_session_unavailable';
    const isStale = code === 'sas_session_stale';
    return {
      ok: false,
      healthy: false,
      stale: isStale,
      state: 'down',
      label: isStale ? 'SAS PROD · stale' : 'SAS PROD · offline',
      error: err.message,
      code,
      source: null,
      generatedAt: null,
      ageMinutes: null,
      hasCsrf: false,
      hasCookie: false,
      bridge,
    };
  }
}

module.exports = {
  loadSasSession,
  getSasSessionStatus,
  getSasBridgeConfig,
  normalizeSession,
  ageMinutes,
  SasSessionError,
  DEFAULT_STATE_PATH,
  DEFAULT_SESSION_URL,
};
