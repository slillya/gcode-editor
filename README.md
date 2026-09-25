# FeedFix

A G-code backplot and feed editor that runs in the browser. Open a program, see every move in 3D colour-coded, and speed up the slow "rapids" that some CAM licences write as `G1` feed moves, without changing the toolpath.

- **Rapid** (grey, dashed) `G0` moves
- **Air move** (orange) feed moves with nothing to cut: completely at or above the safe height, or dropping straight back to a depth the tool already reached at that XY (peck re-entries, going back into a pocket)
- **Retract** (green) straight-up moves from the cut to the safe height
- **Plunge** (magenta) straight-down feed moves into material
- **Cut** (blue) every other feed move

## What it changes

Only F words. A feed number is rewritten in place, or an F word is added to a line whose move needs a different feed than the line before it (for example, the first cut after a sped-up air move gets its original feed back). Coordinates, arcs, comments, spacing, line endings, non-ASCII bytes and the line count never change.

- Air moves get the new air feed. Straight-up retracts do too unless that box is unticked (untick it for reaming or boring with a feed-out).
- Plunges and cuts keep their feed unless you change a value under **Programmed feeds**.
- Moves from an unknown position (the first move, anything after `G28`/`G53`), probing moves (`G38.x`), canned-cycle internals and inverse-time (`G93`) blocks are never sped up.
- The **safe height** is found automatically: the lowest retract or approach height above every cutting move. It is drawn as a plane in the 3D view and can be set by hand.
- Before every download the edited file is parsed again and compared move by move with the original. If any coordinate, arc or non-F byte differs, the download is blocked.

Dry-run or single-block the first run of an edited program. Most controllers cap F at the machine's maximum feed, so a feed above your machine's limit runs at the limit.

## Bug reports and feature requests

**Help → Report a bug** and **Help → Request a feature** open a form. Reports are stored in the Cloudflare D1 database `feedfix-reports` with the app version, browser and the user's current settings. For bugs, the user can choose to attach the program they have open (up to 512 KB). Each visitor is limited to 20 reports an hour, and a hidden field drops most bot submissions.

To read them:

- Open `https://<your-site>/admin` and enter the `ADMIN_TOKEN` secret. You can filter reports, download attached programs and mark each one new, seen or done.
- Or open Cloudflare dashboard → Storage & Databases → D1 → `feedfix-reports` → Console and run
  `SELECT id, created_at, kind, title, contact, status FROM reports ORDER BY id DESC;`
- Or ask Claude to check the FeedFix reports (it can query D1 through the Cloudflare connector).

## Deploying to Cloudflare

This repo is a Cloudflare Worker with static assets. The D1 database already exists and its ID is in `wrangler.jsonc`.

1. Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick `slillya/gcode-editor`. The build command can stay empty (the built site in `public/` is committed); the deploy command is `npx wrangler deploy`. Every push to the branch you pick redeploys.
   Or, from a terminal with Wrangler logged in: `npx wrangler deploy`.
2. Worker → Settings → Variables and Secrets → add a **secret** named `ADMIN_TOKEN` (a long random password for the inbox). Optionally add `REPORT_SALT` (any random text).
3. Worker → Settings → Domains & Routes → add a custom domain such as `feedfix.yoursite.com`.
   To put it in a folder of an existing site instead, add a route such as `yoursite.com/tools/feedfix/*` and a variable `BASE_PATH` = `/tools/feedfix`.

`public/index.html` is the whole app in one file. It also works on any static host or opened straight from disk; only bug reports need the Worker.

## Working on it

Needs Node 22 or later. No packages to install.

```sh
npm run dev     # http://localhost:8787 with working reports; inbox at /admin, token dev-token
npm test        # parser, feed editor and Worker tests
npm run build   # rebuild public/ after editing anything in src/
npm run check   # fails if public/ is out of date
```

| Path | What it is |
| --- | --- |
| `src/gcode-core.js` | Parser, move classifier, safe-height detection, feed planner, byte-exact writer, verifier |
| `src/viewer.js` | WebGL backplot: orbit, pan, zoom, picking, tool marker |
| `src/app.js`, `src/index.html`, `src/styles.css` | The page |
| `src/sample.js` | The demo program shown on first load |
| `src/admin.html` | Report inbox |
| `worker/index.js` | Cloudflare Worker: static site plus `/api/reports` |
| `scripts/` | Build, local dev server, D1 stand-in for tests |
| `public/` | Built site (generated, committed so Cloudflare needs no build step) |
