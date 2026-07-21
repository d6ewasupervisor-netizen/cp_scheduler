# Completing the visit — category reset + final PUT

This is the part that ate the most time. A visit will **not** close until its
category reset(s) are truly `completed: true`, and the reset has three separate
requirements that all must be satisfied. Then the final `PUT` has its own body +
an overlap gate.

## Why the visit won't complete: the category reset

`GET /api/v1/field-app/visits/{visitId}/category-resets/` returns the reset row.
The one that matters for completion:

```jsonc
{
  "id": 41531947,
  "name": "PET CARE SUPPLIES",
  "completed": false,              // ← THIS is what the final PUT checks
  "category_completion": true,     // ← we set this, but it is NOT sufficient alone
  "is_assignee_required": true,    // ← reset needs an assignee...
  "team": [],                      // ← ...and team is empty → blocks completion
  "is_before_image_required": true,
  "is_after_image_required": true,
  "state": { "before": { "images": […] }, "after": { "images": […] } }
}
```

`completed` only flips true once **all** of the following are done. Setting
`category_completion:true` alone leaves `completed:false` → the final PUT 400s
**"Category Reset is not completed, Please sync or refresh your page"**.

### The three requirements (all PATCH `…/category-resets/{resetId}/`)

1. **Assignee** — `is_assignee_required` is true and `team` must be populated:
   ```json
   { "id": {resetId}, "new_assignee": { "visit_id": "{visitId}", "employee_id": {employeeId} } }
   ```
   `employee_id` = the shift employee's `id` (from `shift-complete` `employees[].id`).
   In the working HAR this lands **after** the punch PATCH.

2. **spent_time** on the reset:
   ```json
   { "id": {resetId}, "shift_id": {shiftId}, "spent_time": "1h 53m",
     "spent_time_reason": { "id": 3, "text": "Other – supervisor was contacted" } }
   ```
   Reason id resolves by **exact text** from `GET /field-app/spent-time-reasons/`.
   Null reason when share > 5% returns a soft business failure — send the reason.

3. **Completion flag** — use `category_completion`, **not** `completion_status`
   (SAS silently ignores `completion_status`):
   ```json
   { "category_completion": true, "id": {resetId}, "comment": "", "exception": null }
   ```
   In kompass-netcap HAR 2026-07-21 this is sent **early** (right after photos,
   before travel/punch). Assignee + spent_time still follow after the punch.

After all three, re-`GET` the reset and confirm `completed: true` and `team` is
non-empty before attempting the visit PUT.

## The final complete — PUT body + the overlap gate

`PUT /api/v1/field-app/visits/{visitId}/shift-complete/`:

```json
{ "allowed_overlap": false, "allowed_missing_ques": false, "allowed_truncation": false,
  "team_lead_feedback": null, "end_location": [-1, -1], "validate_geo": true }
```

- A `{shift_id}`-only body → **406**.
- If SAS returns **`error_code: 31` "Are you sure you want to complete this visit
  with overlapping time/mileage records?"**, the visit has overlapping/duplicate
  travel or time rows. To force completion, resend with
  `allowed_overlap:true` (and typically `allowed_missing_ques:true`,
  `allowed_truncation:true`).

  **This is a human decision, not an agent one.** It overrides a real payroll
  warning and leaves the duplicate/overlapping records in place (they should be
  cleaned up in SAS afterward). The auto-mode classifier will refuse to let an
  agent self-approve this — surface it to the user and let them decide. A **clean
  single-pass transmit should not produce overlap** (it comes from duplicate
  travel created by repeated debug attempts), so with a healthy run keep
  `allowed_overlap:false`.

Then finalize: `PATCH …/shift-complete/` `{team_lead_feedback:null}`.

Verify: `GET …/shift-complete/` → `current_status: "completed"`. Done.
