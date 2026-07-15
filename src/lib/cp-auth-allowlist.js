'use strict';

const fs = require('fs');
const path = require('path');
const { REP_LAYER_EMAILS, ADMIN_EMAILS } = require('./cp-roles');
const { isCorporateWorkDomainEmail, isEmailAllowed } = require('./allowed-emails');

function loadRepEmailKeys() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../data/rep-emails.json'), 'utf8')
    );
    return Object.keys(raw).map((k) => k.trim().toLowerCase());
  } catch {
    return [];
  }
}

const REP_EMAIL_KEYS = loadRepEmailKeys();

function isCpSchedulerAllowed(email) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (isCorporateWorkDomainEmail(normalized)) return true;
  if (REP_LAYER_EMAILS.includes(normalized)) return true;
  if (ADMIN_EMAILS.includes(normalized)) return true;
  if (REP_EMAIL_KEYS.includes(normalized)) return true;
  return false;
}

async function isCpSchedulerEmailAllowed(email) {
  if (isCpSchedulerAllowed(email)) return true;
  return isEmailAllowed(email);
}

module.exports = { isCpSchedulerAllowed, isCpSchedulerEmailAllowed, ADMIN_EMAILS };
