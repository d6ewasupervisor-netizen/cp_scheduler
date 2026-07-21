---
name: sas-prod-category-complete
description: >-
  Mark a SAS PROD category reset complete with category_completion:true. Use when completing PET CARE SUPPLIES reset, not completion_status, or Category Reset is not completed.
---

# Mark category reset complete

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## Endpoint

`PATCH https://prod.sasretail.com/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/`

## Body

```json
{
  "category_completion": true,
  "id": {resetId},
  "comment": "",
  "exception": null
}
```

## Critical

- Use **`category_completion`**, NOT `completion_status` (SAS ignores the latter).
- Alone is **not** enough for `completed: true` — also need **assignee** + **spent_time** (`sas-prod-category-assign`, `sas-prod-category-spent-time`).
- Working HARs send this flag after photos (often before T&E); assignee/spent_time still required before PUT.

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
