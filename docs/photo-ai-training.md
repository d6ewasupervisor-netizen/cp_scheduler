# Photo AI — after-photo sorting (Gemini)

Reps no longer manually assign category photos. Flow is:

1. **Before photos** (burst)
2. **Load / write order** (when applicable)
3. **After photos** (one burst — aisle + end caps + clip strips + wings + litter liners + Butcher Block + CP sections)
4. **Survey / time / outcome / seal**

The backend calls **Google Gemini** to map after shots into `categoryPhotos` (and thus survey image slots on transmit).

## Signup (API key)

1. Open **[https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)**
2. Sign in with Google → **Create API key**
3. Copy the key (`AIza…`)

### Wire into cp_scheduler (secret-safe)

**Do not paste the key into chat.** From the `cp_scheduler` repo (Railway CLI linked + logged in):

```powershell
npm run set-gemini-key
# or:
powershell -ExecutionPolicy Bypass -File .\scripts\set-gemini-key.ps1
# also write local .env (gitignored):
powershell -ExecutionPolicy Bypass -File .\scripts\set-gemini-key.ps1 -LocalEnv
```

The script uses a masked prompt and `railway variable set GEMINI_API_KEY --stdin` so the value never prints.

| Where | Variable | Value |
|-------|----------|--------|
| Railway → `cp_scheduler` service | `GEMINI_API_KEY` | via `npm run set-gemini-key` |
| Optional | `GEMINI_MODEL` | default `gemini-3.1-flash-lite` (script sets if missing) |
| Optional | `PHOTO_CLASSIFY_ENABLED` | set `0` to disable without removing the key |
| Local `.env` | same | use `-LocalEnv` flag on the script |

Redeploy happens automatically unless you pass `-SkipDeploy`.

### Verify the key (secret-safe)

```powershell
# Local .env + live Gemini ping (never prints the key)
npm run test-gemini-key

# Also check Railway /health after redeploy
npm run test-gemini-key:railway
```

Expect `RESULT: all checks passed`. Railway shows `classifyEnabled=true` only after a deploy that includes the photo-AI code **and** has `GEMINI_API_KEY` set.

**Why Gemini Flash-Lite?** Lowest practical vision cost (~fractions of a cent per image), free tier for training, strong enough for fixture sorting when you supply labeled examples.

## Training session (you)

Open **[/photo-training.html](/photo-training.html)** while signed in as admin (or locally with auth skip).

For each category, upload **≥3** clear Fred Meyer examples (5 is better):

| Category id | What to photograph |
|-------------|--------------------|
| `endcaps` | Full end-cap fixtures *(optional — only when rep opts into End caps / wings)* |
| `clipstrips` | Hanging clip strips with product |
| `wing-panels` | Wing panels beside end caps *(optional — same End caps / wings opt-in)* |
| `cat-litter-pan-liners` | Litter pan liner packs/bags on shelf or strip |
| `butcher-block-rack` | Butcher Block treat rack (full fixture) |
| `cp-serviced-section` | Finished Pet Care aisle / 4ft sections |

Tips:

- Vary store, angle, lighting, and distance.
- Prefer “fixture readable” over extreme close-ups of a single SKU.
- Optional notes help you later; the model mostly uses the pixels.

Examples live under `data/visit-drafts/photo-training/<categoryId>/` + `manifest.json` (on Railway this is the durable volume, so uploads survive redeploys). Legacy `data/photo-training/` is migrated automatically if present.

## API surface

| Method | Path | Who |
|--------|------|-----|
| GET | `/api/central-pet/shift-day/visit-flow/after-coach` | Rep — coaching checklist |
| POST | `/api/central-pet/shift-day/visit/photos/classify` | Rep — sort current visit afters |
| GET | `/api/central-pet/shift-day/photo-ai/status` | Admin |
| GET/POST/DELETE | `/api/central-pet/shift-day/photo-ai/training…` | Admin corpus |

Classify also runs automatically on **Finish visit** when `GEMINI_API_KEY` is set.

## Cost ballpark

With Flash-Lite and resized JPEGs, sorting one visit (~8–15 afters + few-shot examples) is typically well under **$0.01**. Training uploads are free locally; only classify calls hit Gemini.
