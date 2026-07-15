'use strict';

/**
 * Round-trip verification: golden export raw/*.json vs post-run re-export.
 * Classifies every leaf difference as EXPECTED (app intentionally wrote it)
 * or UNEXPECTED (defect). Photo comparison by count + slot, not bytes.
 */

const path = require('path');
const fs = require('fs');
const { loadRawBodies, photoSlotCounts, validateGoldenExport } = require('./golden-export');

/** Paths/keys the app is allowed/expected to change when it transmits. */
const EXPECTED_KEY_RE =
  /^(actual_start_time|actual_end_time|actual_start_date|actual_end_date|executed_datetime|time_change_reason|time_change_comment|total_work_time|work_time|break_time|no_show|spent_time|spent_time_reason|distance|duration|start_time|end_time|answer|answer_status|runid|completion_status|completed_on|completed_by|completed_by_email|comment|exception_id|time_modified|record_type|is_system_generated|start_location_type|end_location_type|home_to_store|store_to_store|store_to_home|calculate_mileage|te_approved|has_pending_records|check_billing_status|latest_activity|time_spent|category_completion|completed)$/i;

/** Always-volatile on re-export (server clocks, new media ids). */
const VOLATILE_KEY_RE =
  /^(time_modified|time_created|exportedAt|id|url|image|image_path|merged_image|original_image|thumbnail)$/i;

const PHOTO_URL_RE = /cloudfront\.net|\.(jpe?g|png|gif|webp)(\?|$)/i;

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function leafDiffs(golden, post, basePath = '', acc = []) {
  if (golden === post) return acc;
  if (typeof golden !== typeof post) {
    acc.push({ path: basePath || '(root)', golden, post, kind: 'type_mismatch' });
    return acc;
  }
  if (Array.isArray(golden) && Array.isArray(post)) {
    // Length diffs matter; element-wise for overlapping indices
    if (golden.length !== post.length) {
      acc.push({
        path: basePath || '(array)',
        golden: `length ${golden.length}`,
        post: `length ${post.length}`,
        kind: 'array_length',
      });
    }
    const n = Math.max(golden.length, post.length);
    for (let i = 0; i < n; i++) {
      if (i >= golden.length) {
        acc.push({ path: `${basePath}[${i}]`, golden: undefined, post: post[i], kind: 'added' });
      } else if (i >= post.length) {
        acc.push({ path: `${basePath}[${i}]`, golden: golden[i], post: undefined, kind: 'removed' });
      } else {
        leafDiffs(golden[i], post[i], `${basePath}[${i}]`, acc);
      }
    }
    return acc;
  }
  if (isPlainObject(golden) && isPlainObject(post)) {
    const keys = new Set([...Object.keys(golden), ...Object.keys(post)]);
    for (const k of keys) {
      const p = basePath ? `${basePath}.${k}` : k;
      if (!(k in golden)) {
        acc.push({ path: p, golden: undefined, post: post[k], kind: 'added' });
      } else if (!(k in post)) {
        acc.push({ path: p, golden: golden[k], post: undefined, kind: 'removed' });
      } else {
        leafDiffs(golden[k], post[k], p, acc);
      }
    }
    return acc;
  }
  // primitives (or non-matching structures already handled)
  if (JSON.stringify(golden) !== JSON.stringify(post)) {
    acc.push({ path: basePath || '(value)', golden, post, kind: 'value' });
  }
  return acc;
}

function lastKey(pathStr) {
  const m = String(pathStr).match(/([^.\[\]]+)$/);
  return m ? m[1] : pathStr;
}

/**
 * Build a set of path substrings / keys the transmitted payloads touched.
 */
function expectedHintsFromTransmitted(calls = []) {
  const hints = new Set();
  function walk(obj, prefix = '') {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${prefix}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      hints.add(k.toLowerCase());
      hints.add(p.toLowerCase());
      if (v && typeof v === 'object' && !v.base64) walk(v, p);
    }
  }
  for (const call of calls) {
    if (!call || call.method === 'GET') continue;
    if (call.payload) walk(call.payload);
    // endpoint family hints
    if (/shifts\//i.test(call.url || '')) {
      ['actual_start_time', 'actual_end_time', 'travel_records', 'time_change_reason', 'time_change_comment'].forEach(
        (h) => hints.add(h)
      );
    }
    if (/surveys\/answers/i.test(call.url || '')) {
      ['answer', 'runid', 'question', 'responder'].forEach((h) => hints.add(h));
    }
    if (/category-resets/i.test(call.url || '')) {
      ['before', 'after', 'completion_status', 'spent_time', 'spent_time_reason', 'team'].forEach((h) =>
        hints.add(h)
      );
    }
  }
  return hints;
}

