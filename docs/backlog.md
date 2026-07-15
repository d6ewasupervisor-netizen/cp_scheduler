# Backlog

Items captured here are **not** in the current build scope. They become requirements before the related capability goes live.

---

## Time-integrity for live multi-visit days

**Status:** backlog — do not build yet  
**Blocks:** multi-visit live days (not required for single-visit supervised first run / round-trip testMode)

### Rules (when built)

1. **No punch overlap per rep per day**  
   A rep’s actual start/stop windows for two visits on the same calendar day must not overlap.

2. **Consecutive-store drive time from the mileage matrix**  
   When visit B follows visit A the same day, `B.actual_start` must be ≥ `A.actual_stop` + matrix drive time (store→store), not a shortened window that steals drive time from the rep.

3. **Slide, don’t short**  
   If a conflict is detected, slide start/stop (preserve duration) rather than compressing the worked interval.

### Why later

Single-visit supervised first runs (and round-trip golden subjects 26822177 / 26822165) do not need inter-visit alignment. Multi-visit live days will.

---

## Known golden test subjects (round-trip)

| Visit id | Date | Scheduled | Decoded | Notes |
|----------|------|-----------|---------|--------|
| 26822177 | 2026-07-13 | 391 | 215 | Golden export under Downloads/cp_tests |
| 26822165 | 2026-07-13 | 391 | 111 | Golden export under Downloads/cp_tests |

Prefer first live/testMode run on **26822165**; keep **26822177** in reserve.
