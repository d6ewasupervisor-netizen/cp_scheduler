# Full SAS PROD call sequence — exact payloads

Every write in the completion sequence, in order, with the **exact body SAS
accepts** (from `prod completio7n.har`, visit 26940175) and the error a wrong
shape returns. Base host: `https://prod.sasretail.com`. Auth headers on every
call: `Authorization: Token <token>`, `X-CSRFToken: <csrf>`, `Cookie: <session>`,
`X-Requested-With: XMLHttpRequest`, `Content-Type: application/json`.

`{visitId}` / `{shiftId}` / `{resetId}` / `{employeeId}` are resolved from the
opening GETs. Times: `actual_*_time` are **store-local `HH:mm:ss`** (24h); the
visit-start `actual_start_time` is **12-hour "1:17 AM"**; `*_datetime` /
`start_time` fields are **full UTC ISO** (`…Z`); `actual_*_date` are
**store-local** `YYYY-MM-DD`.

## 0. Resolve state + ids (GET, read-only)

- `GET /api/v1/field-app/visits/{visitId}/shift-complete/` → `current_status`, `employees[]` (each has `id` = employee_id, `shift_id`, `actual_start_time`). **If `current_status == "completed"` → abort, already done.**
- `GET /api/v2/field-app/shifts/{shiftId}/` → the full shift object (used for read-modify-write + travel flags).
- `GET /api/v1/field-app/visits/{visitId}/category-resets/` → the reset row(s): `id`, `is_assignee_required`, `is_before/after_image_required`, `completed`, `team`, `category_completion`.
- `GET /api/v2/field-app/survey-visits/?visit={visitId}` → survey id.
- `GET /api/v1/surveys/questions/?survey={surveyId}` → question ids.
- `GET /api/v1/field-app/spent-time-reasons/` and `GET /api/v1/operations/time-change-reason/?is_admin=true` → resolve reason ids by **exact text** (never invent).
- `GET /api/v1/surveys/responders/?visit_id={visitId}` → existing responder.

## 1. Start the visit — `PATCH /api/v1/field-app/visits/{visitId}/`

```json
{
  "visit_id": {visitId},
  "actual_start_time": "1:17 AM",
  "actual_start_datetime": "2026-07-18T08:17:00Z",
  "start_location": [-1, -1],
  "validate_geo": true,
  "is_web": true,
  "isMerchandiserStartingVisit": true,
  "from_state": "admin",
  "no_show_admin": true
}
```

- Empty `{}` → **400**. A bare `GET` of this endpoint also 400s (it's a PATCH-only shape) — don't be fooled.
- `actual_start_time` here is the **admin's current wall-clock**, 12-hour; `actual_start_datetime` is its UTC. (The rep's real work times go on the shift PATCH, step 4.)
- **Skip this call entirely if the visit is already `in-progress`** (status flips `active → in-progress` after a successful start; re-sending 400s).

## 2. Travel to store — `POST /api/v2/field-app/travel/{shiftId}/to_store/`

```json
{ "start_time": "2026-07-17T23:23:22.000Z", "user_accepted_ss_replace": null }
```

- Empty `{}` → **500**. `start_time` = UTC of arrival/visit-start.
- Skip if the shift already has travel records (idempotency).

## 3. Punch times — `PATCH /api/v2/field-app/shifts/{shiftId}/`

This is **read-modify-write**: GET `/v2/field-app/shifts/{shiftId}/` first, then
PATCH the **full ~35-field shift object** back with these overrides merged in. A
minimal subset → **400** (missing required fields). Overrides:

```json
{
  "actual_start_date": "2026-07-17",
  "actual_start_time": "16:23:22",
  "actual_end_date": "2026-07-17",
  "actual_end_time": "17:36:00",
  "no_show": false,
  "time_change_reason": 5,
  "time_change_comment": "…store attribution text…",
  "home_to_store": true, "store_to_store": true, "store_to_home": true, "calculate_mileage": true,
  "shift_breaks": [],
  "pin": 0,
  "is_supervisor_edit_mode": true,
  "is_lead_edit_mode": false,
  "edited_by_merchandiser": false,
  "capture_location": false
}
```

