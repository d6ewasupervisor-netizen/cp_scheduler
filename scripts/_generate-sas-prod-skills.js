'use strict';

/**
 * One-shot generator: modular sas-prod-* skills + Skills Backup tooling + user rule.
 * Run from anywhere: node path/to/this/script.js
 */

const fs = require('fs');
const path = require('path');

const USER_SKILLS = path.join(process.env.USERPROFILE || process.env.HOME, '.cursor', 'skills');
const USER_RULES = path.join(process.env.USERPROFILE || process.env.HOME, '.cursor', 'rules');
const BACKUP_ROOT = path.join(process.env.USERPROFILE || process.env.HOME, 'OneDrive', 'Skills Backup');
const CP_SKILLS = path.join(process.env.USERPROFILE || process.env.HOME, 'cp_scheduler', '.cursor', 'skills');

const AUTH = 'Requires a live SAS prod session — see skill `sas-auth-prod-session`.';
const BASE = 'https://prod.sasretail.com';
const HEADERS = `Authorization: Token <token>, X-CSRFToken, Cookie, X-Requested-With: XMLHttpRequest, Content-Type: application/json`;
const ORCH = 'For the full Stage-4 spine see `sas-prod-shift-process` or `sas-prod-cp-shift-transmit`.';

function writeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\n${body.trim()}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md.replace(/\n/g, '\r\n'));
}

const skills = [];

