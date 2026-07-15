# Live first-run checklist

**This document is for the supervised first transmission session.**  
The build does **not** run live by itself. You pick the visit, set the allowlist, and arm the transmit.

There is **no automatic rollback**. Several prod calls cannot be cleanly undone (you cannot un-start a shift). Safety is pre-flight + abort-on-first-failure + resumable state after you inspect the log.

---

## Before the session

1. **Prefer a load-only visit** if one is available (fewest calls, no order-checklist variables; still exercises start → photos → survey → complete).
2. Confirm the visit is **sealed** (`ready_for_prod`) in Stage 3 and uniquely matched in the dry-run.
3. Re-open the dry-run visit file and spot-check:
   - local `actual_start_time` / `actual_end_time`
   - matrix mileage (decoded store, not scheduled trap)
   - reason ids / survey answer strings
   - every call has `sourceRef`
   - Authorization is `Token {{REDACTED}}` only
4. Fresh **sas-auth** session (`loadSasSession()` must return a valid token).
5. Rollback / escalation contacts: **you (T)** — stay on the call for the whole run.

---

## Arming (order matters)

| Step | Action |
|------|--------|
| 1 | Set server env **`LIVE_TRANSMIT=1`** (or `true`). Restart the app process so it sees the flag. |
| 2 | Edit **`data/live-allowlist.json`**: put **exactly one** draft id in `draftIds`. Format: `{repKey}/{date}-{actualStore}` e.g. `brian-campbell/2026-07-08-215`. Empty list = nothing transmits. |
| 3 | Confirm Admin → Stage 4 panel shows **LIVE_TRANSMIT on** and the visit as **allowlisted**. |
| 4 | Open the dry-run visit → **Transmit (LIVE)** appears only when flag + allowlist both match. |
| 5 | Two-tap arm: type the **decoded store number** in the confirm field, then click Transmit, then confirm the browser dialog. |

---

## During the run

- Watch the response panel: `status: complete` or `partial` with `failedSeq` / `abortReason`.
- Logs: `live/{dryRunId}/execution-log-*.json` and `state-*.json` (tokens redacted; base64 truncated in logs).
- Registry: `live/transmitted-registry.json` — `partial` or `complete`.

### If it aborts mid-sequence

1. **Do not** blindly re-click start (server refuses while `partial` exists).
2. Open the execution log; identify `failedSeq` and the prod response body.
3. Decide with T whether to **resume** (explicit admin action, same two-tap arm) or leave partial for manual prod repair.
4. Resume re-runs pre-flight **except** the “not started” check, then continues from `lastSuccessfulSeq + 1` with restored placeholders.

### If it completes

- Registry marks `status: complete` with `transmittedAt` + `dryRunId`.
- A second transmit attempt is **permanently refused** for that draft / visit.

---

## After the session

1. Set **`LIVE_TRANSMIT=0`** (or unset) and restart.
2. Clear or empty **`data/live-allowlist.json`** `draftIds` unless intentionally leaving a controlled entry.
3. Archive the dry-run + live log folder with the session notes.

---

## testMode round-trip (preferred validation)

Stronger than a sacrificial run: **golden export → transmit assembled writes onto the completed visit → recomplete → re-export → diff**.

1. Export already exists (`export-cp-shift-full.js`, `allChecksPassed: true`), e.g.  
   `Downloads/cp_tests/visit-26822165` (decoded 111) or `visit-26822177` (decoded 215).
2. Arm **testMode** in Admin, set **golden export path**, type store, transmit.
3. Executor bypasses only not-completed / not-started checks, sends the assembled sequence, then **appends**  
   `POST /api/v1/field-app/visits/{id}/recomplete/` with empty body (not PUT shift-complete — that is first-time complete only; see `data/har-evidence-recomplete.json`).
4. Re-run the export script for the same visitId (new folder or overwrite path you control).
5. **Run round-trip diff** (Admin button or `POST /shift-day/live/roundtrip-diff`) → `live/{runId}/roundtrip-report.md`  
   - EXPECTED = fields the app intentionally wrote  
   - UNEXPECTED = defect  
   - Photos compared by count/slot only  

Prefer first run on **26822165**; keep **26822177** in reserve.

**T&E note (testing artifact, not a product gap):** completed-visit testMode may soft-skip field-app shift T&E when prod returns pin-context errors. Real rep visits are **in-progress first-time completions** (automator + HAR). Matrix vs 391-trap is proven on that path, not by rewriting already-closed T&E. Payload contract: `docs/sas-payload-contract.md`.

**Responder note:** assembler picks the visit **rep’s** responder row (email/name), not the session owner. Admin API `completed_by` may still be the session user — separate field.

---

## What this build will not do

- No week-wide or rep-wide live activation  
- No bulk transmit button  
- No automatic retry  
- No automatic rollback  
- No live run as part of CI or agent “done” delivery  
- No multi-visit time-integrity (see `docs/backlog.md`)  

The first live transmission happens only with you watching.
