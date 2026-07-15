'use strict';

/**
 * Morning sas-auth session loader — same source as sas-retail-automator / kompass-netcap.
 * Returns auth_token + csrfToken + cookieHeader for credentialed prod writes.
 * Automator uses Authorization Token + X-CSRFToken + cookies (credentials: include);
 * Node fetch strips Cookie headers, so callers must use https with cookieHeader.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join('C:/Users/tgaut/sas-auth/.sas-session/auth-state.json');
const DEFAULT_SESSION_URL = 'http://127.0.0.1:7291/session';

function normalizeSession(raw, source) {
  if (!raw) return null;
  const token = raw?.auth?.auth_token || raw?.auth_token || raw?.token;
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
    generatedAt: raw.generatedAt || null,
    source,
  };
}

async function loadSasSession(opts = {}) {
  const statePath = opts.statePath || process.env.SAS_AUTH_STATE || DEFAULT_STATE_PATH;
  const sessionUrl = opts.sessionUrl || process.env.SAS_AUTH_SESSION_URL || DEFAULT_SESSION_URL;

  // Prefer live auth-server when up (may still mirror same file)
  try {
    const res = await fetch(sessionUrl, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const body = await res.json();
      const session = normalizeSession(body, sessionUrl);
      if (session) {
        // Merge cookie/csrf from disk if server omits them
        if ((!session.cookieHeader || !session.csrfToken) && fs.existsSync(statePath)) {
          const disk = normalizeSession(JSON.parse(fs.readFileSync(statePath, 'utf8')), statePath);
          if (disk) {
            session.cookieHeader = session.cookieHeader || disk.cookieHeader;
            session.csrfToken = session.csrfToken || disk.csrfToken;
            session.cookies = session.cookies || disk.cookies;
          }
        }
        return session;
      }
    }
  } catch {
    /* fall through to disk */
  }

  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const session = normalizeSession(state, statePath);
    if (session) return session;
  }

  throw new Error(`No sas-auth session (tried ${sessionUrl} and ${statePath})`);
}

module.exports = { loadSasSession, normalizeSession, DEFAULT_STATE_PATH, DEFAULT_SESSION_URL };
