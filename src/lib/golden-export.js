'use strict';

/**
 * Golden export validation for live testMode round-trip verification.
 * Format: kompass-netcap scripts/export-cp-shift-full.js
 *   visit-{id}/manifest.json + raw/ + photos/, allChecksPassed: true
 */

const fs = require('fs');
const path = require('path');

/** Known golden subjects (2026-07-13 scheduled 391 test visits). */
const KNOWN_GOLDEN_VISITS = {
  26822177: { scheduledStore: 391, decodedStore: 215, date: '2026-07-13' },
  26822165: { scheduledStore: 391, decodedStore: 111, date: '2026-07-13' },
};

/**
 * Validate a golden (or post-run) export folder.
 * @returns {{ ok: boolean, path: string, manifest: object|null, failures: string[] }}
 */
function validateGoldenExport(exportPath) {
  const failures = [];
  if (!exportPath || typeof exportPath !== 'string') {
    return { ok: false, path: exportPath || null, manifest: null, failures: ['goldenExportPath required'] };
  }
  const root = path.resolve(exportPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, path: root, manifest: null, failures: [`Not a directory: ${root}`] };
  }

  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    failures.push('manifest.json missing');
  }

  const rawDir = path.join(root, 'raw');
  if (!fs.existsSync(rawDir) || !fs.statSync(rawDir).isDirectory()) {
    failures.push('raw/ directory missing');
  } else {
    const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json'));
    if (!rawFiles.length) failures.push('raw/ has no .json files');
  }

  const photosDir = path.join(root, 'photos');
  if (!fs.existsSync(photosDir) || !fs.statSync(photosDir).isDirectory()) {
    failures.push('photos/ directory missing');
  }

  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      failures.push(`manifest.json unreadable: ${err.message}`);
    }
  }

  if (manifest) {
    if (manifest.allChecksPassed !== true) {
      failures.push('manifest.allChecksPassed is not true — refuse to arm without a clean golden export');
    }
    if (manifest.visitId == null) {
      failures.push('manifest.visitId missing');
    }
  }

  return {
    ok: failures.length === 0,
    path: root,
    manifest,
    failures,
  };
}

function listRawJsonFiles(exportPath) {
  const rawDir = path.join(path.resolve(exportPath), 'raw');
  if (!fs.existsSync(rawDir)) return [];
  return fs
    .readdirSync(rawDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(rawDir, f));
}

/** Load raw/*.json keyed by basename, unwrapping {_meta, data} when present. */
function loadRawBodies(exportPath) {
  const out = {};
  for (const file of listRawJsonFiles(exportPath)) {
    const base = path.basename(file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    out[base] = raw && Object.prototype.hasOwnProperty.call(raw, 'data') ? raw.data : raw;
  }
  return out;
}

function photoSlotCounts(exportPath) {
  const photosRoot = path.join(path.resolve(exportPath), 'photos');
  const counts = { categoryBefore: 0, categoryAfter: 0, surveyByQ: {}, total: 0 };
  if (!fs.existsSync(photosRoot)) return counts;

  function walk(dir, rel = '') {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) {
        walk(full, r);
        continue;
      }
      if (!/\.(jpe?g|png|gif|webp)$/i.test(name)) continue;
      counts.total += 1;
      if (/before/i.test(name) || /\/before/i.test(r)) counts.categoryBefore += 1;
      if (/after/i.test(name) || /\/after/i.test(r)) counts.categoryAfter += 1;
      const qMatch = r.match(/survey\/(q\d+)/i) || r.match(/(q\d+)/i);
      if (qMatch) {
        const q = qMatch[1].toLowerCase();
        counts.surveyByQ[q] = (counts.surveyByQ[q] || 0) + 1;
      }
    }
  }
  walk(photosRoot);
  return counts;
}

module.exports = {
  KNOWN_GOLDEN_VISITS,
  validateGoldenExport,
  listRawJsonFiles,
  loadRawBodies,
  photoSlotCounts,
};
