'use strict';

const { query, getPool } = require('./db');

const CORPORATE_EMAIL_DOMAINS = [
  'advantagesolutions.net',
  'retailodyssey.com',
  'sasretailservices.com',
  'youradv.com',
];

const domainSet = new Set(CORPORATE_EMAIL_DOMAINS);

function isCorporateWorkDomainEmail(normalizedEmail) {
  if (typeof normalizedEmail !== 'string' || !normalizedEmail) return false;
  const at = normalizedEmail.lastIndexOf('@');
  if (at < 1) return false;
  return domainSet.has(normalizedEmail.slice(at + 1));
}

function corporateDomainListForMessage() {
  return CORPORATE_EMAIL_DOMAINS.map((d) => `@${d}`).join(', ');
}

async function isEmailAllowed(email) {
  if (typeof email !== 'string' || !email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (isCorporateWorkDomainEmail(normalized)) return true;
  if (!getPool()) return false;

  const { rows } = await query(
    'SELECT 1 FROM allowed_emails WHERE email = $1 LIMIT 1',
    [normalized]
  );
  return rows.length > 0;
}

module.exports = {
  CORPORATE_EMAIL_DOMAINS,
  isCorporateWorkDomainEmail,
  corporateDomainListForMessage,
  isEmailAllowed,
};
