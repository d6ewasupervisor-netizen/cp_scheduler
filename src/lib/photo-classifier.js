'use strict';

/**
 * After-photo → category sorter via Google Gemini Vision (REST).
 *
 * Model default: gemini-3.1-flash-lite — affordable multimodal; verified for new AI Studio keys.
 * Signup / API key: https://aistudio.google.com/apikey
 *
 * Env:
 *   GEMINI_API_KEY          required for live classify
 *   GEMINI_MODEL            optional override (default gemini-3.1-flash-lite)
 *   PHOTO_CLASSIFY_ENABLED  '0' to force-disable even when key is set
 */

const fs = require('fs');
const path = require('path');
const { CATEGORY_PHOTO_TARGETS } = require('./visit-flow');
const trainingStore = require('./photo-training-store');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const GEN_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

function isClassifyEnabled() {
  if (process.env.PHOTO_CLASSIFY_ENABLED === '0') return false;
  return !!process.env.GEMINI_API_KEY;
}

function geminiModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function filePart(absPath) {
  const data = fs.readFileSync(absPath);
  return {
    inlineData: {
      mimeType: mimeFromPath(absPath),
      data: data.toString('base64'),
    },
  };
}

function buildPrompt({ afterCount, fewShot }) {
  const labels = CATEGORY_PHOTO_TARGETS.map((c) => `- ${c.id}: ${c.label}`).join('\n');
  const fewShotNote = fewShot.length
    ? `You are shown ${fewShot.length} labeled TRAINING examples first (each tagged with its categoryId). Match the unlabeled AFTER photos to those visual patterns.`
    : `No training examples were uploaded yet — use the category descriptions carefully. Prefer aisle / fixture matches (endcaps at aisle ends, clip strips hanging, wing panels beside endcaps, cat litter pan liner bags/packs, Butcher Block wooden/metal treat rack, CP pet-care shelving sections).`;

  return `You sort Fred Meyer Central Pet (PET CARE SUPPLIES) after-service photos into survey/category buckets.

${fewShotNote}

Category ids (use these exact strings):
${labels}
- aisle-general: finished aisle / shelf run that is NOT specifically one of the fixtures above
- unknown: cannot tell

There are ${afterCount} unlabeled AFTER photos, numbered after-1 … after-${afterCount}.

Rules:
1. Every after photo must appear in assignments exactly once (primaryCategory).
2. A photo may also list secondaryCategories when multiple fixtures are clearly visible.
3. For each required category id, pick the single best afterSeq when possible (bestMatchByCategory).
4. Prefer high confidence only when the fixture is clearly visible (product + fixture type).
5. Respond with JSON ONLY — no markdown fences — matching this schema:
{
  "assignments": [
    { "afterSeq": 1, "primaryCategory": "endcaps", "secondaryCategories": [], "confidence": 0.92, "reason": "short" }
  ],
  "bestMatchByCategory": {
    "endcaps": 1,
    "clipstrips": 2,
    "wing-panels": 3,
    "cat-litter-pan-liners": 4,
    "butcher-block-rack": 5,
    "cp-serviced-section": 6
  }
}
Use null for bestMatchByCategory values when no photo clearly matches that category.`;
}

