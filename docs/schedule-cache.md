# Field schedule cache & preload

Reps bounce between **Shift Day** and **Schedule**. Full page loads used to wait on weeks + schedule (+ occasional PROD sync) every time.

## What we cache

| Layer | Where | Contents |
|-------|--------|----------|
| IndexedDB | `cp_offline_v1` stores `schedules`, `weeks`, `reps`, `drafts`, `match` | Last good payloads per rep/week |
| Session | `prod-sync.js` | Skip auto-PROD for ~55 minutes after a sync |
| Service worker | `public/sw.js` | App shell (HTML/JS/CSS/cat GIFs) — **not** API data |

## Behaviour

1. **Paint from IDB first** — calendar/board appears immediately when a prior visit cached the week.
2. **Quiet network refresh** — fetch server schedule; PROD sync only if stale (~1 hour), match-stale, empty, or manual Refresh/Resync.
3. **Hourly warmth** — `startScheduleWarmth()` on Shift Day + Schedule confirms data and syncs PROD when needed (also on tab focus).
4. **Buffering cat** — still shows on page load; once visible it stays at least ~480ms even on cache hits.
5. **Shell SW** — faster return visits to HTML/JS after the first load.

## Manual overrides

- **Refresh** (Shift Day) — force SAS auth refresh + PROD pull.
- **Resync from PROD** — force week pull regardless of TTL.

## Code

- `public/ux/offline-store.js` — IDB helpers  
- `public/ux/schedule-cache.js` — preload + hourly loop + SW register  
- `public/ux/prod-sync.js` — auto-sync TTLs  
- `public/ux/buffering.js` — min visible cat flash  
- `public/sw.js` — shell cache  
