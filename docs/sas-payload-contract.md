# SAS field-app payload contract

**Source of truth for what Stage 4 assembles and the live executor sends.**  
Re-baselined after the supervised live testMode run on visit **26822165** (2026-07-14) against sas-retail-automator + HAR evidence.

Auth is always **morning sas-auth** (`auth_token` + `csrfToken` + `cookieHeader`), not cp_scheduler app users and not a supervisor PIN field.

---

## Session (every write)

| Header | Source |
|--------|--------|
| `Authorization: Token …` | `auth.auth_token` |
| `X-CSRFToken` | `csrfToken` / cookie `csrftoken` |
| `Cookie` | full `cookieHeader` (Node must use `https` — `fetch` strips Cookie) |
| `Content-Type` | `application/json;charset=UTF-8` on writes (except multipart answer-images) |
| `Referer` | prefer `…/en/field/schedules/{visitId}/schedule/admin` |

Automator note: **shift-completion/admin** context without project config often yields `"Pin filed is required"` / `projects/undefined`. That is **wrong context**, not a PIN to type in the JSON body. In-progress first-time T&E works via schedule/admin punch path; completed-visit pure-API T&E may soft-skip.

---

## Travel

| Call | Contract |
|------|----------|
| `POST /api/v2/field-app/travel/{shiftId}/to_store/` | Body **`{}`** (JSON). Automator: empty body without JSON Content-Type → 500 Parser NoneType. |
| Execute skip | If GET shift already has `travel_records.length > 0`, **skip** to_store. |
| Matrix mileage | Computed on sealed record / `result.mileageAudit` for audit. **Not** sent as incomplete `travel_records` on shift PATCH. First-time in-progress: to_store establishes travel (Google). |

---

## Shift T&E (`PATCH /api/v2/field-app/shifts/{shiftId}/`)

Automator `applyRegularShiftTimesViaApi` shape:

```json
{
  "actual_start_date": "YYYY-MM-DD",
  "actual_start_time": "HH:mm:ss",
  "actual_end_date": "YYYY-MM-DD",
  "actual_end_time": "HH:mm:ss",
  "no_show": false,
  "home_to_store": true,
  "store_to_store": true,
  "store_to_home": true,
  "calculate_mileage": true,
  "time_change_reason": 5,
  "time_change_comment": "<required real comment>",
  "shift_breaks": []
}
```

**Do not include `travel_records`.**  
Synthetic `CHANGE` rows without a live shift association → 500 `TravelRecord has no shift`.  
Null `start_time`/`duration` → 400.

Times are **store-local wall clock** (`America/Los_Angeles` via store map), not UTC ISO slices.

---

## Step-advance / first-time complete

| Call | Body |
|------|------|
| `PATCH …/visits/{id}/shift-complete/` | `{ "shift_id": <n> }` — empty `{}` → 406 `shift_id is required` |
| `PUT …/visits/{id}/shift-complete/` | `{ "shift_id": <n> }` first-time close (HAR #435 family) |
| `POST …/visits/{id}/recomplete/` | Empty `{}` — **already-completed** re-close only (testMode). Not a substitute for first-time PUT. |

---

## Survey

| Call | Body |
|------|------|
| `POST …/surveys/run-infos/` | `{ "responder": <id> }` |
| `POST …/surveys/answers/` | `{ answer, question, responder, survey, runid, run_info }` — **both** `runid` (uuid) and `run_info` (run-infos row id) required live |
| `POST …/surveys/answer-images/` | Assembler: `{ answer, image: {base64…}, _executorEncoding: "multipart-answer-image" }`. **Executor** sends multipart file (JSON image → 400 “not a file”). |
| `POST …/surveys/surveys/{id}/complete/` | `{ "responder": <id>, "run_info": <id> }` |

### Responder identity (rep, not session owner)

1. `GET …/surveys/responders/?visit_id=`  
2. **Pick** the row matching the visit’s **rep** (email / name from `d8-shift-reps.json`), not `results[0]` if that is the supervisor session.  
3. Answers and complete use that **responder id**.  
4. **Caveat:** admin-driven complete may still set `completed_by` / `completed_by_email` to the **API session user** (e.g. Tyson). That is separate from `responder`. Prefer rep-token or accept session-actor on complete until a rep-scoped auth path exists.

---

## Category photos

`PATCH …/category-resets/{id}/` with `{ before|after: { image: { filetype, filename, filesize, base64 } }, compress_image: true }` — JSON base64 OK (unlike answer-images).

---

## Testing note (not a product gap)

Completed-visit testMode may soft-skip T&E when prod returns pin-context errors. **Real rep first-time completions are in-progress** — automator + original HAR prove that path. Matrix vs 391-trap is validated on in-progress first-time runs, not by rewriting already-closed T&E.

---

## Related files

| File | Role |
|------|------|
| `src/lib/prod-transmitter.js` | Assembles this contract |
| `src/lib/live-executor.js` | Sends it (session headers, multipart, soft-skips) |
| `src/lib/sas-session.js` | Morning auth load |
| `data/har-evidence-recomplete.json` | recomplete vs first-time complete |
| `data/har-evidence-27000510.json` | Original first-time spine |