function extractJson(text) {
  if (!text) throw new Error('Empty model response');
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model response');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Classify a set of after photos (absolute paths + seq).
 * @param {Array<{seq:number, absPath:string}>} afterPhotos
 * @returns {Promise<object>}
 */
async function classifyAfterPhotoFiles(afterPhotos) {
  if (!isClassifyEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: 'GEMINI_API_KEY not set (or PHOTO_CLASSIFY_ENABLED=0)',
      signup: 'https://aistudio.google.com/apikey',
      model: geminiModel(),
    };
  }
  if (!afterPhotos?.length) {
    return { ok: false, skipped: true, reason: 'No after photos to classify' };
  }

  const fewShot = trainingStore.pickFewShotExamples(2);
  const parts = [];

  parts.push({ text: buildPrompt({ afterCount: afterPhotos.length, fewShot }) });

  for (const ex of fewShot) {
    parts.push({ text: `\nTRAINING EXAMPLE — categoryId=${ex.categoryId} (${CATEGORY_PHOTO_TARGETS.find((c) => c.id === ex.categoryId)?.label || ex.categoryId})${ex.notes ? ` — note: ${ex.notes}` : ''}` });
    parts.push(filePart(ex.absPath));
  }

  for (const photo of afterPhotos) {
    parts.push({ text: `\nUNLABELED AFTER PHOTO afterSeq=${photo.seq}` });
    parts.push(filePart(photo.absPath));
  }

  const model = geminiModel();
  const url = GEN_URL(model, process.env.GEMINI_API_KEY);
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      payload?.error?.message ||
      payload?.message ||
      `Gemini HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = 'GEMINI_ERROR';
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  const text =
    payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const parsed = extractJson(text);
  const normalized = normalizeClassification(parsed, afterPhotos.map((p) => p.seq));

  return {
    ok: true,
    skipped: false,
    model,
    fewShotCount: fewShot.length,
    training: trainingStore.trainingReadiness(),
    ...normalized,
    rawText: text.slice(0, 4000),
  };
}

function normalizeClassification(parsed, validSeqs) {
  const seqSet = new Set(validSeqs.map(Number));
  const assignments = [];
  for (const row of parsed.assignments || []) {
    const afterSeq = Number(row.afterSeq);
    if (!seqSet.has(afterSeq)) continue;
    const primary = String(row.primaryCategory || 'unknown');
    const secondary = Array.isArray(row.secondaryCategories)
      ? row.secondaryCategories.map(String).filter((id) => id && id !== primary)
      : [];
    assignments.push({
      afterSeq,
      primaryCategory: primary,
      secondaryCategories: secondary,
      confidence: Number(row.confidence) || 0,
      reason: row.reason ? String(row.reason).slice(0, 300) : '',
    });
  }

  const bestMatchByCategory = {};
  for (const cat of CATEGORY_PHOTO_TARGETS) {
    let seq = parsed.bestMatchByCategory?.[cat.id];
    if (seq == null || seq === '') {
      // Fallback: first assignment that claims this category
      const hit = assignments.find(
        (a) =>
          a.primaryCategory === cat.id ||
          (a.secondaryCategories || []).includes(cat.id)
      );
      seq = hit ? hit.afterSeq : null;
    } else {
      seq = Number(seq);
      if (!seqSet.has(seq)) seq = null;
    }
    bestMatchByCategory[cat.id] = seq;
  }

  return { assignments, bestMatchByCategory };
}

/**
 * Apply bestMatchByCategory onto a visit draft via assignCategoryFromAfter.
 * Clears prior AI-sourced assignments for those categories first (keeps manual if any without fromAfterSeq? — we replace all).
 */
function applyClassificationToDraft(visitDraftStore, repKey, date, actualStore, classification) {
  if (!classification?.bestMatchByCategory) {
    return visitDraftStore.getDraft(repKey, date, actualStore);
  }

  // Clear existing category assignments so AI sort is authoritative
  for (const cat of CATEGORY_PHOTO_TARGETS) {
    visitDraftStore.clearCategoryPhotos(repKey, date, actualStore, cat.id);
  }

  const applied = [];
  for (const cat of CATEGORY_PHOTO_TARGETS) {
    const afterSeq = classification.bestMatchByCategory[cat.id];
    if (afterSeq == null) continue;
    try {
      visitDraftStore.assignCategoryFromAfter(repKey, date, actualStore, cat.id, { afterSeq });
      applied.push({ categoryId: cat.id, afterSeq });
    } catch (err) {
      applied.push({ categoryId: cat.id, afterSeq, error: err.message });
    }
  }

  return visitDraftStore.setPhotoClassification(repKey, date, actualStore, {
    at: new Date().toISOString(),
    model: classification.model || geminiModel(),
    fewShotCount: classification.fewShotCount || 0,
    bestMatchByCategory: classification.bestMatchByCategory,
    assignments: classification.assignments || [],
    applied,
  });
}

/**
 * End-to-end: resolve after photo files on disk, classify, apply to draft.
 */
async function classifyAndApplyVisit(visitDraftStore, repKey, date, actualStore) {
  const draft = visitDraftStore.getDraft(repKey, date, actualStore);
  if (!draft) throw Object.assign(new Error('No visit draft'), { code: 'NO_DRAFT' });
  if (draft.status === 'ready_for_prod') {
    throw Object.assign(new Error('Visit already sealed'), { code: 'SEALED' });
  }

  const afters = draft.afterPhotos || [];
  const files = [];
  for (const p of afters) {
    const resolved = visitDraftStore.resolvePhotoFile(repKey, date, actualStore, p.path);
    if (resolved) files.push({ seq: p.seq, absPath: resolved.absPath });
  }

  const classification = await classifyAfterPhotoFiles(files);
  if (classification.skipped) {
    return {
      draft: visitDraftStore.enrichDraftForUi(draft),
      classification,
    };
  }

  const updated = applyClassificationToDraft(
    visitDraftStore,
    repKey,
    date,
    actualStore,
    classification
  );
  return {
    draft: visitDraftStore.enrichDraftForUi(updated),
    classification: {
      ok: true,
      model: classification.model,
      fewShotCount: classification.fewShotCount,
      bestMatchByCategory: classification.bestMatchByCategory,
      assignments: classification.assignments,
      training: classification.training,
    },
  };
}

module.exports = {
  DEFAULT_MODEL,
  isClassifyEnabled,
  geminiModel,
  classifyAfterPhotoFiles,
  applyClassificationToDraft,
  classifyAndApplyVisit,
  normalizeClassification,
};
