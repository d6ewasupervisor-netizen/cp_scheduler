/**
 * Persistent field schedule cache (IndexedDB) + hourly quiet refresh.
 *
 * Goal: Shift Day ↔ Schedule navigation paints instantly from the last good
 * week payload; PROD is only hit when stale (~1h) or the rep taps Refresh/Resync.
 */

import {
  getCachedSchedule,
  putCachedSchedule,
  getCachedWeeks,
  putCachedWeeks,
  getCachedReps,
  putCachedReps,
  getCachedDrafts,
  putCachedDrafts,
  getCachedMatch,
  putCachedMatch,
} from '/ux/offline-store.js';
import { needsProdSync, markProdSynced } from '/ux/prod-sync.js';

const HOUR_MS = 60 * 60 * 1000;
const SW_PATH = '/sw.js';

export {
  getCachedSchedule,
  putCachedSchedule,
  getCachedWeeks,
  putCachedWeeks,
  getCachedReps,
  putCachedReps,
  getCachedDrafts,
  putCachedDrafts,
  getCachedMatch,
  putCachedMatch,
};

/**
 * Warm IDB for the active rep/week without showing busy UI.
 * @param {{ api: Function, repKey: string, weekStart?: string|null }} opts
 */
export async function preloadFieldData({ api, repKey, weekStart = null } = {}) {
  if (!api || !repKey) return null;
  try {
    let weeks = await getCachedWeeks();
    if (!weeks?.length) {
      weeks = await api('/shift-day/weeks');
      await putCachedWeeks(weeks);
    }
    const today = new Date().toISOString().slice(0, 10);
    const week =
      (weekStart && weeks.find((w) => w.start === weekStart)) ||
      weeks.find((w) => w.start <= today && today <= w.end) ||
      weeks[0];
    if (!week) return { weeks };

    let schedule = await getCachedSchedule(repKey, week.start);
    if (!schedule) {
      schedule = await api(
        `/shift-day/schedule?rep=${encodeURIComponent(repKey)}&weekStart=${encodeURIComponent(week.start)}`
      );
      await putCachedSchedule(repKey, week.start, schedule);
    }

    try {
      const drafts = await api(`/shift-day/visit/mine?rep=${encodeURIComponent(repKey)}`);
      await putCachedDrafts(repKey, drafts || []);
    } catch {
      /* drafts optional during preload */
    }

    return { weeks, week, schedule };
  } catch (err) {
    console.warn('[schedule-cache] preload failed', err?.message || err);
    return null;
  }
}

/**
 * Background refresh loop — confirm no changes hourly; sync PROD when stale.
 * @param {{
 *   getRepKey: () => string|null,
 *   getWeekStart: () => string|null,
 *   api: Function,
 *   onUpdated?: (payload: { schedule?: object, drafts?: object, synced?: boolean }) => void,
 * }} opts
 */
export function startScheduleWarmth(opts) {
  if (typeof window === 'undefined') return () => {};
  if (window.__cpScheduleWarmthStarted) return window.__cpScheduleWarmthStop || (() => {});
  window.__cpScheduleWarmthStarted = true;

  let timer = null;
  let inFlight = null;

  async function tick({ forceProd = false } = {}) {
    if (document.visibilityState === 'hidden') return;
    const repKey = opts.getRepKey?.();
    const weekStart = opts.getWeekStart?.();
    const api = opts.api;
    if (!repKey || !weekStart || !api) return;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        let schedule = null;
        try {
          schedule = await api(
            `/shift-day/schedule?rep=${encodeURIComponent(repKey)}&weekStart=${encodeURIComponent(weekStart)}`
          );
        } catch {
          return;
        }

        const shouldSync =
          forceProd ||
          needsProdSync(weekStart, {
            matchStale: !!schedule?.matchStale,
            hasSchedule: !!(schedule?.shifts?.length || schedule?.source),
            lastSyncedAt: schedule?.lastSyncedAt || null,
            shiftCount: schedule?.shifts?.length ?? null,
          });

        let synced = false;
        if (shouldSync) {
          try {
            await api('/shift-day/sync-from-prod', {
              method: 'POST',
              body: JSON.stringify({ weekStart }),
            });
            markProdSynced(weekStart);
            synced = true;
            schedule = await api(
              `/shift-day/schedule?rep=${encodeURIComponent(repKey)}&weekStart=${encodeURIComponent(weekStart)}`
            );
          } catch (err) {
            console.warn('[schedule-cache] hourly PROD sync skipped', err?.message || err);
          }
        } else if (schedule?.lastSyncedAt) {
          markProdSynced(weekStart);
        }

        if (schedule) await putCachedSchedule(repKey, weekStart, schedule);

        let drafts = null;
        try {
          drafts = await api(`/shift-day/visit/mine?rep=${encodeURIComponent(repKey)}`);
          await putCachedDrafts(repKey, drafts || []);
        } catch {
          /* ignore */
        }

        try {
          const weeks = await api('/shift-day/weeks');
          await putCachedWeeks(weeks);
        } catch {
          /* ignore */
        }

        opts.onUpdated?.({ schedule, drafts, synced });
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  timer = setInterval(() => tick(), HOUR_MS);
  const onVis = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVis);

  // First quiet check a few seconds after mount (lets the page paint from IDB first).
  setTimeout(() => tick(), 4000);

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVis);
    window.__cpScheduleWarmthStarted = false;
  };
  window.__cpScheduleWarmthStop = stop;
  return stop;
}

/** Register the shell service worker (asset cache + faster return visits). */
export async function registerAppServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
    // Ask SW to refresh its shell cache when a new worker takes over.
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          sw.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
    return reg;
  } catch (err) {
    console.warn('[schedule-cache] SW register failed', err?.message || err);
    return null;
  }
}
