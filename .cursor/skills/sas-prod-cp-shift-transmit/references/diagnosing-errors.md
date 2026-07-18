# Diagnosing a failed/partial transmit

You ran a transmit and it stopped at `status: "partial"` with `abortReason`
`http_400`/`http_500`/`http_406` and a `failedSeq`. Here's how to find the cause
fast and the known error→fix map.

## Method

1. **Identify the failed call.** The executor result gives `failedSeq`,
   `lastSuccessfulSeq`, and the call's method+url. The seqs 1–8 are read-only GETs
   — the **first write is the visit-start PATCH**, so a failure at the "first
   write" means nothing landed yet (no corruption).
2. **Get the response body** — it is NOT in the registry. Run a committed probe
   that reproduces the single call and prints `r.status` + `r.body` (see the probe
   snippet in [running-resuming-operating.md](running-resuming-operating.md), and
   `scripts/_probe10.js`).
3. **Match against the HAR.** `grep` `prod completio7n.har` for that endpoint and
   copy its request body byte-for-byte. That HAR is a full, successful shift.
4. **Fix, deploy, resume** (not restart — restarting duplicates survey/photos).

## Known SAS errors → root cause → fix

| SAS response | Root cause | Fix (and where) |
|---|---|---|
| 400 on `PATCH /visits/{id}/` (start) | body was `{}` | full start body — `prod-transmitter.js` step "0. Start schedule" |
| 400, and a plain GET of `/visits/{id}/` also 400s | that endpoint is PATCH-only | not an error in your visit — proceed |
| `{"message":"Pin filed is required",...}` (400) | shift PATCH missing `pin` | add `pin:0` + `is_supervisor_edit_mode:true` in `shiftPatchPayload`; also send full shift (read-modify-write in `live-executor.js`) |
| 400 on shift PATCH, many fields | minimal body | read-modify-write: GET full shift, merge overrides, PATCH back (`live-executor.js`, `isShiftPatchCall` block) |
| shift shows a ~25-hour duration then 400 | `actual_*_date` used UTC slice | `toStoreLocalDate()` for start/end dates (`prod-transmitter.js`) |
| 500 on `/to_store/` or `/to_home/` with `{}` | empty travel body | `{start_time:<UTC ISO>, user_accepted_ss_replace:null}` (`prod-transmitter.js`). `to_home` 5xx is soft-skipped in `live-executor.js` |
| `{"message":"Category Reset is not completed, Please sync or refresh your page"}` (400 on PUT) | reset not truly `completed` | reset needs assignee + spent_time + `category_completion:true` — all three (`prod-transmitter.js` "7a2"/"7b"; see completion-flow.md) |
| category_completion PATCH returns 200 but reset stays `completed:false` | missing assignee | `new_assignee:{visit_id, employee_id}` — reset had `is_assignee_required:true`, empty `team` |
| 406 on `PUT /shift-complete/` | body was `{shift_id}` | full completion body `{allowed_*, team_lead_feedback, end_location:[-1,-1], validate_geo}` (`prod-transmitter.js`); and don't let the executor inject `shift_id` into it |
| `error_code:31 "…overlapping time/mileage records?"` | duplicate/overlapping travel | `allowed_overlap:true` — **human decision** (see completion-flow.md) |
| dry-run aborts `not_in_matcher_scope` | wrong `weekStart` | use the fiscal-week **Sunday** as `weekStart` |
| dry-run aborts `unmatched` | visit already started | bypass matcher — construct `matchedVisit` directly (running guide) |
| executor aborts `partial_exists_use_resume` | a partial is recorded | use `mode:'resume'`, not a fresh start |
| executor aborts `already_transmitted` / `already_completed_in_prod` | visit is done | nothing to do — verify `current_status: completed` |
| resume says `complete` but `callsSent:0` and visit still `in-progress` | **seq drift** (assembly size changed) | verify real PROD status; finish the last calls with a direct script instead of resuming |

## Sanity checks before blaming code

- `GET .../shift-complete/` → is `current_status` `active` (not started), `in-progress`
  (started), or `completed`? Drives whether to skip the start call.
- `GET .../category-resets/` → is `completed` true? `team` empty? `is_assignee_required`?
- `GET /shift-day/sas-status` (admin) → session `live`? A dead session throws
  `sas_session_incomplete — auth_token missing; retry in ~30s` (transient — wait, retry).
