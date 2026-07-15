'use strict';

/**
 * Per-visit allowlist for live transmit. Empty list = nothing transmits,
 * even when LIVE_TRANSMIT=1. No week-wide or rep-wide activation.
 */

const fs = require('fs');
const path = require('path');

const ALLOWLIST_PATH = path.join(__dirname, '../../data/live-allowlist.json');

function isLiveTransmitEnabled(env = process.env) {
  const v = env.LIVE_TRANSMIT;
  return v === '1' || v === 'true' || v === 'TRUE' || v === 'yes';
}

function loadAllowlist(filePath = ALLOWLIST_PATH) {
  if (!fs.existsSync(filePath)) {
    return { notes: '', draftIds: [] };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const draftIds = Array.isArray(raw.draftIds) ? raw.draftIds.map(String) : [];
  return { notes: raw.notes || '', draftIds };
}

function isDraftAllowlisted(draftId, filePath = ALLOWLIST_PATH) {
  if (!draftId) return false;
  const { draftIds } = loadAllowlist(filePath);
  return draftIds.includes(String(draftId));
}

/** Build draft id the same way visit-draft-store does. */
function draftIdFromParts(repKey, date, actualStore) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${repKey}/${safe(date)}-${safe(actualStore)}`;
}

module.exports = {
  ALLOWLIST_PATH,
  isLiveTransmitEnabled,
  loadAllowlist,
  isDraftAllowlisted,
  draftIdFromParts,
};
