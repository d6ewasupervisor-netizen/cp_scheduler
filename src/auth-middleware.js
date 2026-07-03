'use strict';

const { verifySessionToken } = require('./lib/session-jwt');
const { isEmailAllowed } = require('./lib/allowed-emails');
const { isCpSchedulerAllowed } = require('./lib/cp-auth-allowlist');
const { cpSchedulerLayer } = require('./lib/cp-roles');

const AUTH_MODE = (process.env.AUTH_MODE || 'session').trim().toLowerCase();
const AUTH_SKIP = process.env.CP_SCHEDULER_AUTH_SKIP === '1';

function readBearer(req) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function localDevBypass(req) {
  if (!AUTH_SKIP) return null;
  const host = req.hostname || '';
  if (host !== 'localhost' && host !== '127.0.0.1') return null;
  return {
    id: 'local-dev',
    email: 'dev@localhost',
    layer: 'admin',
    roles: ['admin'],
  };
}

async function authenticateRequest(req, res) {
  const bypass = localDevBypass(req);
  if (bypass) {
    return bypass;
  }

  if (AUTH_MODE !== 'session') {
    res.status(503).json({
      error: 'cp_scheduler requires AUTH_MODE=session with JWT_SECRET and DATABASE_URL',
    });
    return null;
  }

  if (!process.env.JWT_SECRET) {
    res.status(503).json({ error: 'JWT_SECRET is not configured' });
    return null;
  }

  const token = readBearer(req);
  if (!token) {
    res.status(401).json({ error: 'Sign in required' });
    return null;
  }

  let payload;
  try {
    payload = verifySessionToken(token);
  } catch (err) {
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
      return null;
    }
    console.error('[auth] session verify threw:', err);
    res.status(500).json({ error: 'Could not authorize request' });
    return null;
  }

  const email = (payload.email || '').toString().trim().toLowerCase();
  try {
    const allowed =
      isCpSchedulerAllowed(email) || (await isEmailAllowed(email));
    if (!allowed) {
      res.status(403).json({ error: 'Access is not enabled for this account' });
      return null;
    }
  } catch (err) {
    console.error('[auth] allowlist check failed:', err);
    res.status(500).json({ error: 'Could not authorize request' });
    return null;
  }

  const layer = cpSchedulerLayer(email);
  return {
    id: payload.sub || email,
    email,
    layer,
    roles: [layer],
  };
}

async function requireAuth(req, res, next) {
  const user = await authenticateRequest(req, res);
  if (!user) return;
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.layer !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, authenticateRequest, AUTH_MODE, AUTH_SKIP };
