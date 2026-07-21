---
name: sas-prod-shift-allocate-time
description: >-
  Allocate punch times on a SAS PROD shift (read-modify-write PATCH shifts). Use when setting actual_start/end store-local times, Pin filed is required, time_change_reason, or impossible 25-hour shift.
---

# Allocate shift punch times

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## Endpoint

`PATCH https://prod.sasretail.com/api/v2/field-app/shifts/{shiftId}/`

**Read-modify-write**: GET the full shift first, merge overrides, PATCH back (~35 fields). Minimal subset → 400.

## Required overrides

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
  "is_lead_edit_mode": false,
  "edited_by_merchandiser": false,
  "capture_location": false,
  "no_show": false,
  "home_to_store": true,
  "store_to_store": true,
  "store_to_home": true,
  "calculate_mileage": true,
  "shift_breaks": []
}
```

## Rules

- Times are **store-local `HH:mm:ss`** (24h). Dates are **store-local YYYY-MM-DD** (not UTC slice).
- Without `pin: 0` → **400 "Pin filed is required"**.
- Resolve `time_change_reason` by exact text from `GET /operations/time-change-reason/?is_admin=true`.
- Often the **same PATCH** also carries travel CHANGE rows — see mileage skills.

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
