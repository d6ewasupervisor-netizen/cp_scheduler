'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProdVisitStatus, shiftRunStatus } = require('../src/lib/shift-run-status');

describe('normalizeProdVisitStatus', () => {
  it('maps SAS status strings', () => {
    assert.equal(normalizeProdVisitStatus('completed').key, 'completed');
    assert.equal(normalizeProdVisitStatus('Completed').key, 'completed');
    assert.equal(normalizeProdVisitStatus('in-progress').key, 'in_progress');
    assert.equal(normalizeProdVisitStatus('in_progress').key, 'in_progress');
    assert.equal(normalizeProdVisitStatus('Not started').key, 'not_started');
    assert.equal(normalizeProdVisitStatus('not-started').key, 'not_started');
    assert.equal(normalizeProdVisitStatus('active').key, 'in_progress');
    assert.equal(normalizeProdVisitStatus(null).key, 'unknown');
  });
});

describe('shiftRunStatus', () => {
  it('prefers PROD completed over sealed draft', () => {
    const s = shiftRunStatus({ visitStatus: 'completed', draftStatus: 'ready_for_prod' });
    assert.equal(s.key, 'completed');
    assert.equal(s.label, 'Completed');
  });

  it('prefers PROD in-progress over local draft', () => {
    const s = shiftRunStatus({ visitStatus: 'in-progress', draftStatus: 'in_progress' });
    assert.equal(s.key, 'in_progress');
    assert.equal(s.source, 'prod');
  });

  it('shows Already ran when sealed but PROD still open', () => {
    const s = shiftRunStatus({ visitStatus: 'Not started', draftStatus: 'ready_for_prod' });
    assert.equal(s.key, 'already_ran');
    assert.equal(s.label, 'Already ran');
  });

  it('shows In progress from local draft when PROD not started', () => {
    const s = shiftRunStatus({ visitStatus: 'Not started', draftStatus: 'in_progress' });
    assert.equal(s.key, 'in_progress');
    assert.equal(s.source, 'draft');
  });

  it('shows Not started from PROD', () => {
    const s = shiftRunStatus({ visitStatus: 'Not started' });
    assert.equal(s.key, 'not_started');
    assert.equal(s.label, 'Not started');
  });

  it('unknown when no PROD status and no draft', () => {
    const s = shiftRunStatus({});
    assert.equal(s.key, 'unknown');
  });
});
