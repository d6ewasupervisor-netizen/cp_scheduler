'use strict';

/**
 * Stage 4 orchestrator — ties sealed drafts + visit-matcher + transmitVisit +
 * dryrun-store together for the Planning Desk "Dry Run" action. No prod writes;
 * matchVisits/transmitVisit only ever read.
 */

const path = require('path');
const crypto = require('crypto');
const draftStore = require('./visit-draft-store');
const { matchVisits } = require('./visit-matcher');
const { transmitVisit } = require('./prod-transmitter');
const dryrunStore = require('./dryrun-store');

function generateRunId(now = new Date()) {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

function findMatch(matchResult, summary) {
  const sameShift = (m) =>
    m.appShift.repKey === summary.repKey &&
    m.appShift.date === summary.date &&
    Number(m.appShift.actualStore) === Number(summary.actualStore);

  const matched = matchResult.matched.find(sameShift);
  if (matched) return { kind: 'matched', entry: matched };
  if (matchResult.ambiguous.some(sameShift)) return { kind: 'ambiguous', entry: null };
  if (matchResult.unmatched.some(sameShift)) return { kind: 'unmatched', entry: null };
  return { kind: 'not_in_matcher_scope', entry: null };
}

/**
 * @param {Object} params
 * @param {string} params.startDate YYYY-MM-DD
 * @param {string} params.endDate YYYY-MM-DD
 * @param {string} [params.weekStart]
 * @param {string|number} params.supervisorId
 * @param {string[]|null} [params.repKeys] null = every rep with sealed drafts in range
 * @param {Object} [params.transmitOpts] forwarded to transmitVisit's opts
 * @param {string} [params.runId]
 */
async function runDryRun({
  startDate,
  endDate,
  weekStart,
  supervisorId,
  repKeys = null,
  transmitOpts = {},
  runId = generateRunId(),
  matchVisitsFn = matchVisits,
  transmitVisitFn = transmitVisit,
  listAllDraftsFn = draftStore.listAllDrafts,
  getDraftFn = draftStore.getDraft,
} = {}) {
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');
  if (supervisorId == null || supervisorId === '') throw new Error('supervisorId is required');

  const eligible = listAllDraftsFn().filter(
    (d) =>
      d.status === 'ready_for_prod' &&
      d.date >= startDate &&
      d.date <= endDate &&
      (!repKeys || repKeys.includes(d.repKey))
  );

  const matchResult = await matchVisitsFn({ startDate, endDate, supervisorId, weekStart: weekStart || startDate });

  const visits = [];
  const aborted = [];

  for (const summary of eligible) {
    const sealedRecord = getDraftFn(summary.repKey, summary.date, summary.actualStore);
    if (!sealedRecord) {
      aborted.push({ repKey: summary.repKey, date: summary.date, store: summary.actualStore, reason: 'draft_file_missing' });
      continue;
    }

    const { kind, entry } = findMatch(matchResult, summary);
    if (kind !== 'matched') {
      aborted.push({ repKey: summary.repKey, date: summary.date, store: summary.actualStore, reason: kind });
      continue;
    }

    const assembled = await transmitVisitFn({ sealedRecord, matchedVisit: entry, opts: transmitOpts });
    if (assembled.status !== 'ok') {
      aborted.push({
        repKey: summary.repKey,
        date: summary.date,
        store: summary.actualStore,
        reason: assembled.abortReason,
      });
      continue;
    }

    const file = dryrunStore.writeVisitFile(runId, {
      repKey: summary.repKey,
      date: summary.date,
      store: summary.actualStore,
      assembled,
    });

    visits.push({
      repKey: summary.repKey,
      date: summary.date,
      store: summary.actualStore,
      visitId: assembled.visitId,
      callCount: assembled.callCount,
      photoCounts: assembled.photoCounts,
      file: path.basename(file),
    });
  }

  const manifest = {
    runId,
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    weekStart: weekStart || startDate,
    supervisorId: String(supervisorId),
    visits,
    aborted,
    summary: {
      eligible: eligible.length,
      assembled: visits.length,
      aborted: aborted.length,
    },
  };
  dryrunStore.writeManifest(runId, manifest);
  return manifest;
}

module.exports = { runDryRun, generateRunId };
