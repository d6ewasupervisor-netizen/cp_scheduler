---
name: sas-prod-mileage-store-to-home
description: >-
  Add store-to-home (S→H) mileage on a SAS PROD shift. Use when last stop of day, to_home {end_time}, correcting system ~31mi S-H LOG, or sealing outbound home legs.
---

# Store → home mileage (S→H)

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## 1. Preview travel

`POST https://prod.sasretail.com/api/v2/field-app/travel/{shiftId}/to_home/`

```json
{ "end_time": "2026-07-20T20:26:00.000Z" }
```

- Body is **`{ end_time }`** = UTC visit **stop** (HAR 2026-07-21_00-54-51).
- Do **not** send `{ start_time, user_accepted_ss_replace }` (that is `to_store` only).
- System invents ~31 mi S→H LOG. Soft-skip 5xx if needed — CHANGE still corrects miles.

## 2. CHANGE row

```json
{
  "id": null,
  "shift_id": {shiftId},
  "start_time": "<UTC visit-stop>",
  "end_time": "<UTC home-arrival>",
  "distance": "7.80",
  "duration": "0.4167",
  "start_location_type": "S",
  "end_location_type": "H",
  "is_system_generated": false,
  "is_truncated": false,
  "user_accepted_overlap": null,
  "record_type": "CHANGE",
  "change_reason": 5,
  "change_comment": "…"
}
```

Outbound S→H **starts** at visit stop. Miles from home matrix (mirrored).

When last-stop also has inbound S→S, put **both** CHANGE rows on the **same** punch PATCH.

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
