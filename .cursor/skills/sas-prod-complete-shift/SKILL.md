---
name: sas-prod-complete-shift
description: >-
  Complete a SAS PROD visit/shift (PUT shift-complete). Use when finalizing current_status completed, 406 on shift-complete, allowed_overlap error 31, or team_lead_feedback store attribution.
---

# Complete the SAS PROD visit

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## Preconditions

Category reset must be truly complete: **photos + assignee + spent_time + category_completion**. Survey complete if required. Punch times + mileage CHANGEs landed.

## Sequence

1. Optional mid ping: `PATCH …/shift-complete/` `{ "team_lead_feedback": null }`
2. **PUT** first-time complete
3. **PATCH** repeat feedback

## PUT body

`PATCH`/`PUT` `https://prod.sasretail.com/api/v1/field-app/visits/{visitId}/shift-complete/`

```json
{
  "allowed_overlap": false,
  "allowed_missing_ques": false,
  "allowed_truncation": false,
  "team_lead_feedback": "this is for store 19",
  "end_location": [-1, -1],
  "validate_geo": true
}
```

- `{ "shift_id" }` alone → **406**.
- Error 31 overlapping time/mileage → `allowed_*: true` is a **human decision**.
- Final PATCH repeats the same `team_lead_feedback` string.

## Verify

`GET …/shift-complete/` → `current_status: "completed"`.

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
