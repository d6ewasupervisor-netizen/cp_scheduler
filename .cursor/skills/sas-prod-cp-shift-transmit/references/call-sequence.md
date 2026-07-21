# Full SAS PROD call sequence — exact payloads

Primary ground truth: **`kompass-netcap_2026-07-21_00-35-01.har`** (visit
**27092092**, store 111) — full request bodies via mitmproxy. Older Chrome HARs
(`prod completion.har`, `prod completio7n.har`) still useful for start-body and
edge cases.

Base host: `https://prod.sasretail.com`. Auth headers on every call:
`Authorization: Token <token>`, `X-CSRFToken: <csrf>`, `Cookie: <session>`,
`X-Requested-With: XMLHttpRequest`, `Content-Type: application/json`.

`{visitId}` / `{shiftId}` / `{resetId}` / `{employeeId}` are resolved from the
opening GETs. Times: `actual_*_time` are **store-local `HH:mm:ss`** (24h); the
visit-start `actual_start_time` is **12-hour "12:36 AM"**; `*_datetime` /
`start_time` fields are **full UTC ISO** (`…Z`); `actual_*_date` are
**store-local** `YYYY-MM-DD`.

## 0. Resolve state + ids (GET, read-only)

- `GET /api/v1/field-app/visits/{visitId}/shift-complete/` → `current_status`, `employees[]`. **If `current_status == "completed"` → abort.**
- `GET /api/v2/field-app/shifts/{shiftId}/` → full shift object (RMW + travel flags).
- `GET /api/v1/field-app/visits/{visitId}/category-resets/` → reset row(s).
- `GET /api/v2/field-app/survey-visits/?visit={visitId}` → survey id.
- `GET /api/v1/surveys/questions/?survey={surveyId}` → question ids.
- `GET /api/v1/field-app/spent-time-reasons/` and `GET /api/v1/operations/time-change-reason/?is_admin=true`.
- `GET /api/v1/surveys/responders/?visit_id={visitId}` → existing responder.

## 1. Start the visit — `PATCH /api/v1/field-app/visits/{visitId}/`

```json
{
  "visit_id": 27092092,
  "actual_start_time": "12:36 AM",
  "actual_start_datetime": "2026-07-21T07:36:00Z",
  "start_location": [-1, -1],
  "validate_geo": true,
  "is_web": true,
  "isMerchandiserStartingVisit": true,
  "from_state": "admin",
  "no_show_admin": true
}
```

Empty `{}` → **400**. Skip if already `in-progress`.

## 2. Service survey

```json
// POST /api/v1/surveys/responders/  (create, if none)
{ "visit_id": 27092092, "name": "tyson.gauthier@advantagesolutions.net" }

// POST /api/v1/surveys/run-infos/
{ "responder": 8363623, "runid": null }

// POST /api/v1/surveys/answers/   ← no survey / runid fields
{ "answer": "yes", "question": 920233, "responder": 8363623, "run_info": 252333095, "is_field_web": true, "delete": false }

// POST /api/v1/surveys/answer-images/  multipart: answer=<id>, is_field_web=true, image=<file>

// POST /api/v1/surveys/responders/  (claim, always before complete)
{ "visit_id": "27092092" }

// POST /api/v1/surveys/surveys/{surveyId}/complete/
{ "responder": 8363623, "run_info": 252333095 }
```

## 3. Category-reset photos + early completion

```json
// PATCH …/category-resets/{resetId}/
{ "before": { "image": { "filetype":"image/jpeg", "filename":"…", "filesize":123, "base64":"…" } }, "compress_image": true }
{ "after":  { "image": { … } }, "compress_image": true }

// Then category_completion (BEFORE travel/punch in the working HAR):
{ "category_completion": true, "id": 41653639, "comment": "", "exception": null }
```

## 4. Travel to store — `POST /api/v2/field-app/travel/{shiftId}/to_store/`

```json
{ "start_time": "2026-07-20T18:56:00.000Z", "user_accepted_ss_replace": null }
```

Empty `{}` → **500**. Skip if an inbound-to-store (`end_location_type=S`) row already exists.

## 5. Travel home — `POST /api/v2/field-app/travel/{shiftId}/to_home/`

```json
{ "end_time": "2026-07-20T20:26:00.000Z" }
```

**`end_time` = UTC stop** (kompass-netcap HAR 2026-07-21_00-54-51). Do **not** send
`{ start_time, user_accepted_ss_replace }` — that shape is for `to_store` only.
System invents ~31 mi S→H LOG; the next shift PATCH corrects with a CHANGE row.

## 6. Punch + mileage — `PATCH /api/v2/field-app/shifts/{shiftId}/`

**Read-modify-write**: GET the shift, merge overrides. One PATCH carries times +
**all** travel CHANGE rows (`id:null`) + system LOG echo. Last-stop after a prior
store sends **S→S and S→H together**:

```json
{
  "actual_start_date": "2026-07-20",
  "actual_start_time": "11:56:00",
  "actual_end_date": "2026-07-20",
  "actual_end_time": "13:26:00",
  "time_change_reason": 5,
  "time_change_comment": "…",
  "pin": 0,
  "is_supervisor_edit_mode": true,
  "travel_records": [
    {
      "id": null,
      "shift_id": 44611541,
      "start_time": "2026-07-20T18:20:00.000Z",
      "end_time": "2026-07-20T18:56:00.000Z",
      "distance": "20.00",
      "duration": "0.6000",
      "start_location_type": "S",
      "end_location_type": "S",
      "record_type": "CHANGE",
      "change_reason": 5,
      "change_comment": "…"
    },
    {
      "id": null,
      "shift_id": 44611541,
      "start_time": "2026-07-20T20:26:00.000Z",
      "end_time": "2026-07-20T20:51:00.000Z",
      "distance": "7.80",
      "duration": "0.4167",
      "start_location_type": "S",
      "end_location_type": "H",
      "record_type": "CHANGE",
      "change_reason": 5,
      "change_comment": "…"
    }
  ]
}
```

Without `pin` → **400 "Pin filed is required"**. Dates must be **store-local**.

Stage 3 seals last-stop mileage as `mileage.legs = [inbound S→S|H→S, outbound S→H]`
so both CHANGE rows are available at transmit time.

## 7. Assignee + spent_time (after punch)

```json
// PATCH …/shift-complete/
{ "team_lead_feedback": null }

// PATCH …/category-resets/{resetId}/
{ "id": 41653639, "new_assignee": { "visit_id": "27092124", "employee_id": 354456 } }

{ "id": 41653639, "shift_id": 44611541, "spent_time": "1h 30m",
  "spent_time_reason": { "id": 3, "text": "Other – supervisor was contacted" } }
```

## 8. Complete the visit

```json
// PUT …/shift-complete/
{ "allowed_overlap": false, "allowed_missing_ques": false, "allowed_truncation": false,
  "team_lead_feedback": "this is for store 19", "end_location": [-1, -1], "validate_geo": true }

// PATCH …/shift-complete/
{ "team_lead_feedback": "this is for store 19" }
```

- `{shift_id}` alone → **406**.
- error 31 overlap → `allowed_*:true` is a **human decision**.

Verify: `GET …/shift-complete/` → `current_status: "completed"`.
