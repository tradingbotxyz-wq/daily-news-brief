# Handover: Daily News Brief app

Context for the next Claude chat that continues this project.

## The goal
The owner (GitHub: `tradingbotxyz-wq`, based in Bhubaneswar, Odisha) wants a news app:
- A **web portal** plus an **installable mobile app (PWA)** that shows a daily news summary.
- **Free + Premium tiers.** Free readers get local, national and world news. Premium unlocks the markets and stock sections (Razorpay, ₹99 for 30 days; demo mode until keys are added).
- **Push notifications** to subscribers' phones whenever a brief is published.
- **Admin review first.** Claude's scheduled task posts each brief as a **draft**. The owner approves it in `/admin.html`, and publishing sends the push notifications.

## Status (8 Nov 2026)
- **The code is complete and tested.** This zip is the latest version. All 20 automated tests pass (`npm test`): the full suite runs once against a local SQLite file and once against a fake Turso server. The browser end-to-end check also passed.
- **Zero npm dependencies.** Needs Node 22.13 or later. It uses `node:sqlite`, `crypto`, `http` and `zlib`. App icons are drawn in code (`lib/icons.js`), so the repo has no binary files.
- **Database:** Turso over its HTTP API (Hrana v2 `/v2/pipeline`) when `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set; otherwise a local file in `DATA_DIR`. The session secret and the VAPID push keys are stored in the database's `settings` table.
- **Hosting plan:** Render **free** plan (`render.yaml`, Docker, Singapore) plus a **Turso free** database. The owner did not want to pay for Render Starter.
- **Not yet tested against the real services:** Turso (only the fake server), real phone push delivery, and live Razorpay payments.

## GitHub repo: github.com/tradingbotxyz-wq/daily-news-brief (public)
- The owner uploaded the **first version** by hand, and all 24 of those files matched byte for byte.
- **10 files on GitHub are out of date.** The owner still needs to upload them over the old ones:
  `.env.example`, `README.md`, `lib/db.js`, `lib/webpush.js`, `package.json`, `render.yaml`, `server.js`, `test/app.test.js`, `test/fake-turso.js` (new), `test/turso.test.js` (new).
- **Push the whole project in one commit**, overwriting those 10 files. Also add this HANDOVER.md, or leave it out if the owner prefers. In the previous chat, the GitHub connector could read the repo but every write failed with `403 Resource not accessible by integration`, even after the owner changed the app's permissions. A new chat may get fresh access.
- To check the push, compare each file's `git hash-object` with the blob SHAs from `get_file_contents`.

## Remaining steps for the owner (one time, about 10 minutes, on a computer)
1. **Turso** (turso.tech, sign up with GitHub): create database `daily-news-brief` in the Mumbai region, copy its `libsql://` URL, and create a token with no expiry. The owner should **not** paste the token into chat.
2. **Render** (render.com, sign up with GitHub): **New → Blueprint** → `daily-news-brief`. Fill in:
   - `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`
   - `VAPID_SUBJECT` = `mailto:<email>`
   - Leave both Razorpay fields empty, then click **Apply**.
3. **Send Claude** the live URL and the generated `INGEST_API_KEY` (in Render, open the service → **Environment**).
4. **Optional:** set up UptimeRobot to ping `/api/health` every 5 minutes, so the free instance doesn't sleep.

## After it's live (Claude's job)
- Check the live site with `/api/health`. It should return `{"db":"Turso"}`.
- Update the existing scheduled task **"Daily news summary"** (`trig_015ujuQkDumK86rnTA14uWPT`, runs daily at 06:41 IST, auto-approve, push notifications on). Change it so that, besides messaging the owner, it POSTs the brief to `<URL>/api/ingest` with `Authorization: Bearer <INGEST_API_KEY>` and the body `{date, markdown}`. Each `## Heading` becomes a section. Headings that match `market|stock` are Premium by default.
  - The owner also asked for a stocks-focused format: world markets and company highlights first, then India highlights. Consider adding a Markets section in that order.
  - Before relying on it, check that the scheduled task's cloud sandbox can reach the `onrender.com` host. Outbound traffic goes through a proxy that may block some hosts.
- **Possible later work:** Razorpay keys, a custom domain, OTP login by phone, an Odia-language edition, and a Play Store release via a Trusted Web Activity (Bubblewrap).

## Owner preferences
- They are often on a phone and want minimal manual steps. Give them short, numbered click-by-click instructions.
- They want free hosting where possible.
- App name in the UI: "Daily Brief". The repo and service are named `daily-news-brief`. Ask whether the UI should say "Daily News Brief".
