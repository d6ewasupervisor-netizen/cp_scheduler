---
name: sas-prod-start-visit
description: >-
  Start a SAS PROD field-app visit (schedule start). Use when beginning a shift/visit in prod, PATCH /field-app/visits/{id}/, empty body 400s, or Schedule started successfully.
---

# Start a SAS PROD visit

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## Endpoint

`PATCH https://prod.sasretail.com/api/v1/field-app/visits/{visitId}/`

Headers: Authorization: Token <token>, X-CSRFToken, Cookie, X-Requested-With: XMLHttpRequest, Content-Type: application/json

## Body (exact)

```json
{
  "visit_id": {visitId},
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

- `actual_start_time` = **12-hour store-local** wall clock (admin start).
- `actual_start_datetime` = same instant as **UTC ISO** (`…Z`).
- Empty `{}` → **400**. Skip if visit already `in-progress` / punched.

## Verify

Response: `{ "message": "Schedule started successfully", "success": true }`

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.


