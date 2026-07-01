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

Optional env:
- `DATABASE_PATH` — JSON draft store path (default `data/schedule-drafts.json`)
- `SAS_AUTH_STATE` — path to sas-auth token for PROD overlay

## Agent handoff

After approval, paste `schedule-handoff.md` or attach `schedule-handoff.json` to an agent with skill `sas-prod-shift-management-har` to execute mutations in Phase 2.
