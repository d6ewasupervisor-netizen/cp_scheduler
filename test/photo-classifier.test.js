'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeClassification, isClassifyEnabled, geminiModel } = require('../src/lib/photo-classifier');
const training = require('../src/lib/photo-training-store');

describe('photo-classifier normalize', () => {
  it('maps bestMatchByCategory and drops invalid seqs', () => {
    const out = normalizeClassification(
      {
        assignments: [
          { afterSeq: 1, primaryCategory: 'endcaps', secondaryCategories: [], confidence: 0.9 },
          { afterSeq: 99, primaryCategory: 'clipstrips', confidence: 0.5 },
        ],
        bestMatchByCategory: {
          endcaps: 1,
          clipstrips: 99,
          'wing-panels': null,
          'cat-litter-pan-liners': 1,
          'butcher-block-rack': null,
          'cp-serviced-section': 2,
        },
      },
      [1, 2]
    );
    assert.equal(out.assignments.length, 1);
    assert.equal(out.bestMatchByCategory.endcaps, 1);
    assert.equal(out.bestMatchByCategory.clipstrips, null); // 99 invalid
    assert.equal(out.bestMatchByCategory['cp-serviced-section'], 2);
  });

  it('falls back to assignment primary when bestMatch missing', () => {
    const out = normalizeClassification(
      {
        assignments: [{ afterSeq: 3, primaryCategory: 'butcher-block-rack', confidence: 0.8 }],
        bestMatchByCategory: {},
      },
      [3]
    );
    assert.equal(out.bestMatchByCategory['butcher-block-rack'], 3);
  });
});

describe('photo-classifier config', () => {
  it('reports disabled without GEMINI_API_KEY', () => {
    const prev = process.env.GEMINI_API_KEY;
    const prevEn = process.env.PHOTO_CLASSIFY_ENABLED;
    delete process.env.GEMINI_API_KEY;
    delete process.env.PHOTO_CLASSIFY_ENABLED;
    assert.equal(isClassifyEnabled(), false);
    assert.ok(geminiModel());
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    if (prevEn !== undefined) process.env.PHOTO_CLASSIFY_ENABLED = prevEn;
  });
});

describe('photo-training-store readiness', () => {
  it('reports short categories when corpus empty', () => {
    const r = training.trainingReadiness();
    assert.equal(typeof r.ready, 'boolean');
    assert.ok(r.minUsefulPerCategory >= 1);
    assert.ok(Array.isArray(r.shortCategories));
  });
});
