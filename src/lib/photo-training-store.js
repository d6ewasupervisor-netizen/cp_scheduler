'use strict';

/**
 * Labeled example corpus for after-photo → category sorting (Gemini few-shot).
 * Admin uploads only; never written to Auston OneDrive.
 *
 * Durable root: data/visit-drafts/photo-training/
 * On Railway that path is the mounted volume, so examples survive redeploys.
 * Legacy ephemeral path data/photo-training/ is migrated once if present.
 */

const fs = require('fs');
const path = require('path');
const { CATEGORY_PHOTO_TARGETS } = require('./visit-flow');

const REPO_ROOT = path.join(__dirname, '../..');
const LEGACY_ROOT = path.join(REPO_ROOT, 'data/photo-training');
const LEGACY_PREFIX = 'data/photo-training/';
const DURABLE_PREFIX = 'data/visit-drafts/photo-training/';

function resolveTrainingRoot() {
  if (process.env.PHOTO_TRAINING_ROOT) return process.env.PHOTO_TRAINING_ROOT;
  // Prefer the Railway volume mount (visit-drafts) everywhere so local + prod match.
  return path.join(REPO_ROOT, 'data/visit-drafts/photo-training');
}

const ROOT = resolveTrainingRoot();
const MANIFEST = path.join(ROOT, 'manifest.json');

const VALID_IDS = new Set(CATEGORY_PHOTO_TARGETS.map((c) => c.id));

let migratedLegacy = false;

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** One-time move from ephemeral data/photo-training → durable volume path. */
function migrateLegacyCorpusIfNeeded() {
  if (migratedLegacy) return;
  migratedLegacy = true;
  try {
    if (!fs.existsSync(LEGACY_ROOT)) return;
    const legacyManifestPath = path.join(LEGACY_ROOT, 'manifest.json');
    if (!fs.existsSync(legacyManifestPath)) return;

    let legacy;
    try {
      legacy = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf8'));
    } catch {
      return;
    }
    const legacyCount = (legacy.examples || []).length;
    if (!legacyCount) return;

    let durableCount = 0;
    if (fs.existsSync(MANIFEST)) {
      try {
        durableCount = (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).examples || []).length;
      } catch {
        durableCount = 0;
      }
    }
    // Only auto-migrate when durable store is empty — never clobber newer volume data.
    if (durableCount > 0) return;

    copyRecursive(LEGACY_ROOT, ROOT);
    if (!fs.existsSync(MANIFEST)) return;
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    m.examples = (m.examples || []).map((ex) => ({
      ...ex,
      path: String(ex.path || '').startsWith(LEGACY_PREFIX)
        ? DURABLE_PREFIX + String(ex.path).slice(LEGACY_PREFIX.length)
        : ex.path,
    }));
    m.updatedAt = new Date().toISOString();
    m.migratedFrom = 'data/photo-training';
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
    console.log(
      `[photo-training] migrated ${legacyCount} example(s) to durable volume path ${DURABLE_PREFIX}`
    );
  } catch (err) {
    console.warn('[photo-training] legacy migrate skipped:', err.message);
  }
}

function ensureRoot() {
  migrateLegacyCorpusIfNeeded();
  fs.mkdirSync(ROOT, { recursive: true });
  if (!fs.existsSync(MANIFEST)) {
    writeManifest({ version: 1, updatedAt: null, examples: [] });
  }
}

function readManifest() {
  ensureRoot();
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return { version: 1, updatedAt: null, examples: [] };
  }
}

function writeManifest(manifest) {
  ensureRoot();
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  return manifest;
}

function categoryDir(categoryId) {
  return path.join(ROOT, categoryId);
}

function listExamples({ categoryId } = {}) {
  const manifest = readManifest();
  let examples = manifest.examples || [];
  if (categoryId) {
    if (!VALID_IDS.has(categoryId)) throw new Error(`Unknown categoryId: ${categoryId}`);
    examples = examples.filter((e) => e.categoryId === categoryId);
  }
  return {
    categories: CATEGORY_PHOTO_TARGETS,
    counts: Object.fromEntries(
      CATEGORY_PHOTO_TARGETS.map((c) => [
        c.id,
        (manifest.examples || []).filter((e) => e.categoryId === c.id).length,
      ])
    ),
    examples,
    recommendedPerCategory: 5,
    minUsefulPerCategory: 3,
    storageRoot: DURABLE_PREFIX,
  };
}

