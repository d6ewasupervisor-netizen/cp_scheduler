'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join('C:/Users/tgaut/sas-auth/.sas-session/auth-state.json');
const DEFAULT_SESSION_URL = 'http://127.0.0.1:7291/session';

async function loadSasSession(opts = {}) {
  const statePath = opts.statePath || process.env.SAS_AUTH_STATE || DEFAULT_STATE_PATH;
  const sessionUrl = opts.sessionUrl || process.env.SAS_AUTH_SESSION_URL || DEFAULT_SESSION_URL;

  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const token = state?.auth?.auth_token;
    if (token) {
      return {
        token: String(token),
        generatedAt: state.generatedAt || null,
        source: statePath,
      };
    }
  }

  const res = await fetch(sessionUrl);
  if (!res.ok) throw new Error(`SAS auth-server ${res.status}: ${sessionUrl}`);
  const body = await res.json();
  const token = body?.auth?.auth_token;
  if (!token) throw new Error('No auth_token in sas-auth session response');
  return {
    token: String(token),
    generatedAt: body.generatedAt || null,
    source: sessionUrl,
  };
}

module.exports = { loadSasSession, DEFAULT_STATE_PATH };
