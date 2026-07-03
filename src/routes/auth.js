'use strict';

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const { AUTH_MODE, AUTH_SKIP } = require('../auth-middleware');
const { REP_LAYER_EMAILS } = require('../lib/cp-roles');
const { layerHelpText } = require('../lib/visit-instructions');
const { forwardToEodApi, eodApiBase } = require('../lib/eod-api-proxy');
const { repKeyForEmail } = require('../lib/rep-emails');
const { getRep } = require('../lib/master-route');
const { isCpSchedulerEmailAllowed } = require('../lib/cp-auth-allowlist');
const { issueLinkToken, verifyLinkToken } = require('../lib/tokens');
const { issueSessionToken } = require('../lib/session-jwt');
const { buildMagicLink } = require('../lib/magic-link');
const { sendLinkEmail } = require('../lib/auth-email');
const { query, getPool } = require('../lib/db');

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

    if (!getPool()) {
      return res.status(503).json({
        ok: false,
        error: 'Sign-in is not configured yet (database missing). Contact your supervisor.',
      });
    }

    if (!(await isCpSchedulerEmailAllowed(email))) {
      return res.status(400).json({
        ok: false,
        error: 'This email is not on the access list. Contact your supervisor if you believe this is in error.',
      });
    }

    const rawReturnTo = String(req.body?.returnTo || '').trim();
    const defaultReturn =
      `${(process.env.CP_SCHEDULER_PUBLIC_URL || 'https://cpscheduler-production.up.railway.app').replace(/\/+$/, '')}/rep.html`;
    const { token, jti } = issueLinkToken(email);
    const link = buildMagicLink(token, rawReturnTo || defaultReturn);
    if (!link) {
      return res.status(400).json({ ok: false, error: 'Invalid return URL.' });
    }

    await query(
      `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
      [email, jti, req.ip || null, req.get('user-agent') || null]
    );

    await sendLinkEmail({ to: email, link });
    console.log(`[auth] request-link issued jti=${jti.slice(0, 6)}… for ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth] request-link failed:', err);
    return res.status(500).json({
      ok: false,
      error: 'Could not send link. Please try again.',
    });
  }
});

router.get('/verify-token', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token.' });
  }

  if (!getPool()) {
    return res.status(503).json({ ok: false, error: 'Sign-in is not configured yet.' });
  }

  try {
    const payload = verifyLinkToken(token);
    const jti = payload.jti;
    const email = payload.email;

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT used_at FROM link_requests WHERE jti = $1 LIMIT 1 FOR UPDATE`,
        [jti]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'Link not recognized. Request a new one.' });
      }
      if (rows[0].used_at) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          ok: false,
          error: 'This link has already been used. Request a new one to sign in on this device.',
        });
      }
      await client.query(`UPDATE link_requests SET used_at = NOW() WHERE jti = $1`, [jti]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    const sessionToken = issueSessionToken(email);
    return res.json({ ok: true, email, token: sessionToken });
  } catch (err) {
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      return res.status(400).json({ ok: false, error: 'This link is invalid or expired.' });
    }
    console.error('[auth] verify-token failed:', err);
    return res.status(500).json({ ok: false, error: 'Could not verify link.' });
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
  const repKey = req.user.layer === 'rep' ? repKeyForEmail(req.user.email) : null;
  const rep = repKey ? getRep(repKey) : null;
  res.json({
    ok: true,
    email: req.user.email,
    layer: req.user.layer,
    isAdmin: req.user.layer === 'admin',
    isRep: req.user.layer === 'rep',
    repKey,
    rep: rep
      ? {
          name: rep.name,
          district: rep.district,
          visitCount: rep.visitSlots?.length || 0,
          isD8Pool: !!rep.isD8Pool,
          allowsRepAvailability: !!rep.allowsRepAvailability,
        }
      : null,
    help: layerHelpText(req.user.layer),
    repLayerEmails: REP_LAYER_EMAILS,
  });
});

module.exports = router;
