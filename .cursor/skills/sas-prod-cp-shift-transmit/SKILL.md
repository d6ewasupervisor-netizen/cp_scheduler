---
name: sas-prod-cp-shift-transmit
description: >-
  Transmit a completed Central Pet (cp_scheduler) shift to SAS PROD end-to-end —
  the full Stage-4 T&E write sequence that closes a visit: start visit, travel
  (to_store/to_home), punch times, category-reset photos + assignee + spent_time
  + completion, service survey with images, and the final shift-complete PUT.
  Use this whenever the task involves transmitting/completing/"pushing to prod" a
  CP or Central Pet shift, the cp_scheduler Stage 4 / dry-run / LIVE_TRANSMIT
  path, prod-transmitter.js / live-executor.js, "Pin filed is required",
  "Category Reset is not completed", 406 on shift-complete, overlapping
  time/mileage records, a partial transmit that needs resuming, or completing a
  rep's visit in SAS PROD (e.g. James Duchene FM53/store 53, visit under
  placeholder store 391). It encodes every SAS payload shape and error→fix we
  reverse-engineered so you never have to rediscover them.
---

# Transmit a Central Pet shift to SAS PROD (Stage 4 T&E)

This is the **playbook for pushing a sealed cp_scheduler visit into SAS PROD** and
driving it all the way to `current_status: completed`. It exists because getting
one shift through took an entire night of reverse-engineering SAS's undocumented
field-app API, one 400/500/406 at a time. **Everything below is proven against
real HARs and a real completed visit (James Duchene, visit 27071906, 2026-07-17).**
Do not guess payload shapes — they are all here.

Repo: **`C:\Users\tgaut\cp_scheduler`** (separate from eod-api). Deploys to Railway
(`cpscheduler-production.up.railway.app`) from GitHub `main` (auto-deploy).

## When to use / not use

Use when: transmitting/completing a CP shift to PROD, debugging a stuck/partial
transmit, editing `prod-transmitter.js` (assembly) or `live-executor.js`
(execution), or wiring a new SAS field-app write.

Not for: the planning/scheduling side, the guided rep visit flow (Stage 3), or
photo/survey capture — those are separate. This is only the **PROD write spine**.

## Ground truth — the two HARs

Every payload shape traces to a captured browser session. Keep these:

| HAR | Path | Covers |
|-----|------|--------|
| Start call | `C:\Users\tgaut\Downloads\prod completion.har` | the visit-**start** PATCH body |
| Full complete shift | `C:\Users\tgaut\Downloads\prod completio7n.har` | the **entire** completion sequence (visit 26940175) — travel, punch, category reset, survey, final complete |

When any call returns an error you don't recognize, **grep the full-complete HAR
for that endpoint and copy its request body byte-for-byte.** That is how every fix
below was found. See [references/diagnosing-errors.md](references/diagnosing-errors.md).

## The gates (nothing transmits without all of these)

1. **Sealed draft** — `status: ready_for_prod` on the Railway volume
   (`/app/data/visit-drafts/<repKey>/<date>-<store>.json`).
2. **Healthy SAS session** — `GET /api/central-pet/shift-day/sas-status` → `state: "live"`.
3. **`LIVE_TRANSMIT=1`** — env var, or set per-process by the one-shot script. **Off on Railway by default.**
4. **Per-draft allowlist** — `data/live-allowlist.json` `draftIds` must contain the draft id. Empty = nothing sends, even with LIVE_TRANSMIT=1.
5. **Two-tap confirm** — `confirmStore` must equal the assembled `actualStore`.
6. **A matched PROD visit** — the matcher must map the sealed draft to a PROD `visitId`+`shiftId`. Needs the correct **`weekStart` = the fiscal-week Sunday** (e.g. 2026-07-17 → weekStart 2026-07-12) and the right `supervisorId` (default `800175315`). An already-started visit returns `unmatched` — bypass the matcher (see below).

## The write sequence at a glance

Assembled by `transmitVisit()` in `src/lib/prod-transmitter.js`, executed by
`executeLiveTransmit()` in `src/lib/live-executor.js`. Full payloads:
[references/call-sequence.md](references/call-sequence.md). The tricky tail
(category reset + final complete): [references/completion-flow.md](references/completion-flow.md).

