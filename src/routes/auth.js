'use strict';

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { AUTH_MODE, AUTH_SKIP } = require('../auth-middleware');
const { REP_LAYER_EMAILS } = require('../lib/cp-roles');
const { layerHelpText } = require('../lib/visit-instructions');
const { forwardToEodApi, eodApiBase } = require('../lib/eod-api-proxy');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/config', (_req, res) => {
  res.json({
    authMode: AUTH_MODE,
    authSkip: AUTH_SKIP,
    eodApiBase: eodApiBase(),
    signInPath: '/signin.html',
    useSameOriginSignIn: true,
  });
});

router.post('/request-link', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    const payload = { email };
    const returnTo = String(req.body?.returnTo || '').trim();
    if (returnTo) payload.returnTo = returnTo;

    const { status, data } = await forwardToEodApi(req, '/api/request-link', payload);
    return res.status(status).json(data);
  } catch (err) {
    console.error('[auth] request-link proxy failed:', err.message);
    return res.status(502).json({
      ok: false,
      error: 'Sign-in service is temporarily unavailable. Try again in a moment.',
    });
  }
});

router.post('/access-request', async (req, res) => {
  try {
    const { status, data } = await forwardToEodApi(req, '/api/access-request', req.body || {});
    return res.status(status).json(data);
  } catch (err) {
    console.error('[auth] access-request proxy failed:', err.message);
    return res.status(502).json({
      ok: false,
      error: 'Could not submit your access request. Try again in a moment.',
    });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    ok: true,
    email: req.user.email,
    layer: req.user.layer,
    isAdmin: req.user.layer === 'admin',
    isRep: req.user.layer === 'rep',
    help: layerHelpText(req.user.layer),
    repLayerEmails: REP_LAYER_EMAILS,
  });
});

module.exports = router;
