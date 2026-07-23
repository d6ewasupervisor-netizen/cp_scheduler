# Client hotfix auto-update

Field devices keep the Shift Day / Planning tabs open for hours. After a Railway deploy they would otherwise stay on stale HTML/JS until a manual refresh.

## How it works

Same pattern as the EOD app (`the-dump-bin/EOD`):

1. Each page loads `/hotfix.js`, which embeds `CP_APP_VERSION`.
2. Every **2 minutes** (and on tab focus) the client fetches `/app-version.json?t=…` with `cache: 'no-store'`.
3. If the remote `version` differs from the embedded constant, a banner appears and the page **auto-reloads** after ~3.5s with a cache-busting query (`?cpv=&_=`).
4. If a reload already ran for that remote version but the tab is still stale, the banner asks for a **hard refresh** instead of looping.
5. If the live camera overlay is open, reload is deferred until the camera closes (next poll).

Visit drafts and uploaded photos are on the server, so a reload does not lose sealed progress.

## Shipping an update

In the **same commit**:

1. Change app code under `public/` / `src/` as needed.
2. Bump **both**:
   - `public/app-version.json` → `{ "version": "x.y.z" }`
   - `public/hotfix.js` → `CP_APP_VERSION = 'x.y.z'`
3. Commit and push `main` (Railway redeploys).
4. Open tabs pick up the new version within about two minutes.

If you bump only one of the two files, devices will either never update or reload-loop until the hard-refresh fallback.

## Cache headers

`src/server.js` serves `app-version.json` and `.html` with `Cache-Control: no-store`, and JS/CSS with `no-cache` so a hotfixed reload revalidates assets.