skills.push({
  name: 'sas-prod-start-visit',
  description:
    'Start a SAS PROD field-app visit (schedule start). Use when beginning a shift/visit in prod, PATCH /field-app/visits/{id}/, empty body 400s, or Schedule started successfully.',
  body: `# Start a SAS PROD visit

${AUTH}

## Endpoint

\`PATCH ${BASE}/api/v1/field-app/visits/{visitId}/\`

Headers: ${HEADERS}

## Body (exact)

\`\`\`json
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
\`\`\`

- \`actual_start_time\` = **12-hour store-local** wall clock (admin start).
- \`actual_start_datetime\` = same instant as **UTC ISO** (\`…Z\`).
- Empty \`{}\` → **400**. Skip if visit already \`in-progress\` / punched.

## Verify

Response: \`{ "message": "Schedule started successfully", "success": true }\`

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-category-photos',
  description:
    'Upload before/after category-reset photos on a SAS PROD visit. Use when PATCHing category-resets with before/after image base64, compress_image, or category photo slots.',
  body: `# Category-reset before/after photos

${AUTH}

## Endpoint

\`PATCH ${BASE}/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/\`

One PATCH per photo.

## Bodies

\`\`\`json
{
  "before": {
    "image": {
      "filetype": "image/jpeg",
      "filename": "store-111_01-before-01.jpg",
      "filesize": 3142692,
      "base64": "<jpeg-base64>"
    }
  },
  "compress_image": true
}
\`\`\`

\`\`\`json
{
  "after": {
    "image": {
      "filetype": "image/jpeg",
      "filename": "store-111_02-after-01.jpg",
      "filesize": 2924503,
      "base64": "<jpeg-base64>"
    }
  },
  "compress_image": true
}
\`\`\`

Extra category evidence (clipstrips, endcaps, etc.) folds into additional **after** PATCHes on the same reset row.

## Notes

- Resolve \`resetId\` from \`GET …/category-resets/\` (CP usually has one "PET CARE SUPPLIES" row).
- Success message: "Category Reset Item images updated successfully."

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-category-assign',
  description:
    'Assign an employee to a SAS PROD category reset (new_assignee). Use when is_assignee_required, empty team blocks completion, or Category Reset is not completed.',
  body: `# Assign employee to category reset

${AUTH}

## Why

\`is_assignee_required: true\` — without \`new_assignee\`, \`team\` stays empty and the final visit PUT 400s **"Category Reset is not completed"**.

## Endpoint

\`PATCH ${BASE}/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/\`

## Body

\`\`\`json
{
  "id": {resetId},
  "new_assignee": {
    "visit_id": "{visitId}",
    "employee_id": {employeeId}
  }
}
\`\`\`

- \`employee_id\` = shift employee id from \`GET …/shift-complete/\` → \`employees[].id\` (match \`shift_id\`).
- \`visit_id\` is a **string** in the working HAR.

## Order

After punch times exist on the shift (HAR puts assignee after the shift PATCH). Before spent_time + final PUT.

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-category-spent-time',
  description:
    'Set spent_time and spent_time_reason on a SAS PROD category reset, including the Other/supervisor-contacted exception when time exceeds the 5% rule. Use when cummulative spent time > 5%, is_spent_time, or category duration labels like 1h 53m.',
  body: `# Category spent_time + over-estimate reason

${AUTH}

## Endpoint

\`PATCH ${BASE}/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/\`

## Body (required when category share of work > 5%)

\`\`\`json
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
\`\`\`

## Rules

- Resolve reason by **exact text** from \`GET /api/v1/field-app/spent-time-reasons/\`. Never invent ids.
- Approved default for over-estimate / single-category CP: **"Other – supervisor was contacted"** (en dash \`\\u2013\`).
- \`spent_time_reason: null\` when share > 5% → soft failure asking for a reason.
- \`spent_time\` must not exceed total work time (\`Xh Ym\` label matching punch duration).

## Related

After assignee (\`sas-prod-category-assign\`). Pair with \`sas-prod-category-complete\`.

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-category-complete',
  description:
    'Mark a SAS PROD category reset complete with category_completion:true. Use when completing PET CARE SUPPLIES reset, not completion_status, or Category Reset is not completed.',
  body: `# Mark category reset complete

${AUTH}

## Endpoint

\`PATCH ${BASE}/api/v1/field-app/visits/{visitId}/category-resets/{resetId}/\`

## Body

\`\`\`json
{
  "category_completion": true,
  "id": {resetId},
  "comment": "",
  "exception": null
}
\`\`\`

## Critical

- Use **\`category_completion\`**, NOT \`completion_status\` (SAS ignores the latter).
- Alone is **not** enough for \`completed: true\` — also need **assignee** + **spent_time** (\`sas-prod-category-assign\`, \`sas-prod-category-spent-time\`).
- Working HARs send this flag after photos (often before T&E); assignee/spent_time still required before PUT.

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-shift-allocate-time',
  description:
    'Allocate punch times on a SAS PROD shift (read-modify-write PATCH shifts). Use when setting actual_start/end store-local times, Pin filed is required, time_change_reason, or impossible 25-hour shift.',
  body: `# Allocate shift punch times

${AUTH}

## Endpoint

\`PATCH ${BASE}/api/v2/field-app/shifts/{shiftId}/\`

**Read-modify-write**: GET the full shift first, merge overrides, PATCH back (~35 fields). Minimal subset → 400.

## Required overrides

\`\`\`json
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
\`\`\`

## Rules

- Times are **store-local \`HH:mm:ss\`** (24h). Dates are **store-local YYYY-MM-DD** (not UTC slice).
- Without \`pin: 0\` → **400 "Pin filed is required"**.
- Resolve \`time_change_reason\` by exact text from \`GET /operations/time-change-reason/?is_admin=true\`.
- Often the **same PATCH** also carries travel CHANGE rows — see mileage skills.

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-mileage-home-to-store',
  description:
    'Add home-to-store (H→S) mileage on a SAS PROD shift. Use when posting to_store travel, correcting system ~30mi LOG with a CHANGE row, or home-to-store matrix miles.',
  body: `# Home → store mileage (H→S)

${AUTH}

## 1. Preview travel

\`POST ${BASE}/api/v2/field-app/travel/{shiftId}/to_store/\`

\`\`\`json
{ "start_time": "2026-07-20T13:03:00.000Z", "user_accepted_ss_replace": null }
\`\`\`

- \`start_time\` = **UTC arrival** (= visit start). Empty \`{}\` → **500**.
- System invents ~30 mi H→S LOG — correct next.

## 2. Correct with CHANGE on shift PATCH

Include in \`travel_records\` (with punch times — \`sas-prod-shift-allocate-time\`):

\`\`\`json
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
\`\`\`

Executor RMW prepends CHANGE and keeps system LOG rows.

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-mileage-store-to-store',
  description:
    'Add store-to-store (S→S) mileage on a SAS PROD shift. Use when mid-day legs between stores, to_store creating S-S LOG, or correcting 0.00 system S-S with matrix miles.',
  body: `# Store → store mileage (S→S)

${AUTH}

## 1. Preview travel

\`POST ${BASE}/api/v2/field-app/travel/{shiftId}/to_store/\`

\`\`\`json
{ "start_time": "2026-07-20T18:56:00.000Z", "user_accepted_ss_replace": null }
\`\`\`

When prior travel already exists, SAS may emit a **0.00 S→S LOG** — still correct with CHANGE.

Skip \`to_store\` only if an inbound \`end_location_type=S\` row already exists for this arrival.

## 2. CHANGE row

\`\`\`json
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
\`\`\`

Inbound S→S ends at visit start. Miles from D8 store matrix (\`prevStore-thisStore\`).

Last-stop visits seal **both** inbound S→S and outbound S→H — send both CHANGEs on **one** shift PATCH (\`sas-prod-mileage-store-to-home\`).

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-mileage-store-to-home',
  description:
    'Add store-to-home (S→H) mileage on a SAS PROD shift. Use when last stop of day, to_home {end_time}, correcting system ~31mi S-H LOG, or sealing outbound home legs.',
  body: `# Store → home mileage (S→H)

${AUTH}

## 1. Preview travel

\`POST ${BASE}/api/v2/field-app/travel/{shiftId}/to_home/\`

\`\`\`json
{ "end_time": "2026-07-20T20:26:00.000Z" }
\`\`\`

- Body is **\`{ end_time }\`** = UTC visit **stop** (HAR 2026-07-21_00-54-51).
- Do **not** send \`{ start_time, user_accepted_ss_replace }\` (that is \`to_store\` only).
- System invents ~31 mi S→H LOG. Soft-skip 5xx if needed — CHANGE still corrects miles.

## 2. CHANGE row

\`\`\`json
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
\`\`\`

Outbound S→H **starts** at visit stop. Miles from home matrix (mirrored).

When last-stop also has inbound S→S, put **both** CHANGE rows on the **same** punch PATCH.

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-complete-shift',
  description:
    'Complete a SAS PROD visit/shift (PUT shift-complete). Use when finalizing current_status completed, 406 on shift-complete, allowed_overlap error 31, or team_lead_feedback store attribution.',
  body: `# Complete the SAS PROD visit

${AUTH}

## Preconditions

Category reset must be truly complete: **photos + assignee + spent_time + category_completion**. Survey complete if required. Punch times + mileage CHANGEs landed.

## Sequence

1. Optional mid ping: \`PATCH …/shift-complete/\` \`{ "team_lead_feedback": null }\`
2. **PUT** first-time complete
3. **PATCH** repeat feedback

## PUT body

\`PATCH\`/\`PUT\` \`${BASE}/api/v1/field-app/visits/{visitId}/shift-complete/\`

\`\`\`json
{
  "allowed_overlap": false,
  "allowed_missing_ques": false,
  "allowed_truncation": false,
  "team_lead_feedback": "this is for store 19",
  "end_location": [-1, -1],
  "validate_geo": true
}
\`\`\`

- \`{ "shift_id" }\` alone → **406**.
- Error 31 overlapping time/mileage → \`allowed_*: true\` is a **human decision**.
- Final PATCH repeats the same \`team_lead_feedback\` string.

## Verify

\`GET …/shift-complete/\` → \`current_status: "completed"\`.

${ORCH}
`,
});

