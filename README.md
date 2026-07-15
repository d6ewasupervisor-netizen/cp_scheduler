# cp_scheduler

Central Pet **Master Route** weekly scheduler for Fred Meyer D1/D8 reps (project **9293**).

Phase 1 is **planning-only**: drag-and-drop visit cards onto valid days per Master Route pick/delivery rules, save drafts, approve weeks, and export human review + agent handoff bundles. No SAS PROD mutations.

## Features

- Parse **BY STORE** sheet from Master Route Excel into JSON
- Constraint engine (two-visit, single-visit, blank pick/delivery scenarios)
- Dark-theme weekly calendar with draggable store chits
- Invalid drops blocked with allowed-day tooltips
- Patricia Marks override (inherits Carr + Preston stores)
- Read-only PROD overlay (requires local `sas-auth` session)
- **Approve week** → Markdown + JSON handoff for agent execution
- Download zip: `schedule-handoff.md`, `schedule-handoff.json`, `schedule-review.html`

## Quick start

```bash
cd cp_scheduler
npm install
npm run parse-master-route "C:\Users\tgaut\Downloads\MASTER ROUTE 05-22-2026 (1).xlsx"
npm test
npm start
```

Open http://127.0.0.1:3847

**Mobile:** Days swipe horizontally with snap scrolling. Controls stack full-width, touch targets are 48px+, and each visit card has a **Move to** day picker (drag-and-drop is desktop-only on admin).

**Production (Railway):** https://cpscheduler-production.up.railway.app

**GitHub:** https://github.com/d6ewasupervisor-netizen/cp_scheduler

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/central-pet/weeks` | Fiscal weeks |
| GET | `/api/central-pet/reps?district=1` | Rep roster + visit slots |
| POST | `/api/central-pet/schedule/validate` | Validate placements |
| GET/POST | `/api/central-pet/schedule/draft` | Save/load drafts |
| GET | `/api/central-pet/schedule/prod` | Read-only PROD overlay |
| POST | `/api/central-pet/schedule/approve` | Approve + generate handoff |
| GET | `/api/central-pet/schedule/handoff/:id` | Markdown + JSON |
| GET | `/api/central-pet/schedule/export/:id?format=handoff` | Zip bundle |

## Railway

Uses `Procfile` (`web: node src/server.js`). Set `PORT` automatically on Railway.

### Auth (shared with eod-api / The Dump Bin)

Uses the same magic-link session JWT and Postgres `allowed_emails` table as **eod-api**. Sign-in and access requests go through eod-api; cp_scheduler verifies the session locally.

Required env (match eod-api values):

| Variable | Purpose |
|----------|---------|
| `AUTH_MODE` | `session` |
| `JWT_SECRET` | Same secret as eod-api |
| `DATABASE_URL` | Same Postgres as eod-api (allowlist) |
| `PGSSL` | `require` on Railway if needed |

Optional:

| Variable | Purpose |
|----------|---------|
| `CP_SCHEDULER_ADMIN_EMAILS` | Full admin layer (default: Tyson work + d6ewa.supervisor + tgauthier2011) |
| `CP_SCHEDULER_REP_EMAILS` | Rep layer only (D8 field emails + Patricia). **Admin list wins** if both match. |
| `CP_SCHEDULER_PUBLIC_URL` | Public origin for magic-link returnTo |
| `CP_SCHEDULER_AUTH_SKIP` | `1` on localhost only — bypass auth for dev |
| `EOD_API_BASE_URL` | Default `https://eod-api.the-dump-bin.com` |
| `FRONTEND_BASE_URL` | Dump Bin hub (`https://the-dump-bin.com`) for open-sign-in wrap |
| `DATABASE_PATH` | JSON draft store (default `data/schedule-drafts.json`) |
| `SAS_AUTH_STATE` | Path to sas-auth token for PROD overlay |

Also add the cp_scheduler origin to eod-api `ALLOWED_ORIGINS` if browsers call eod-api directly from sign-in (already includes `https://cpscheduler-production.up.railway.app` when synced via `scripts/railway-sync-auth-vars.py`).

**Host hub entry (preferred):** from [the-dump-bin.com](https://the-dump-bin.com/) use **Central Pet — Shift Day** / **Planning Desk**. The hub passes the existing Dump Bin session JWT via `#dbSession=` (same `JWT_SECRET` as eod-api) so users do not re-enter email when already signed in.

Sync auth vars from eod-api to cp_scheduler (local, requires Railway CLI login):

```bash
python scripts/railway-sync-auth-vars.py
```

### Views

- **Admin** — Planning Desk (`/`), all-rep Shift Day preview, match, dry-run, live transmit UI, photo delivery.
- **Rep** — Shift Day + own week only (`/shiftday.html`, `/rep.html`), scoped to `repKey`.

**Admin accounts (full layer):** `tyson.gauthier@retailodyssey.com`, `d6ewa.supervisor@gmail.com`, `tgauthier2011@gmail.com` (override with `CP_SCHEDULER_ADMIN_EMAILS`).

**Rep accounts:** Brian / Kimberly / James D8 emails + Patricia Marks (override with `CP_SCHEDULER_REP_EMAILS`).

Access request flow: sign-in page → eod-api `/api/access-request` → supervisor email with approve/deny link (same as Dump Bin).

## Agent handoff

After approval, paste `schedule-handoff.md` or attach `schedule-handoff.json` to an agent with skill `sas-prod-shift-management-har` to execute mutations in Phase 2.
