'use strict';

const fs = require('fs');
const path = require('path');
const { REP_LAYER_EMAILS } = require('./cp-roles');
const { isCorporateWorkDomainEmail } = require('./allowed-emails');

function parseList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ADMIN_EMAILS = parseList(process.env.CP_SCHEDULER_ADMIN_EMAILS);

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

module.exports = { isCpSchedulerAllowed, ADMIN_EMAILS };