- Without `pin` → **400 "Pin filed is required"** (sic). `is_supervisor_edit_mode:true` marks the admin/web edit.
- **Dates must be store-local**, not `visitStopIso.slice(0,10)` — a 17:36 PDT stop is `00:36Z` next day, so a UTC slice makes a 25-hour shift → 400.
- `travel_records`: on the time-only edit send `[]` (or keep the server's). The final shift PATCH (step 13) carries the S→H mileage `CHANGE` row: `{record_type:"CHANGE", shift_id, start_time, end_time, distance, duration, start_location_type:"H"/"S", end_location_type:"S"/"H", change_reason:5, change_comment}` alongside the server's system `LOG` rows.

## 4. Step-advance — `PATCH /api/v1/field-app/visits/{visitId}/shift-complete/`

```json
{ "shift_id": {shiftId} }
```

## 5. Category-reset photos — `PATCH /api/v1/field-app/visits/{visitId}/category-resets/{resetId}/`

One PATCH per photo; before then after:

```json
{ "before": { "image": { "filetype":"image/jpeg", "filename":"…", "filesize":123, "base64":"…" } }, "compress_image": true }
{ "after":  { "image": { … } }, "compress_image": true }
```

## 6. Category reset → assignee, spent_time, completion

**See [completion-flow.md](completion-flow.md) — this is the part that blocks the
final PUT if done wrong.** Summary, in order, all to `…/category-resets/{resetId}/`:

- `PATCH …/validate-spent-time-reason/` with `{id, shift_id, spent_time, spent_time_reason:{id,text}, team_data:[…]}`.
- `PATCH {id, new_assignee:{visit_id:"{visitId}", employee_id:{employeeId}}}` — **required**.
- `PATCH {id, shift_id, spent_time:"1h 13m", spent_time_reason:{id:3, text:"Other – supervisor was contacted"}}`.
- `PATCH {category_completion:true, id, comment:"", exception:null}` — **`category_completion`, not `completion_status`**.

## 7. Service survey (response-chained)

- `POST /api/v1/surveys/run-infos/` `{responder:{responderId}, runid:null}` → returns `run_info` id.
- Per question: `POST /api/v1/surveys/answers/` `{answer, question:{qId}, responder, survey:{surveyId}, runid:"{{runinfo.runid}}", run_info:"{{runinfo.id}}", is_field_web:true, delete:false}` → returns `answer` id.
- Per image question: `POST /api/v1/surveys/answer-images/` **multipart/form-data** `{answer:"{{answer.id}}", is_field_web:true, image:<file>}`.
- `POST /api/v1/surveys/responders/` `{visit_id:"{visitId}"}`.
- `POST /api/v1/surveys/surveys/{surveyId}/complete/` `{responder, run_info:"{{runinfo.id}}"}`.

The executor resolves `{{stepN.id}}`-style placeholders from prior responses — do
not invent literal ids.

## 8. Travel home — `POST /api/v2/field-app/travel/{shiftId}/to_home/`

```json
{ "start_time": "2026-07-18T00:36:00.000Z", "user_accepted_ss_replace": null }
```

- `start_time` = UTC of departure (= stop time). A **5xx here is soft-skipped** in
  the executor: the working complete-shift HAR never posts to_home; the S→H
  mileage rides on the final shift PATCH's travel `CHANGE` row.

## 9. Complete the visit

- `PATCH /api/v1/field-app/visits/{visitId}/shift-complete/` `{shift_id}`.
- **`PUT /api/v1/field-app/visits/{visitId}/shift-complete/`**:

  ```json
  { "allowed_overlap": false, "allowed_missing_ques": false, "allowed_truncation": false,
    "team_lead_feedback": null, "end_location": [-1, -1], "validate_geo": true }
  ```

  - `{shift_id}` alone → **406**.
  - **error 31 "…complete with overlapping time/mileage records?"** → set the
    `allowed_*` flags to `true` to force through (human decision — see completion-flow).
- `PATCH /api/v1/field-app/visits/{visitId}/shift-complete/` `{team_lead_feedback:null}`.

Verify: `GET …/shift-complete/` → `current_status: "completed"`.
