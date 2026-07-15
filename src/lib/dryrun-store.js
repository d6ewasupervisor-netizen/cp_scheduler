'use strict';

/**
 * Stage 4 Part B — dry-run output files. Pure file I/O; never calls prod.
 * Per-visit files + a per-run manifest under dryrun/{runId}/.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../dryrun');

function safeSeg(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function runDir(runId) {
  return path.join(ROOT, safeSeg(runId));
}

function visitFileName(repKey, date, store) {
  return `${safeSeg(repKey)}-${safeSeg(date)}-FM${safeSeg(store)}.json`;
}

/** Defense-in-depth: refuse to write if anything resembling a live secret
 * slipped into the payload, even though transmitVisit() only ever redacts
 * Authorization headers by construction. Scans for the literal patterns a
 * real SAS token/cookie would take, never the {{REDACTED}} placeholder. */
const SECRET_PATTERNS = [/Token [0-9a-f]{30,}/i, /\bsessionid=/i, /\bcsrftoken=/i];

function assertNoSecrets(obj) {
  const text = JSON.stringify(obj);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Refusing to write dry-run output — matched secret pattern ${pattern}`);
    }
  }
}

function writeVisitFile(runId, { repKey, date, store, assembled }) {
  assertNoSecrets(assembled);
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, visitFileName(repKey, date, store));
  fs.writeFileSync(file, JSON.stringify(assembled, null, 2));
  return file;
}

function writeManifest(runId, manifest) {
  assertNoSecrets(manifest);
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

function readManifest(runId) {
  const file = path.join(runDir(runId), 'manifest.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readVisitFile(runId, filename) {
  const file = path.join(runDir(runId), safeSeg(filename).replace(/_json$/, '.json'));
  const direct = path.join(runDir(runId), filename);
  const target = fs.existsSync(direct) ? direct : file;
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function listRuns() {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .filter((f) => fs.statSync(path.join(ROOT, f)).isDirectory())
    .sort()
    .reverse();
}

module.exports = {
  ROOT,
  runDir,
  visitFileName,
  writeVisitFile,
  writeManifest,
  readManifest,
  readVisitFile,
  listRuns,
  assertNoSecrets,
};
