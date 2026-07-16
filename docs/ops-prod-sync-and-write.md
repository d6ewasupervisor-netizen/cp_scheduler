# PROD sync, cycle refresh, and write-to-PROD

How Central Pet Shift Day stays aligned with SAS and when it writes.

## Two different “writes”

| Intent | What the app does | Gate |
|--------|-------------------|------|
| **Complete a visit** (times, photos, survey, mileage) | Assemble dry-run → live-executor field-app sequence | `LIVE_TRANSMIT=1` + allowlist + two-tap |
| **Change team schedule in cycle management** | **Not in-app.** Planning Desk handoff → skill `sas-prod-shift-management-har` / automator | Explicit human + skill dry-run |

Do not confuse field completion with scheduling CRUD. The app **reads** cycles for sync; schedule mutations stay in the skill/HAR path you already trust.

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