function classifyDiff(diff, transmittedHints) {
  const key = lastKey(diff.path);
  const pathLower = String(diff.path).toLowerCase();

  // Photo/media URLs and ids always expected to differ on re-upload
  if (VOLATILE_KEY_RE.test(key)) return 'EXPECTED';
  if (typeof diff.golden === 'string' && PHOTO_URL_RE.test(diff.golden)) return 'EXPECTED';
  if (typeof diff.post === 'string' && PHOTO_URL_RE.test(diff.post)) return 'EXPECTED';
  if (/\.(url|images|image_path|answer_images)/i.test(diff.path)) return 'EXPECTED';

  if (EXPECTED_KEY_RE.test(key)) return 'EXPECTED';
  if (transmittedHints.has(key.toLowerCase())) return 'EXPECTED';

  // Path contains a transmitted field name as a segment
  for (const h of transmittedHints) {
    if (h.length > 2 && pathLower.includes(h)) return 'EXPECTED';
  }

  // array_length on images / travel_records often expected
  if (diff.kind === 'array_length' && /images|travel_records|answer_images|shift_breaks/i.test(diff.path)) {
    return 'EXPECTED';
  }

  return 'UNEXPECTED';
}

/**
 * Compare two export folders (golden vs post-run).
 * @param {string} goldenPath
 * @param {string} postPath
 * @param {Object} [opts]
 * @param {Array} [opts.transmittedCalls] - assembled/executed calls for EXPECTED hints
 */
function diffExports(goldenPath, postPath, opts = {}) {
  const goldenVal = validateGoldenExport(goldenPath);
  const postVal = validateGoldenExport(postPath);
  // Post-run may not re-pass identity checks the same way; require structure only
  const postStructural = {
    ok:
      fs.existsSync(path.join(path.resolve(postPath), 'raw')) &&
      fs.existsSync(path.join(path.resolve(postPath), 'manifest.json')),
    failures: [],
  };
  if (!fs.existsSync(path.join(path.resolve(postPath), 'raw'))) {
    postStructural.failures.push('post-run raw/ missing');
    postStructural.ok = false;
  }

  const result = {
    goldenPath: path.resolve(goldenPath),
    postPath: path.resolve(postPath),
    verdict: 'FAIL',
    expected: [],
    unexpected: [],
    photoComparison: null,
    filePairs: [],
    errors: [],
  };

  if (!goldenVal.ok) {
    result.errors.push(...goldenVal.failures.map((f) => `golden: ${f}`));
    return result;
  }
  if (!postStructural.ok) {
    result.errors.push(...postStructural.failures);
    return result;
  }

  const goldenBodies = loadRawBodies(goldenPath);
  const postBodies = loadRawBodies(postPath);
  const hints = expectedHintsFromTransmitted(opts.transmittedCalls || []);

  const allFiles = new Set([...Object.keys(goldenBodies), ...Object.keys(postBodies)]);
  for (const file of [...allFiles].sort()) {
    result.filePairs.push(file);
    if (!(file in goldenBodies)) {
      result.unexpected.push({
        path: `${file}`,
        golden: undefined,
        post: '(file present only post-run)',
        kind: 'file_added',
        classification: 'UNEXPECTED',
      });
      continue;
    }
    if (!(file in postBodies)) {
      result.unexpected.push({
        path: `${file}`,
        golden: '(file present only in golden)',
        post: undefined,
        kind: 'file_removed',
        classification: 'UNEXPECTED',
      });
      continue;
    }
    const diffs = leafDiffs(goldenBodies[file], postBodies[file], file);
    for (const d of diffs) {
      const classification = classifyDiff(d, hints);
      const row = { ...d, classification, file };
      if (classification === 'EXPECTED') result.expected.push(row);
      else result.unexpected.push(row);
    }
  }

  // Photos: count + slot only
  const gPhotos = photoSlotCounts(goldenPath);
  const pPhotos = photoSlotCounts(postPath);
  result.photoComparison = {
    golden: gPhotos,
    post: pPhotos,
    totalMatch: gPhotos.total === pPhotos.total,
    // Slot placement: category before/after + survey q folders present
    notes: [],
  };
  if (gPhotos.total !== pPhotos.total) {
    result.photoComparison.notes.push(
      `Total photo count golden=${gPhotos.total} post=${pPhotos.total} (bytes always differ; count may shift if re-upload adds/removes)`
    );
    // Count mismatch is EXPECTED if app re-uploaded (new set); flag only if post has zero and golden had some
    if (pPhotos.total === 0 && gPhotos.total > 0) {
      result.unexpected.push({
        path: 'photos/',
        golden: gPhotos.total,
        post: 0,
        kind: 'photo_count',
        classification: 'UNEXPECTED',
      });
    } else {
      result.expected.push({
        path: 'photos/ (count)',
        golden: gPhotos.total,
        post: pPhotos.total,
        kind: 'photo_count',
        classification: 'EXPECTED',
      });
    }
  } else {
    result.expected.push({
      path: 'photos/ (count)',
      golden: gPhotos.total,
      post: pPhotos.total,
      kind: 'photo_count',
      classification: 'EXPECTED',
    });
  }

  result.verdict = result.unexpected.length === 0 && result.errors.length === 0 ? 'PASS' : 'FAIL';
  return result;
}

