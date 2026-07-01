'use strict';

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { AUTH_MODE, AUTH_SKIP } = require('../auth-middleware');
const { REP_LAYER_EMAILS } = require('../lib/cp-roles');
const { layerHelpText } = require('../lib/visit-instructions');

const router = express.Router();

router.get('/config', (_req, res) => {
  const eodApi =
    process.env.EOD_API_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://eod-api.the-dump-bin.com');
  res.json({
    authMode: AUTH_MODE,
    authSkip: AUTH_SKIP,
    eodApiBase: eodApi.replace(/\/+$/, ''),
    signInPath: '/signin.html',
  });
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
