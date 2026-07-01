'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET;
const SESSION_TYP = 'session';
const SESSION_TTL = process.env.SESSION_TTL_DAYS
  ? `${Number(process.env.SESSION_TTL_DAYS)}d`
  : '45d';

function ensureSecret() {
  if (!SECRET) throw new Error('JWT_SECRET is required');
  return SECRET;
}

function verifySessionToken(token) {
  const payload = jwt.verify(token, ensureSecret());
  if (payload.typ !== SESSION_TYP) {
    const err = new Error('Invalid session token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

module.exports = { verifySessionToken, SESSION_TYP };
