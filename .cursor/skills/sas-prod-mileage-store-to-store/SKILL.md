---
name: sas-prod-mileage-store-to-store
description: >-
  Add store-to-store (S→S) mileage on a SAS PROD shift. Use when mid-day legs between stores, to_store creating S-S LOG, or correcting 0.00 system S-S with matrix miles.
---

# Store → store mileage (S→S)

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## 1. Preview travel

`POST https://prod.sasretail.com/api/v2/field-app/travel/{shiftId}/to_store/`

```json
{ "start_time": "2026-07-20T18:56:00.000Z", "user_accepted_ss_replace": null }
```

When prior travel already exists, SAS may emit a **0.00 S→S LOG** — still correct with CHANGE.

Skip `to_store` only if an inbound `end_location_type=S` row already exists for this arrival.

## 2. CHANGE row

```json
{
  "id": null,
  "shift_id": {shiftId},
  "start_time": "<UTC drive-start>",
  "end_time": "<UTC visit-start>",
  "distance": "20.00",
  "duration": "0.6000",
  "start_location_type": "S",
  "end_location_type": "S",
  "is_system_generated": false,
  "is_truncated": false,
  "user_accepted_overlap": null,
  "record_type": "CHANGE",
  "change_reason": 5,
  "change_comment": "…"
}
```

Inbound S→S ends at visit start. Miles from D8 store matrix (`prevStore-thisStore`).

Last-stop visits seal **both** inbound S→S and outbound S→H — send both CHANGEs on **one** shift PATCH (`sas-prod-mileage-store-to-home`).

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
