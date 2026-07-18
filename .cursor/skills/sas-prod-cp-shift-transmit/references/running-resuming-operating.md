# Running, resuming, and operating the transmit

How to actually execute a transmit against prod, resume a partial, and the
Railway/SSH/tooling gotchas that will otherwise cost you an hour each.

## The one-shot script pattern (the reliable way to run it)

A committed script under `cp_scheduler/scripts/live-oneshot-*.js` that:
1. `visitDraftStore.getDraft(repKey, date, actualStore)` — load the sealed draft.
2. Builds `matchedVisit` **directly** (bypasses the matcher — see below).
3. `transmitVisit({ sealedRecord, matchedVisit, opts:{ timeChangeComment } })` — assemble.
4. Writes the assembled calls to `dryrunStore`, sets a one-draft allowlist.
5. `executeLiveTransmit({ dryRunId, visitFile, draftId, confirmStore, mode })`.
6. Clears the allowlist after (success or fail).

Reference implementations already in the repo: `scripts/live-oneshot-james-17-direct.js`
(matcher-bypass, full run + `--resume`) and `scripts/live-oneshot-james-fm53.js`
(matcher-based). Copy one and change `DRAFT_ID`, the visit/shift ids, dates, store.

### Why bypass the matcher

`matchVisits` only matches **not-yet-started** visits. Once the start PATCH lands,
the visit is `in-progress` and the matcher returns `unmatched` — so you can no
longer pick it up to finish it. Construct `matchedVisit` yourself:

```js
const matchedVisit = {
  status: 'matched',
  appShift: { id: '…', repKey, date, actualStore },
  prodVisit: { visitId, shiftId, scheduledStore, actualStore, repKey, workdayGivenId, visitStatus: 'in-progress' },
};
```

`transmitVisit` only reads `visitId`, `shiftId`, `scheduledStore`, `actualStore`
off `prodVisit`. If you DO use the matcher (`runDryRun`), pass **`weekStart` = the
fiscal-week Sunday** (e.g. 2026-07-17 → `2026-07-12`) or you get
`not_in_matcher_scope`.

## Running on the prod container (SSH)

Runs on Railway (the volume + SAS session live there). Needs the SSH key
`~/.ssh/railway_cursor_ed25519` registered with Railway (`railway ssh keys`).
Project id `87a6a33f-6dd8-4335-8f33-672ed03b0508`, service `cp_scheduler`, env `production`.

```bash
railway ssh -i ~/.ssh/railway_cursor_ed25519 --service cp_scheduler \
  --project 87a6a33f-6dd8-4335-8f33-672ed03b0508 --environment production \
  -- sh -c "cd /app; LIVE_TRANSMIT=1 /mise/shims/node /app/scripts/<one-shot>.js"
```

**Dry-run first** (read-only, no writes): add `--dry-only` to the one-shot; it
prints the assembled sequence so you can eyeball payloads before sending.

## The deploy cycle (you cannot upload ad-hoc code)

Iterate by **commit → push `main` → Railway auto-deploys → run the committed
script**. You cannot `node -e "writeFileSync(...)"` arbitrary code onto the
container — the safety classifier blocks that as remote code execution. So every
probe/fix must be a committed script. Wait for the deploy, then `railway ssh` the
committed file. Confirm the new code is live by grepping the deployed file for a
marker string, e.g.:

```bash
railway ssh … -- sh -c "cd /app; grep -q MY_MARKER scripts/x.js && /mise/shims/node scripts/x.js || echo NOTYET"
```

## Resuming a partial transmit

- The executor persists partial state in the transmit **registry**, now on the
  **durable volume**: `data/visit-drafts/transmitted-registry.json` (was
  `live/…`, which is ephemeral and wiped on every deploy). Volume-backing lets a
  partial survive a redeploy so you can resume after fixing a call.
- Resume with the one-shot's `--resume` (executor `mode:'resume'`): it reads
  `lastSuccessfulSeq` from the registry and restarts at `lastOk+1`, restoring
  prior `stepResults` for dependency resolution.
- **DANGER — seq drift:** resume uses *absolute* seq numbers. If the assembly
  **changes size** between runs (e.g. `to_store`/`to_home` get skipped because
  travel now exists), the seq→call mapping shifts and resume can skip the real
  remaining calls and **falsely report `complete`**. Symptoms: `status:"complete"`
  with `callsSent:0` and a smaller `calls` count than before. **Always verify the
  actual PROD `current_status`** after a resume — don't trust the executor's
  "complete" if the assembly size changed. When in doubt, finish the last calls
  with a targeted direct script (like `_finish-james-17.js`) instead of resuming.
- **Never restart from seq 1 after partial success** — survey answers and photos
  are POST-creates and will **duplicate** in PROD.

## Auto-mode classifier gotchas (Claude Code / agents)

The safety classifier blocks live-payroll writes and remote code execution. What
that means in practice:

- You need **Bash allow-rules** for the commands it denies. Add via `/permissions`
  (or `~/.claude/settings.json` `permissions.allow`):
  `Bash(railway ssh:*)`, `Bash(railway up:*)`, `Bash(git push:*)`,
  `Bash(git commit:*)`, `Bash(git add:*)`.
- The agent **cannot self-grant** — editing the settings file to add its own
  permissions is blocked. The **user** must add the rules.
- Allow-rules match the **command prefix**. `cd x && railway ssh …` or
  `sleep 5 && railway ssh …` do **not** match `Bash(railway ssh:*)` — start the
  command with `railway ssh`. (`cd`-prefixed compounds sometimes pass, `sleep`-prefixed don't.)
- Even with rules, it still hard-blocks: `node -e writeFileSync` uploads, and
  **force-completing with `allowed_overlap:true`** (overriding a payroll warning).
  Those need a human.
- Blocks are often **transient** ("Stage 2 classifier error … retrying often
  succeeds") — retry the exact command once or twice.

## git-bash / shell gotchas (Windows)

- **Path mangling:** git-bash rewrites a leading `/mise/shims/node` to a Windows
  path. Prefix the remote command with `cd /app;` so the string doesn't start
  with `/…` — e.g. `sh -c "cd /app; /mise/shims/node …"`.
- **SSH env dump:** the container's login shell prints its **entire environment
  (including secrets)** at connect. Filter with `| grep -v '^export '`. Treat that
  output as sensitive — never echo it back; consider rotating keys if a transcript
  with it is shared.
- Foreground `sleep` is blocked in some harnesses; poll with a background
  `run_in_background` command or a `Monitor` until-loop instead.

## Capturing the exact SAS error (essential for diagnosis)

The registry does **not** store response bodies. To see why a call failed, run a
committed probe that reproduces the single call and prints the response:

```js
const { defaultSasFetch } = require('/app/src/lib/live-executor');
const { loadSasSession } = require('/app/src/lib/sas-session');
const s = await loadSasSession();
const headers = { Accept:'application/json','X-Requested-With':'XMLHttpRequest','Content-Type':'application/json',
  Authorization:'Token '+s.token, 'X-CSRFToken':s.csrfToken, Cookie:s.cookieHeader };
const r = await defaultSasFetch(url, { method:'PATCH', headers, body });
console.log(r.status, JSON.stringify(r.body));
```

Then grep `prod completio7n.har` for that endpoint and match its body byte-for-byte.
See `scripts/_probe10.js` and `scripts/_finish-james-17.js` for working examples.
