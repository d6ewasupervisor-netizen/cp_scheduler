---
name: sas-prod-category-spent-time
description: >-
  Set spent_time and spent_time_reason on a SAS PROD category reset, including the Other/supervisor-contacted exception when time exceeds the 5% rule. Use when cummulative spent time > 5%, is_spent_time, or category duration labels like 1h 53m.
---

# Category spent_time + over-estimate reason

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## Endpoint

`PATCH https://prod.sasretail.com/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/`

## Body (required when category share of work > 5%)

```json
{
  "id": {resetId},
  "shift_id": {shiftId},
  "spent_time": "1h 53m",
  "spent_time_reason": {
    "id": 3,
    "text": "Other – supervisor was contacted",
    "time_created": null,
    "time_modified": null,
    "registered_timestamp": "2016-07-11T11:30:03.484000Z",
    "unregistered_timestamp": null,
    "route": "field-app/spent-time-reasons/",
    "reqParams": null,
    "restangularized": true,
    "fromServer": true,
    "parentResource": null,
    "restangularCollection": false
  }
}
```

## Rules

- Resolve reason by **exact text** from `GET /api/v1/field-app/spent-time-reasons/`. Never invent ids.
- Approved default for over-estimate / single-category CP: **"Other – supervisor was contacted"** (en dash `\u2013`).
- `spent_time_reason: null` when share > 5% → soft failure asking for a reason.
- `spent_time` must not exceed total work time (`Xh Ym` label matching punch duration).

## Related

After assignee (`sas-prod-category-assign`). Pair with `sas-prod-category-complete`.

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
