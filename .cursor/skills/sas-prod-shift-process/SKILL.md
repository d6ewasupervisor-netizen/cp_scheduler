---
name: sas-prod-shift-process
description: >-
  Orchestrates the full SAS PROD shift process using atomic skills: start visit, category photos, assign, spent_time/exception, category complete, allocate punch time, H-S/S-S/S-H mileage, and complete shift. Use when running or debugging any end-to-end prod shift write.
---

# SAS PROD shift process (orchestrator)

Requires a live SAS prod session — see skill `sas-auth-prod-session`.

Use this as the **index**. Each step has its own skill with exact payloads.

| Step | Skill |
|------|--------|
| Auth / session | `sas-auth-prod-session` |
| Start visit | `sas-prod-start-visit` |
| Category before/after photos | `sas-prod-category-photos` |
| Assign person to category | `sas-prod-category-assign` |
| Spent time + over-estimate reason | `sas-prod-category-spent-time` |
| Mark category complete | `sas-prod-category-complete` |
| Allocate punch times | `sas-prod-shift-allocate-time` |
| Home → store mileage | `sas-prod-mileage-home-to-store` |
| Store → store mileage | `sas-prod-mileage-store-to-store` |
| Store → home mileage | `sas-prod-mileage-store-to-home` |
| Complete shift | `sas-prod-complete-shift` |
| Full CP Stage-4 transmit spine | `sas-prod-cp-shift-transmit` |

## Recommended order (working HARs)

1. Start visit (skip if already in-progress)
2. Survey (if CP service survey required) — details in `sas-prod-cp-shift-transmit`
3. Category photos → `category_completion`
4. `to_store` → optional `to_home {end_time}` → **one** shift PATCH (times + all mileage CHANGEs)
5. Assign → spent_time (+ reason if >5%) 
6. PUT/PATCH shift-complete with store attribution feedback

## Ground-truth HARs

- `C:/Users/tgaut/Downloads/kompass-netcap_2026-07-21_00-35-01.har` (H→S complete)
- `C:/Users/tgaut/Downloads/kompass-netcap_2026-07-21_00-54-51.har` (S→S + S→H)

Never guess payloads — copy from those HARs or the atomic skill bodies.

## Implementation home

`cp_scheduler` `src/lib/prod-transmitter.js` (assemble) + `live-executor.js` (execute).
