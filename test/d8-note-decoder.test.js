'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decodeD8Note } = require('../src/lib/d8-note-decoder');

const NOTE_215 =
  '***WRITE ORDER*** THIS IS FOR STORE 215 -\nDELIVERED YESTERDAY(MONDAY)/WORK LOAD/PICKS TUESDAY(TODAY)***WRITE ORDER***';

const NOTE_31_NO_WRITE =
  '***DO NOT WRITE ORDER*** THIS IS FOR STORE 31 - WORK LOAD ONLY / PICKS FRIDAY***DO NOT WRITE ORDER***';

describe('decodeD8Note', () => {
  it('decodes live HAR note: 391 placeholder → 215', () => {
    const d = decodeD8Note(NOTE_215, 391);
    assert.equal(d.actualStore, 215);
    assert.equal(d.scheduledStore, 391);
    assert.equal(d.redirected, true);
    assert.equal(d.writeOrder, true);
    assert.equal(d.workLoad, true);
    assert.equal(d.picksDay, 'Tue');
    assert.match(d.delivery, /YESTERDAY/i);
  });

  it('handles DO NOT WRITE ORDER + spacing variance', () => {
    const d = decodeD8Note(NOTE_31_NO_WRITE, 391);
    assert.equal(d.actualStore, 31);
    assert.equal(d.writeOrder, false);
    assert.equal(d.workLoad, true);
    assert.equal(d.picksDay, 'Fri');
  });

  it('falls back to scheduled store when no THIS IS FOR STORE marker', () => {
    const d = decodeD8Note('***WRITE ORDER*** routine service***WRITE ORDER***', 53);
    assert.equal(d.actualStore, 53);
    assert.equal(d.redirected, false);
    assert.equal(d.writeOrder, true);
  });

  it('tolerates case and missing asterisks', () => {
    const d = decodeD8Note('this is for store 28 - work load / picks wed', 391);
    assert.equal(d.actualStore, 28);
    assert.equal(d.workLoad, true);
    assert.equal(d.picksDay, 'Wed');
  });
});
