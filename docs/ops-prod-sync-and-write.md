# PROD sync, cycle refresh, and write-to-PROD

How Central Pet Shift Day stays aligned with SAS and when it writes.

## SAS session sources (local vs Railway)

App users (magic-link / JWT) are **not** SAS tokens. All PROD GETs and LIVE field
writes use the **machine morning-auth session** (same as sas-retail-automator).

| Environment | How `loadSasSession()` gets `auth_token` + csrf + cookies |
|-------------|------------------------------------------------------------|
| **Local** | `http://127.0.0.1:7291/session` (sas-auth auth-server) or `C:/Users/tgaut/sas-auth/.sas-session/auth-state.json` |
| **Railway (cp_scheduler)** | `SAS_AUTH_SESSION_URL` → eod-api `GET /internal/sas-session/export` with `Authorization: Bearer SAS_AUTH_SECRET` |
| **Env fallback** | `SAS_TOKEN` (+ optional `SAS_CSRF_TOKEN` / `SAS_COOKIE_HEADER`) or full `SAS_AUTH_JSON` |

### Morning refresh path (keep session warm)

1. **eod-api in-process auto-refresh** (`sas-auto-refresh.js`) on Railway when `SAS_USER` / `SAS_PASS` / `SAS_TOTP_SECRET` are set — startup force refresh, 4h cooldown, lazy refresh on `/sas-auth-status` when stale, and on export when token missing.
2. **GitHub Actions** `sas-auth` `daily-auth.yml` → `morning-auth.js` → `POST /sas-session` to eod-api (also writes local auth-state for desktop tools).
3. **Heartbeat** in eod-api every ~4 minutes against notifications API; if dead, next lazy poll / export re-mints.

cp_scheduler **pulls** the live session from eod-api; it does not run Okta login itself.

### Railway vars (cp_scheduler) — names only

| Variable | Purpose |
|----------|---------|
| `SAS_AUTH_SESSION_URL` | e.g. `https://eod-api.the-dump-bin.com/internal/sas-session/export` |
| `SAS_AUTH_SECRET` | Same secret as eod-api / morning-auth Bearer |
| `SAS_SESSION_MAX_AGE_HOURS` | Optional; default 24; `0` disables age check |
| `SAS_AUTH_FETCH_TIMEOUT_MS` | Optional; default 8000 |

Sync helper: `scripts/railway-sync-auth-vars.py` copies JWT/DB/roles **and** the SAS bridge URL/secret from eod-api.

### Status + refresh endpoints (no secrets)

```http
GET  /api/central-pet/shift-day/sas-status
POST /api/central-pet/shift-day/sas-refresh?force=1
```

- **Status** returns `{ ok, healthy, state, label, source, generatedAt, ageMinutes, hasCsrf, hasCookie, bridge }` — never the token.
- **Refresh** proxies to eod-api `POST /api/trigger-auth?force=1` (in-process Okta/TOTP mint), then re-pulls the session export. Any signed-in user can call it.

### UI beacon (all pages)

Every surface (Dashboard, Shift Day, Planning Desk, My Week) shows a sticky **SAS PROD** beacon at the top:

| State | Meaning |
|-------|---------|
| **live** (green) | Export session healthy |
| **warn** (amber) | Session aging / incomplete |
| **down** (red) | Bridge or morning auth offline |

**Refresh auth** next to the beacon force-mints via eod-api and re-probes. Polls every 30s (like EOD connection dots). On recover, Shift Day / Dashboard auto re-sync the week.

On sync failure, UI falls back to last local week; error text points at the beacon when morning auth needs attention.

## Two different “writes”

| Intent | What the app does | Gate |
|--------|-------------------|------|
| **Complete a visit** (times, photos, survey, mileage) | Assemble dry-run → live-executor field-app sequence | `LIVE_TRANSMIT=1` + allowlist + two-tap |
| **Change visit day (schedule)** | Admin **Push day-moves to PROD** — copy visit to new date + soft-delete old | `LIVE_SCHEDULE_WRITE=1` + admin + two-tap confirm |
| **Build new visits / reassign lead / multi-project** | Still skill `sas-prod-shift-management-har` when needed | Explicit human + skill dry-run |

### Day-move → PROD (admin)

SAS **ignores** `scheduled_date` on PATCH/PUT of an existing visit (verified). The app therefore:

