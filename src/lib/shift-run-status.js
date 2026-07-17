'use strict';

/**
 * Normalize SAS PROD field-data current_status / shift.visitStatus values.
 * @param {string|null|undefined} visitStatus
 * @returns {{ key: string, label: string }}
 */
function normalizeProdVisitStatus(visitStatus) {
  const raw = String(visitStatus || '')
    .toLowerCase()
    .trim()
    .replace(/_/g, '-');
  if (!raw) return { key: 'unknown', label: 'Status unknown' };
  if (raw === 'completed' || raw === 'complete') {
    return { key: 'completed', label: 'Completed' };
  }
  if (raw === 'in-progress' || raw === 'in progress' || raw === 'active') {
    return { key: 'in_progress', label: 'In progress' };
  }
  if (raw === 'not started' || raw === 'not-started' || raw === 'scheduled') {
    return { key: 'not_started', label: 'Not started' };
  }
  if (raw === 'deleted') {
    return { key: 'deleted', label: 'Deleted' };
  }
  return { key: 'other', label: String(visitStatus) };
}

/**
 * Human-facing run status for calendar / dashboard (reps + admin).
 *
 * Priority:
 *  1. PROD completed → Completed (already ran in SAS)
 *  2. PROD in-progress → In progress
 *  3. Local sealed draft → Already ran (app work done; PROD may still open)
 *  4. Local in-progress draft → In progress
 *  5. PROD not started → Not started
 *  6. else → Status unknown
 *
 * @param {{ visitStatus?: string|null, draftStatus?: string|null }} opts
 */
function shiftRunStatus(opts = {}) {
  const { visitStatus = null, draftStatus = null } = opts;
  const prod = normalizeProdVisitStatus(visitStatus);

  if (prod.key === 'completed') {
    return {
      key: 'completed',
      label: 'Completed',
      source: 'prod',
      title: 'Shift completed in SAS PROD — already ran',
    };
  }
  if (prod.key === 'in_progress') {
    return {
      key: 'in_progress',
      label: 'In progress',
      source: 'prod',
      title: 'Shift in progress in SAS PROD — you can still finish photos, times, and seal in the app',
    };
  }
  if (draftStatus === 'ready_for_prod') {
    return {
      key: 'already_ran',
      label: 'Already ran',
      source: 'draft',
      title: 'Visit sealed in the app — already ran locally; PROD may still be open',
    };
  }
  if (draftStatus === 'in_progress') {
    return {
      key: 'in_progress',
      label: 'In progress',
      source: 'draft',
      title: 'Visit draft open in the app',
    };
  }
  if (prod.key === 'not_started') {
    return {
      key: 'not_started',
      label: 'Not started',
      source: 'prod',
      title: 'Not started in SAS PROD',
    };
  }
  if (prod.key === 'deleted') {
    return {
      key: 'deleted',
      label: 'Deleted',
      source: 'prod',
      title: 'Visit deleted in SAS PROD',
    };
  }
  if (prod.key === 'other') {
    return {
      key: 'other',
      label: prod.label,
      source: 'prod',
      title: `PROD status: ${prod.label}`,
    };
  }
  return {
    key: 'unknown',
    label: 'Status unknown',
    source: null,
    title: 'Resync from PROD to refresh shift status',
  };
}

module.exports = {
  normalizeProdVisitStatus,
  shiftRunStatus,
};