/**
 * Add a labeled training image.
 * @returns {{ example: object, counts: object }}
 */
function addExample({ categoryId, buffer, originalName, notes = '', mimeType = 'image/jpeg' }) {
  if (!VALID_IDS.has(categoryId)) throw new Error(`Unknown categoryId: ${categoryId}`);
  if (!buffer?.length) throw new Error('image buffer required');

  ensureRoot();
  const dir = categoryDir(categoryId);
  fs.mkdirSync(dir, { recursive: true });

  const ext = extFromMimeOrName(mimeType, originalName);
  const id = `ex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${id}.${ext}`;
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, buffer);

  const relPath = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
  const example = {
    id,
    categoryId,
    path: relPath,
    filename,
    mimeType: mimeType || 'image/jpeg',
    notes: notes ? String(notes).slice(0, 500) : '',
    originalName: originalName ? String(originalName).slice(0, 200) : null,
    createdAt: new Date().toISOString(),
  };

  const manifest = readManifest();
  manifest.examples = manifest.examples || [];
  manifest.examples.push(example);
  writeManifest(manifest);

  const listed = listExamples();
  return { example, counts: listed.counts };
}

function removeExample(exampleId) {
  if (!exampleId) throw new Error('exampleId required');
  const manifest = readManifest();
  const idx = (manifest.examples || []).findIndex((e) => e.id === exampleId);
  if (idx === -1) throw new Error(`Example not found: ${exampleId}`);
  const [removed] = manifest.examples.splice(idx, 1);
  writeManifest(manifest);

  const abs = path.resolve(REPO_ROOT, removed.path);
  const rootAbs = path.resolve(ROOT);
  if (abs.startsWith(rootAbs) && fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs);
    } catch {
      /* best-effort */
    }
  }
  return { removed, counts: listExamples().counts };
}

function resolveExampleFile(exampleId) {
  const manifest = readManifest();
  const example = (manifest.examples || []).find((e) => e.id === exampleId);
  if (!example) return null;
  const abs = path.resolve(REPO_ROOT, example.path);
  const rootAbs = path.resolve(ROOT);
  if (!abs.startsWith(rootAbs) || !fs.existsSync(abs)) return null;
  return { absPath: abs, example };
}

/** Pick up to `perCategory` newest examples per category for few-shot prompts. */
function pickFewShotExamples(perCategory = 2) {
  const manifest = readManifest();
  const byCat = new Map();
  for (const c of CATEGORY_PHOTO_TARGETS) byCat.set(c.id, []);
  for (const ex of manifest.examples || []) {
    if (!byCat.has(ex.categoryId)) continue;
    byCat.get(ex.categoryId).push(ex);
  }
  const picked = [];
  for (const [categoryId, arr] of byCat) {
    arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const ex of arr.slice(0, perCategory)) {
      const resolved = resolveExampleFile(ex.id);
      if (resolved) picked.push({ ...ex, absPath: resolved.absPath });
    }
  }
  return picked;
}

function trainingReadiness() {
  const { counts, recommendedPerCategory, minUsefulPerCategory } = listExamples();
  const short = CATEGORY_PHOTO_TARGETS.filter((c) => (counts[c.id] || 0) < minUsefulPerCategory);
  const ready = short.length === 0;
  return {
    ready,
    counts,
    recommendedPerCategory,
    minUsefulPerCategory,
    shortCategories: short.map((c) => ({ id: c.id, label: c.label, have: counts[c.id] || 0 })),
    message: ready
      ? `Training corpus meets minimum (${minUsefulPerCategory}+ per category).`
      : `Add more examples — need ${minUsefulPerCategory}+ labeled photos for: ${short
          .map((c) => c.label)
          .join(', ')}.`,
    storageRoot: DURABLE_PREFIX,
  };
}

function extFromMimeOrName(mimeType, originalName) {
  const fromName = originalName && path.extname(originalName).replace(/^\./, '').toLowerCase();
  if (fromName && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(fromName)) {
    return fromName === 'jpeg' ? 'jpg' : fromName;
  }
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
}

module.exports = {
  ROOT,
  LEGACY_ROOT,
  listExamples,
  addExample,
  removeExample,
  resolveExampleFile,
  pickFewShotExamples,
  trainingReadiness,
  VALID_IDS,
};
