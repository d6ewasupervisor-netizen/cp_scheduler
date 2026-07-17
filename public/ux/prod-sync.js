/**
 * Decide when an automatic SAS PROD week pull is worth the wait.
 * Manual "Resync from PROD" always bypasses this and forces a pull.
 *
 * Rules for auto:
 *  - Same week was auto/manual-synced in this browser tab within TTL → skip
 *  - Server says match is stale → pull
 *  - No schedule / never synced for the week → pull
 *  - lastSyncedAt older than STALE_MS → pull
 *  - Otherwise use local cached week (fast navigation)
 */

const STORAGE_KEY = 'cp_prod_sync_meta_v1';
/** Don't auto-hit PROD more than once per week per this window (session). */
const SESSION_TTL_MS = 8 * 60 * 1000; // 8 minutes
/** Server lastSyncedAt older than this → worth a quiet auto pull. */
const STALE_MS = 20 * 60 * 1000; // 20 minutes

function readMeta() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch {
    /* private mode */
  }
}

/**
 * Record that we successfully pulled PROD for this weekStart.
 * @param {string} weekStart
 */
export function markProdSynced(weekStart) {
  if (!weekStart) return;
  const meta = readMeta();
  meta[weekStart] = { at: Date.now() };
  writeMeta(meta);
}

/**
 * @param {string} weekStart
 * @param {{
 *   force?: boolean,
 *   matchStale?: boolean,
 *   hasSchedule?: boolean,
 *   lastSyncedAt?: string|null,
 *   shiftCount?: number|null,
 * }} [ctx]
 * @returns {{ should: boolean, reason: string }}
 */
export function shouldAutoSyncProd(weekStart, ctx = {}) {
  if (ctx.force) return { should: true, reason: 'manual' };
  if (!weekStart) return { should: false, reason: 'no-week' };

  if (ctx.matchStale === true) {
    return { should: true, reason: 'match-stale' };
  }

  if (ctx.hasSchedule === false) {
    return { should: true, reason: 'no-schedule' };
  }

  if (ctx.shiftCount === 0) {
    return { should: true, reason: 'empty-week' };
  }

  const meta = readMeta();
  const hit = meta[weekStart];
  if (hit?.at && Date.now() - hit.at < SESSION_TTL_MS) {
    return { should: false, reason: 'recent-session-sync' };
  }

  if (ctx.lastSyncedAt) {
    const t = new Date(ctx.lastSyncedAt).getTime();
    if (!Number.isNaN(t) && Date.now() - t < STALE_MS) {
      // Fresh enough on server — remember so sibling pages skip too
      markProdSynced(weekStart);
      return { should: false, reason: 'server-fresh' };
    }
    if (!Number.isNaN(t) && Date.now() - t >= STALE_MS) {
      return { should: true, reason: 'server-stale' };
    }
  }

  // First open this session with unknown freshness → one pull
  if (!hit?.at) {
    return { should: true, reason: 'first-session-open' };
  }

  return { should: false, reason: 'use-cache' };
}

/**
 * Convenience: boolean only.
 */
export function needsProdSync(weekStart, ctx = {}) {
  return shouldAutoSyncProd(weekStart, ctx).should;
}