1. **GETs** — resolve state + ids (shift-complete, shift, category-resets, survey, reasons, responders). Read-only.
2. **Start visit** — `PATCH /field-app/visits/{id}/` with the **full start body** (empty `{}` → 400). Skip if the visit is already `in-progress`/punched.
3. **to_store travel** — `POST /v2/field-app/travel/{shiftId}/to_store/` `{start_time, user_accepted_ss_replace:null}` (empty `{}` → 500).
4. **Punch times** — `PATCH /v2/field-app/shifts/{shiftId}/` — **read-modify-write** (GET the full shift, merge) + `pin:0` + `is_supervisor_edit_mode:true` + **store-local dates**.
5. **Step-advance** — `PATCH /field-app/visits/{id}/shift-complete/` `{shift_id}`.
6. **Category-reset photos** — `PATCH /category-resets/{id}/` `{before|after:{image}, compress_image:true}` per photo.
7. **validate-spent-time-reason** — `PATCH /category-resets/{id}/validate-spent-time-reason/`.
8. **Assign reset** — `PATCH /category-resets/{id}/` `{new_assignee:{visit_id, employee_id}}` (**required** — `is_assignee_required`).
9. **spent_time on reset** — `PATCH /category-resets/{id}/` `{id, shift_id, spent_time, spent_time_reason}`.
10. **Complete reset** — `PATCH /category-resets/{id}/` `{category_completion:true, id, comment, exception:null}` (**`category_completion`, NOT `completion_status`**).
11. **Survey** — `POST run-infos` → `POST answers` (+ `answer-images` multipart) → `POST responders` → `POST surveys/{id}/complete`.
12. **to_home travel** — `POST /v2/field-app/travel/{shiftId}/to_home/` `{start_time, user_accepted_ss_replace:null}`. A 5xx here is **non-fatal** (mileage rides on the shift CHANGE; the real HAR never posts to_home).
13. **Final shift PATCH** — times + S→H travel CHANGE record.
14. **Complete visit** — `PATCH shift-complete {shift_id}` → **`PUT shift-complete`** with the full completion body (`{shift_id}` alone → 406) → `PATCH shift-complete {team_lead_feedback:null}`.

## Error → fix (memorize this table)

| Symptom | Cause | Fix |
|---|---|---|
| 400 on start `PATCH /visits/{id}/` | empty `{}` body | full start body (visit_id, actual_start_time 12h-local, actual_start_datetime UTC, start_location `[-1,-1]`, validate_geo, is_web, isMerchandiserStartingVisit, from_state:`admin`, no_show_admin) |
| 500 on `to_store`/`to_home` | empty `{}` body | `{start_time:<UTC ISO>, user_accepted_ss_replace:null}` |
| impossible/25-hr shift, 400 | UTC-sliced `actual_*_date` | use **store-local** dates (`toStoreLocalDate`) to match the local times |
| 400 "**Pin filed is required**" | shift PATCH missing pin | add `pin:0` + `is_supervisor_edit_mode:true`; also send the **full** shift object (read-modify-write) |
| 400 "**Category Reset is not completed**" | reset not truly complete | needs **assignee** (`new_assignee`) + **spent_time** + **`category_completion:true`** — all three |
| 406 on `PUT shift-complete` | body was `{shift_id}` | full completion body: `{allowed_overlap, allowed_missing_ques, allowed_truncation, team_lead_feedback, end_location:[-1,-1], validate_geo}` |
| error 31 "overlapping time/mileage records?" | duplicate/overlapping travel rows | set `allowed_overlap:true` — **HUMAN DECISION**, it force-completes past a real warning; clean up the duplicate travel after |
| `not_in_matcher_scope` / `unmatched` | wrong `weekStart`, or visit already started | use fiscal-week Sunday for `weekStart`; if started, **bypass the matcher** by constructing `matchedVisit` directly (see running guide) |

## How to run it

The proven pattern is a **committed one-shot script** (`scripts/live-oneshot-*.js`)
run on the prod container over SSH. It constructs `matchedVisit` directly (so it
works even on an already-started visit), assembles via `transmitVisit`, then
`executeLiveTransmit`. Full mechanics — deploy cycle, resume, the Railway/SSH and
auto-mode-classifier gotchas that will otherwise waste your time — are in
[references/running-resuming-operating.md](references/running-resuming-operating.md).

Quick form (needs `~/.ssh/railway_cursor_ed25519` registered with Railway):

```bash
railway ssh -i ~/.ssh/railway_cursor_ed25519 --service cp_scheduler \
  --project 87a6a33f-6dd8-4335-8f33-672ed03b0508 --environment production \
  -- sh -c "cd /app; LIVE_TRANSMIT=1 /mise/shims/node /app/scripts/<one-shot>.js"
```

## Key files

| File | Role |
|---|---|
| `src/lib/prod-transmitter.js` | `transmitVisit()` — assembles the ordered call sequence (READ-ONLY vs prod) |
| `src/lib/live-executor.js` | `executeLiveTransmit()` — sends calls, read-modify-write, `shift_id` injection, soft-skips, resume |
| `src/lib/live-registry.js` | transmit bookkeeping (partial/complete), **volume-backed** so resume survives deploys |
| `src/lib/dryrun-runner.js` | orchestrator: `matchVisits` + `transmitVisit` (read-only dry run) |
| `src/lib/live-allowlist.js` | per-draft allowlist gate |
| `data/live-allowlist.json` | the allowlist (cleared after each one-shot) |
| `scripts/live-oneshot-james-17-direct.js` | reference one-shot: matcher-bypass + full run/resume |
| `scripts/_finish-james-17.js` | reference: finish a stuck visit (assignee + spent_time + category_completion + PUT) |

## Golden rules

- **Dry-run is read-only; the live executor writes.** Assemble/verify with a dry run first.
- **Never guess a payload — copy it from `prod completio7n.har`.**
- **A failed write does not corrupt** — SAS rejects it; only successful calls land. Diagnose, fix, resume.
- **Re-running from scratch duplicates** survey answers + photos. If a run got past the first writes, **resume** — don't restart.
- **`allowed_overlap:true` is a human call.** It overrides a real payroll warning; the auto-mode classifier will (correctly) refuse to let an agent self-approve it.
