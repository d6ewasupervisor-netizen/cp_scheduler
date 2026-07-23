'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSession,
  loadSasSession,
  getSasSessionStatus,
  ageMinutes,
  SasSessionError,
} = require('../src/lib/sas-session');

describe('normalizeSession', () => {
  it('accepts auth-state shape with auth.auth_token', () => {
    const s = normalizeSession(
      {
        generatedAt: '2026-07-16T12:00:00.000Z',
        cookieHeader: 'a=1',
        csrfToken: 'csrf',
        auth: { auth_token: 'tok123' },
      },
      'test'
    );
    assert.equal(s.token, 'tok123');
    assert.equal(s.csrfToken, 'csrf');
    assert.equal(s.cookieHeader, 'a=1');
    assert.equal(s.source, 'test');
  });

  it('accepts eod-api export flat auth_token', () => {
    const s = normalizeSession(
      { auth_token: 'flat', csrfToken: 'c', cookieHeader: 'x=y', generatedAt: '2026-07-16T00:00:00Z' },
      'export'
    );
    assert.equal(s.token, 'flat');
  });

  it('returns null without token', () => {
    assert.equal(normalizeSession({ csrfToken: 'c' }, 'x'), null);
  });
});

describe('loadSasSession env snapshot', () => {
  const prev = {};
  const keys = [
    'SAS_TOKEN',
    'SAS_AUTH_JSON',
    'SAS_AUTH_SESSION_URL',
    'SAS_AUTH_STATE',
    'SAS_CSRF_TOKEN',
    'SAS_COOKIE_HEADER',
    'SAS_SESSION_MAX_AGE_HOURS',
    'RAILWAY_ENVIRONMENT',
    'RAILWAY_SERVICE_NAME',
  ];

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SAS_SESSION_MAX_AGE_HOURS = '0';
  });

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('loads SAS_TOKEN from env', async () => {
    process.env.SAS_TOKEN = 'env-token-xyz';
    process.env.SAS_CSRF_TOKEN = 'csrf-env';
    const s = await loadSasSession();
    assert.equal(s.token, 'env-token-xyz');
    assert.equal(s.csrfToken, 'csrf-env');
    assert.equal(s.source, 'env:SAS_TOKEN');
  });

  it('loads SAS_AUTH_JSON from env', async () => {
    process.env.SAS_AUTH_JSON = JSON.stringify({
      auth: { auth_token: 'json-tok' },
      csrfToken: 'jcsrf',
      cookieHeader: 'sid=1',
      generatedAt: new Date().toISOString(),
    });
    const s = await loadSasSession();
    assert.equal(s.token, 'json-tok');
    assert.equal(s.source, 'env:SAS_AUTH_JSON');
  });

  it('getSasSessionStatus never returns token', async () => {
    process.env.SAS_TOKEN = 'secret-should-not-leak';
    const st = await getSasSessionStatus();
    assert.equal(st.ok, true);
    assert.equal(st.source, 'env:SAS_TOKEN');
    const raw = JSON.stringify(st);
    assert.equal(raw.includes('secret-should-not-leak'), false);
  });

  it('on Railway without URL or token fails clearly', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'production';
    await assert.rejects(
      () => loadSasSession({ statePath: '/nonexistent/auth-state.json' }),
      (err) => {
        assert.ok(err instanceof SasSessionError);
        assert.equal(err.code, 'sas_session_unavailable');
        assert.match(err.message, /SAS_AUTH_SESSION_URL|sas_session_unavailable/);
        return true;
      }
    );
  });
});

describe('ageMinutes', () => {
  it('computes age', () => {
    const past = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const m = ageMinutes(past);
    assert.ok(m >= 89 && m <= 91);
  });
});