skills.push({
  name: 'sas-prod-shift-process',
  description:
    'Orchestrates the full SAS PROD shift process using atomic skills: start visit, category photos, assign, spent_time/exception, category complete, allocate punch time, H-S/S-S/S-H mileage, and complete shift. Use when running or debugging any end-to-end prod shift write.',
  body: `# SAS PROD shift process (orchestrator)

${AUTH}

Use this as the **index**. Each step has its own skill with exact payloads.

| Step | Skill |
|------|--------|
| Auth / session | \`sas-auth-prod-session\` |
| Start visit | \`sas-prod-start-visit\` |
| Category before/after photos | \`sas-prod-category-photos\` |
| Assign person to category | \`sas-prod-category-assign\` |
| Spent time + over-estimate reason | \`sas-prod-category-spent-time\` |
| Mark category complete | \`sas-prod-category-complete\` |
| Allocate punch times | \`sas-prod-shift-allocate-time\` |
| Home → store mileage | \`sas-prod-mileage-home-to-store\` |
| Store → store mileage | \`sas-prod-mileage-store-to-store\` |
| Store → home mileage | \`sas-prod-mileage-store-to-home\` |
| Complete shift | \`sas-prod-complete-shift\` |
| Full CP Stage-4 transmit spine | \`sas-prod-cp-shift-transmit\` |

## Recommended order (working HARs)

1. Start visit (skip if already in-progress)
2. Survey (if CP service survey required) — details in \`sas-prod-cp-shift-transmit\`
3. Category photos → \`category_completion\`
4. \`to_store\` → optional \`to_home {end_time}\` → **one** shift PATCH (times + all mileage CHANGEs)
5. Assign → spent_time (+ reason if >5%) 
6. PUT/PATCH shift-complete with store attribution feedback

## Ground-truth HARs

- \`C:/Users/tgaut/Downloads/kompass-netcap_2026-07-21_00-35-01.har\` (H→S complete)
- \`C:/Users/tgaut/Downloads/kompass-netcap_2026-07-21_00-54-51.har\` (S→S + S→H)

Never guess payloads — copy from those HARs or the atomic skill bodies.

## Implementation home

\`cp_scheduler\` \`src/lib/prod-transmitter.js\` (assemble) + \`live-executor.js\` (execute).
`,
});

