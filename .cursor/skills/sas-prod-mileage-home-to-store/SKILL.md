---
name: sas-prod-mileage-home-to-store
description: >-
  Add home-to-store (H→S) mileage on a SAS PROD shift. Use when posting to_store travel, correcting system ~30mi LOG with a CHANGE row, or home-to-store matrix miles.
---

# Home → store mileage (H→S)

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## 1. Preview travel

`POST https://prod.sasretail.com/api/v2/field-app/travel/{shiftId}/to_store/`

```json
{ "start_time": "2026-07-20T13:03:00.000Z", "user_accepted_ss_replace": null }
```

- `start_time` = **UTC arrival** (= visit start). Empty `{}` → **500**.
- System invents ~30 mi H→S LOG — correct next.

## 2. Correct with CHANGE on shift PATCH

Include in `travel_records` (with punch times — `sas-prod-shift-allocate-time`):

```json
{
  "id": null,
  "shift_id": {shiftId},
  "start_time": "<UTC drive-start>",
  "end_time": "<UTC visit-start>",
  "distance": "4.80",
  "duration": "0.1667",
  "start_location_type": "H",
  "end_location_type": "S",
  "is_system_generated": false,
  "is_truncated": false,
  "user_accepted_overlap": null,
  "record_type": "CHANGE",
  "change_reason": 5,
  "change_comment": "…"
}
```

Executor RMW prepends CHANGE and keeps system LOG rows.

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
