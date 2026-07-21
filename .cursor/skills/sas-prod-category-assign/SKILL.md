---
name: sas-prod-category-assign
description: >-
  Assign an employee to a SAS PROD category reset (new_assignee). Use when is_assignee_required, empty team blocks completion, or Category Reset is not completed.
---

# Assign employee to category reset

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

## Why

`is_assignee_required: true` — without `new_assignee`, `team` stays empty and the final visit PUT 400s **"Category Reset is not completed"**.

## Endpoint

`PATCH https://prod.sasretail.com/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/`

## Body

```json
{
  "id": {resetId},
  "new_assignee": {
    "visit_id": "{visitId}",
    "employee_id": {employeeId}
  }
}
```

- `employee_id` = shift employee id from `GET …/shift-complete/` → `employees[].id` (match `shift_id`).
- `visit_id` is a **string** in the working HAR.

## Order

After punch times exist on the shift (HAR puts assignee after the shift PATCH). Before spent_time + final PUT.

For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.
