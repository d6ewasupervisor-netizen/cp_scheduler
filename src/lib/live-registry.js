'use strict';

/**
 * Persistent transmit bookkeeping (separate from sealed drafts so seal
 * immutability stays intact). Tracks partial / complete transmit state per
 * draft id and supports the permanent re-transmission refusal.
 */

const fs = require('fs');
const path = require('path');

// On Railway the only durable path is the volume (/app/data/visit-drafts) — keep
// transmit bookkeeping there so a partial survives deploys and can be resumed.
// Local dev keeps the repo-relative live/ path.
function resolveRegistryPath() {
  if (process.env.TRANSMIT_REGISTRY_PATH) return process.env.TRANSMIT_REGISTRY_PATH;
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME) {
    return path.join(__dirname, '../../data/visit-drafts/transmitted-registry.json');
  }
  return path.join(__dirname, '../../live/transmitted-registry.json');
}

const REGISTRY_PATH = resolveRegistryPath();

function ensureDir() {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
}

function readRegistry(filePath = REGISTRY_PATH) {
  if (!fs.existsSync(filePath)) return { drafts: {} };
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeRegistry(registry, filePath = REGISTRY_PATH) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
  return registry;
}

function getTransmitRecord(draftId, filePath = REGISTRY_PATH) {
  if (!draftId) return null;
  return readRegistry(filePath).drafts[String(draftId)] || null;
}

function isAlreadyTransmitted(draftId, filePath = REGISTRY_PATH) {
  const rec = getTransmitRecord(draftId, filePath);
  return rec?.status === 'complete';
}

function isAlreadyTransmittedVisitId(visitId, filePath = REGISTRY_PATH) {
  if (visitId == null) return false;
  const reg = readRegistry(filePath);
  return Object.values(reg.drafts).some(
    (r) => r.status === 'complete' && String(r.visitId) === String(visitId)
  );
}

function markPartial(draftId, patch, filePath = REGISTRY_PATH) {
  const reg = readRegistry(filePath);
  const prev = reg.drafts[String(draftId)] || {};
  reg.drafts[String(draftId)] = {
    ...prev,
    ...patch,
    draftId: String(draftId),
    status: 'partial',
    updatedAt: new Date().toISOString(),
  };
  writeRegistry(reg, filePath);
  return reg.drafts[String(draftId)];
}

function markComplete(draftId, patch, filePath = REGISTRY_PATH) {
  const reg = readRegistry(filePath);
  const prev = reg.drafts[String(draftId)] || {};
  reg.drafts[String(draftId)] = {
    ...prev,
    ...patch,
    draftId: String(draftId),
    status: 'complete',
    transmittedAt: patch.transmittedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeRegistry(reg, filePath);
  return reg.drafts[String(draftId)];
}

module.exports = {
  REGISTRY_PATH,
  readRegistry,
  writeRegistry,
  getTransmitRecord,
  isAlreadyTransmitted,
  isAlreadyTransmittedVisitId,
  markPartial,
  markComplete,
};