1. `POST /team-scheduling/visits/` on the target date (same cycle/store/team/times; +3 min retry on collision)
2. Copies active shifts (`POST /team-scheduling/shifts/`)
3. Copies store-field **notes** (391 → real store text)
4. Soft-deletes source shifts (`current_status: deleted`) and best-effort deletes source visit

| Surface | Control |
|---------|---------|
| **Planning Desk** | Preview day-moves → PROD · Apply day-moves to PROD |
| **API** | `POST /shift-day/push-schedule-to-prod` `{ weekStart, dryRun }` |
| **API** | `POST /shift-day/reschedule-visit` `{ visitId, toDate, dryRun }` |

Workflow:

1. **Sync week from PROD** so the board matches SAS.
2. On Shift Day (admin preview), move visit chips to the new day (local board).
3. **Preview day-moves → PROD** — lists local date ≠ PROD date.
4. **Apply day-moves to PROD** (two confirms) when `LIVE_SCHEDULE_WRITE=1`.
5. Auto re-sync after apply.

Blocked: completed / deleted / in-progress visits.

Railway: `LIVE_SCHEDULE_WRITE=1` on cp_scheduler (separate from `LIVE_TRANSMIT`).

## Sync week from PROD (cycle refresh) — mandatory for reps

**Any signed-in user** (rep or admin) can resync:

| Surface | Control |
|---------|---------|
| **Shift Day** (`/shiftday.html`) | **Resync from PROD** (primary) |
| **Admin** | **Sync week from PROD** |
| **API** | `POST /shift-day/sync-from-prod` |

```http
POST /api/central-pet/shift-day/sync-from-prod
{ "weekStart": "2026-07-12" }
```

`supervisorId` optional — server defaults to `SAS_SUPERVISOR_ID` / `CP_SCHEDULER_SUPERVISOR_ID` / `800175315`.

1. Resolves fiscal week bounds.  
2. Loads project **9293** field-data for the supervisor + date range.  
3. Per visit: store-field notes → `decodeD8Note` (391 trap → actual store).  
4. Maps employees via `d8-shift-reps` workday ids.  
5. Attaches cycle id/name from `project-cycles` when available.  
6. **Replaces** that week’s local shift-day board (`source: prod-sync`).  
7. Re-runs **matcher** and clears `matchStale`.

### Automatic resync (default)

| Event | Behavior |
|-------|----------|
| Open **Shift Day** or **Dashboard** | Auto `sync-from-prod` for the selected week, then load board |
| Change week (prev/next/select) | Auto resync that week |
| Manual **Resync from PROD** | Same pull, with full toast feedback |

If SAS is down, the app shows a warning and falls back to the last saved local week so reps are not blocked offline.

### When to tap manual Resync

- PROD schedule just changed while the app was already open  
- UI shows **MATCH STALE** after a local day-move  
- Before starting a visit if you want an extra fresh pull  
- Before dry-run / live arm for a field day  

## Write to PROD (field completion)

1. Sync + match the week.  
2. Rep seals visit in field UI (`ready_for_prod`).  
3. Admin dry-run with real time-change comment.  
4. Spot-check assembled calls (times, mileage CHANGE, spent-time, PUT complete).  
5. Arm: `LIVE_TRANSMIT=1`, one draft id in `live-allowlist.json`, restart if needed.  
6. Two-tap store confirm → Transmit.  
7. Disarm: LIVE off, clear allowlist.

Contract: `docs/sas-payload-contract.md` · checklist: `docs/live-first-run.md`.

## Field test playbook (today)

1. **Sync** current week from PROD.  
2. **Match** — zero ambiguous on the store you will test.  
3. Confirm visit **Not started** (or accept first-time path only).  
4. Capture in app (workspace + photo queue) → seal.  
5. Dry-run → LIVE for that one draft only.  
6. If partial: use execution log + resume; do not double-start.  

## Related skills (other repos)

| Skill | Use for |
|-------|---------|
| `sas-auth-prod-session` | Morning token for any SAS call |
| `sas-prod-shift-management-har` | Create/move/reassign visits & shifts in cycle |
| `sas-upload-category-after-photos` / SI skills | Photo recovery outside this app |
| `use-railway` | Deploy + `LIVE_TRANSMIT` env |

## Railway volume note

`data/visit-drafts` is on a volume. Week store is `data/shift-day-schedules.json` (deploy-local unless you mount it). After deploy, **re-run Sync from PROD** so production has the week board.
