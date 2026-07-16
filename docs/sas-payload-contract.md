# SAS field-app payload contract

**Source of truth for what Stage 4 assembles and the live executor sends.**  
Re-baselined after the supervised live testMode run on visit **26822165** (2026-07-14) and the **James FM53 first-time complete HAR** (visit **27000977**, 2026-07-15 evening).

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

## Visit start (first-time)

| Call | Contract |
|------|----------|
| `PATCH /api/v1/field-app/visits/{visitId}/` | Body **`{}`**. Response: `"Schedule started successfully"`. James FM53 HAR — first write before travel. |

---

## Travel

| Call | Contract |
|------|----------|
| `POST /api/v2/field-app/travel/{shiftId}/to_store/` | Body **`{}`** (JSON). Empty body without JSON Content-Type → 500 Parser NoneType. |
| `POST /api/v2/field-app/travel/{shiftId}/to_home/` | Body **`{}`**. When last stop or sealed leg is store→home. System may invent ~32mi S-H. |
| Execute skip | If GET shift already has `travel_records.length > 0`, **skip** to_store/to_home (testMode / already-traveled). |
| Matrix mileage | Sealed `mileage.leg` + `result.mileageAudit`. Correct system distance via shift PATCH **travel CHANGE** (below). |

---

## Shift T&E (`PATCH /api/v2/field-app/shifts/{shiftId}/`)

### Time change (always)

Assembler writes **full start+stop early** (before category duration) so work time is non-zero:

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
  "shift_breaks": [],
  "travel_records": []
}
```

**Always include `time_change_reason` + `time_change_comment`** on time edits  
(`GET /api/v1/operations/time-change-reason/?is_admin=true`, exact text).  
Default text: `Tablet was Not Available` (id 5). Never default comment to HAR placeholder `"k"`.

Times are **store-local wall clock** (`America/Los_Angeles` via store map), not UTC ISO slices.

### Mileage change (`travel_records` CHANGE) — prod completion.har

After `to_store` / `to_home`, correct matrix miles with a **complete** CHANGE row  
(incomplete rows → 500 `TravelRecord has no shift`):

```json
{
  "actual_start_date": "YYYY-MM-DD",
  "actual_start_time": "HH:mm:ss",
  "actual_end_date": "YYYY-MM-DD",
  "actual_end_time": "HH:mm:ss",
  "no_show": false,
  "time_change_reason": 5,
  "time_change_comment": "<required real comment>",
  "home_to_store": true,
  "store_to_store": true,
  "store_to_home": true,
  "calculate_mileage": true,
  "shift_breaks": [],
  "travel_records": [
    {
      "shift_id": 44392384,
      "start_time": "2026-07-15T23:04:00.000Z",
      "end_time": "2026-07-15T23:10:00.000Z",
      "distance": "3.50",
      "duration": "0.1000",
      "start_location_type": "S",
      "end_location_type": "H",
      "is_system_generated": false,
      "is_truncated": false,
      "user_accepted_overlap": null,
      "record_type": "CHANGE",
      "change_reason": 5,
      "change_comment": "<same catalog / required comment>"
    }
  ]
}
```

| Field | Rule |
|-------|------|
| `shift_id` | Required on the travel row |
| `distance` | Matrix miles, 2 decimals (`"3.40"`) |
| `duration` | Hours, 4 decimals; estimate ≥ 5 min, ~40 mph (James 3.4→0.0833) |
| `change_reason` | Same id catalog as time_change_reason |
| `change_comment` | Required free text (assembler uses `timeChangeComment`) |
| `id` | Include when editing an existing travel record; omit on first create |

**Executor:** send complete CHANGE rows; strip audit-only / incomplete travel; allow `travel_records: []` on time-only patches.

---

## Category duration + spent-time reason (James FM53 + prod completion.har)

| Rule | Behavior |
|------|----------|
| Duration ≤ work time | Category actual/spent duration **must not exceed** total work time → else **HTTP 400** `"Actual duration should not be greater than total work time"`. Assembler sets `team[].spent_time` to the work-time label only. |
| Spent share &gt; 5% | **HTTP 200** with `success: false`, `is_spent_time: true`. Requires `spent_time_reason`. |
| Validate endpoint | `PATCH …/category-resets/{id}/validate-spent-time-reason/` with `{ id, shift_id, spent_time, spent_time_reason: {id,text}, team_data: [...] }` **before** completion PATCH. |
| Single-category CP | spent === work → always &gt; 5% → **always send** reason. Default: `Other – supervisor was contacted` (id 3, en dash U+2013). |

**Executor:** treat `success: false` on HTTP 200 as a hard failure (`sas_business_failure:…`), never continue.

### Recomplete (already-completed / testMode)

`POST …/visits/{id}/recomplete/` body (prod completion.har):

```json
{
  "category-reset": [{ "id", "completed": true, "category_completion": true, "team": [{ "spent_time", "spent_time_reason": { "id", "text" } }] }],
  "complete_shift_final": {
    "team_lead_feedback": null,
    "allowed_truncation": false,
    "allowed_overlap": false,
    "allowed_missing_ques": false
  }
}
```

Assembler stores this on `assembled.recompletePayload`; testMode executor appends it.

---

## Step-advance / first-time complete

| Call | Body |
|------|------|
| `PATCH …/visits/{id}/shift-complete/` | `{ "shift_id": <n> }` — empty `{}` → 406 `shift_id is required` |
| `PUT …/visits/{id}/shift-complete/` | `{ "shift_id": <n> }` first-time close → `"Visit completed successfully."` (James FM53 + HAR #435) |
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