function formatRoundtripReport(diffResult, meta = {}) {
  const lines = [];
  lines.push('# Round-trip verification report');
  lines.push('');
  lines.push(`Generated: ${meta.generatedAt || new Date().toISOString()}`);
  if (meta.dryRunId) lines.push(`Dry-run / live run: \`${meta.dryRunId}\``);
  if (meta.visitId) lines.push(`Visit: ${meta.visitId}`);
  if (meta.draftId) lines.push(`Draft: \`${meta.draftId}\``);
  lines.push(`Golden: \`${diffResult.goldenPath}\``);
  lines.push(`Post-run: \`${diffResult.postPath}\``);
  lines.push('');
  lines.push(`## Verdict: **${diffResult.verdict}**`);
  lines.push('');
  if (diffResult.errors?.length) {
    lines.push('### Errors');
    for (const e of diffResult.errors) lines.push(`- ${e}`);
    lines.push('');
  }
  lines.push(`### Unexpected diffs (defects) — ${diffResult.unexpected.length}`);
  if (!diffResult.unexpected.length) {
    lines.push('_None._');
  } else {
    for (const d of diffResult.unexpected.slice(0, 200)) {
      lines.push(
        `- **UNEXPECTED** \`${d.path}\` — golden: \`${fmt(d.golden)}\` → post: \`${fmt(d.post)}\` (${d.kind || 'value'})`
      );
    }
    if (diffResult.unexpected.length > 200) {
      lines.push(`- …and ${diffResult.unexpected.length - 200} more`);
    }
  }
  lines.push('');
  lines.push(`### Expected diffs (app wrote these) — ${diffResult.expected.length}`);
  if (!diffResult.expected.length) {
    lines.push('_None (exports identical at leaf level)._');
  } else {
    for (const d of diffResult.expected.slice(0, 100)) {
      lines.push(
        `- EXPECTED \`${d.path}\` — golden: \`${fmt(d.golden)}\` → post: \`${fmt(d.post)}\``
      );
    }
    if (diffResult.expected.length > 100) {
      lines.push(`- …and ${diffResult.expected.length - 100} more`);
    }
  }
  lines.push('');
  if (diffResult.photoComparison) {
    lines.push('### Photos (count + slot; bytes not compared)');
    lines.push(
      `- Golden total: ${diffResult.photoComparison.golden.total}; post total: ${diffResult.photoComparison.post.total}`
    );
    for (const n of diffResult.photoComparison.notes || []) lines.push(`- ${n}`);
  }
  lines.push('');
  lines.push('### Raw file pairs compared');
  for (const f of diffResult.filePairs || []) lines.push(`- ${f}`);
  lines.push('');
  return lines.join('\n');
}

function fmt(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

function writeRoundtripReport(runId, reportMd, liveStoreMod) {
  const liveStore = liveStoreMod || require('./live-store');
  const dir = liveStore.runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'roundtrip-report.md');
  fs.writeFileSync(file, reportMd, 'utf8');
  return file;
}

module.exports = {
  leafDiffs,
  classifyDiff,
  expectedHintsFromTransmitted,
  diffExports,
  formatRoundtripReport,
  writeRoundtripReport,
  EXPECTED_KEY_RE,
  VOLATILE_KEY_RE,
};