// Write skills to user + cp_scheduler mirrors
for (const s of skills) {
  writeSkill(path.join(USER_SKILLS, s.name), s.name, s.description, s.body);
  writeSkill(path.join(CP_SKILLS, s.name), s.name, s.description, s.body);
  console.log('skill', s.name);
}

// Update orchestrator pointer inside existing transmit skill (append section if missing)
const transmitPath = path.join(USER_SKILLS, 'sas-prod-cp-shift-transmit', 'SKILL.md');
if (fs.existsSync(transmitPath)) {
  let t = fs.readFileSync(transmitPath, 'utf8');
  if (!t.includes('sas-prod-shift-process')) {
    t = t.trimEnd() + `\r\n\r\n## Atomic skills\r\n\r\nStep-level reusable skills (personal + cp_scheduler):\r\n\`sas-prod-shift-process\` (index), \`sas-prod-start-visit\`, \`sas-prod-category-photos\`, \`sas-prod-category-assign\`, \`sas-prod-category-spent-time\`, \`sas-prod-category-complete\`, \`sas-prod-shift-allocate-time\`, \`sas-prod-mileage-home-to-store\`, \`sas-prod-mileage-store-to-store\`, \`sas-prod-mileage-store-to-home\`, \`sas-prod-complete-shift\`.\r\n`;
    fs.writeFileSync(transmitPath, t);
    const cpTransmit = path.join(CP_SKILLS, 'sas-prod-cp-shift-transmit', 'SKILL.md');
    if (fs.existsSync(cpTransmit)) fs.writeFileSync(cpTransmit, t);
    console.log('updated sas-prod-cp-shift-transmit pointers');
  }
}

console.log('skills written', skills.length);
