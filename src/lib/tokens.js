'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET;
const LINK_TYP = 'link';
const TTL_DAYS = Number(process.env.LINK_TTL_DAYS || 30);

function ensureSecret() {
  if (!SECRET) throw new Error('JWT_SECRET is required');
  return SECRET;
}

function issueLinkToken(email) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign({ email, typ: LINK_TYP }, ensureSecret(), {
    expiresIn: `${TTL_DAYS}d`,
    jwtid: jti,
  });
  return { token, jti };
}

function verifyLinkToken(token) {
  const payload = jwt.verify(token, ensureSecret());
  if (payload.typ !== LINK_TYP) {
    const err = new Error('Invalid link token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

module.exports = { issueLinkToken, verifyLinkToken };
