# Daily Brief: news portal + mobile app

The daily news summary written by Claude reaches readers in two ways:

- **Web portal:** anyone can read the free sections.
- **Mobile app (PWA):** readers install it on Android or iPhone from the browser. Signed-in subscribers get a **push notification** each time a brief is published.

**Free and Premium plans.** Free readers see local, national and world news. Sections marked **Premium** (by default, any heading containing "market" or "stock") are locked, and readers see only a short teaser. Premium subscribers pay through **Razorpay** (UPI, cards, net-banking). If Razorpay keys aren't set, the app runs in demo mode, where upgrading costs nothing.

**Admin review.** Claude posts each brief as a **draft**. You open the admin panel, edit it, tick which sections are Premium, and click **Approve & publish**. That publish sends the push notification to every subscribed phone.

```
Claude scheduled task ──POST /api/ingest──▶ Draft ──(you approve in /admin.html)──▶ Published
                                                                                   ├─▶ Portal + app
                                                                                   └─▶ Push to phones
```

## Run it locally

You need Node.js 22.13 or later. There are no npm packages to install.

```bash
cp .env.example .env      # set ADMIN_EMAIL, ADMIN_PASSWORD, INGEST_API_KEY
npm start                 # http://localhost:3000  ·  admin: http://localhost:3000/admin.html
npm test                  # 8 automated tests
```

On first start, the app creates your admin account and two sample briefs: one published and one draft waiting for review.

## Go live (needed before the mobile app can be installed or send push notifications)

Phones only allow installing the app and receiving notifications over **HTTPS**. Choose one:

- **Render / Railway / Fly.io:** create a Node web service from this folder with the start command `npm start`. Attach a **persistent disk** mounted at `/app/data` and set `DATA_DIR=/app/data`.
- **A small VPS** (for example DigitalOcean or Hostinger, about ₹400–800 a month): run `npm start` under `pm2` or `systemd`, with Caddy or Nginx in front to provide automatic HTTPS.

Then set these values in `.env`:
- `PUBLIC_URL`
- `SECURE_COOKIES=true`
- a strong `ADMIN_PASSWORD`
- `INGEST_API_KEY` (generate one with `openssl rand -hex 32`)

Back up the `data/` folder. It holds the database and the push-notification keys. If the push keys are lost, every phone has to subscribe again.

## Connect Claude (automatic drafts)

```bash
PORTAL_URL=https://your-site INGEST_API_KEY=... ./scripts/post-brief.sh brief.md 2026-11-07
```

You can also send a `POST` request to `/api/ingest` with the header `Authorization: Bearer <INGEST_API_KEY>` and one of these JSON bodies:
```json
{ "date": "2026-11-07", "markdown": "# News brief — 7 Nov\n\n## Local\n- ...\n\n## Markets\n- ..." }
```
or, if you want to set the Premium sections yourself:
```json
{ "title": "...", "date": "2026-11-07", "sections": [{ "heading": "Local", "body_md": "- ...", "premium": false }] }
```
Every `## Heading` becomes its own section.

## Turn on real payments (Razorpay)

1. Create a Razorpay account and complete KYC. Copy the **Key ID** and **Key Secret** into `.env`.
2. Set the price with `PREMIUM_PRICE_PAISE` (for example, `9900` is ₹99) and the plan length with `PREMIUM_DAYS`.
3. Readers click **Go Premium**, and the Razorpay checkout window opens. The server checks the payment signature before it unlocks Premium.

This version charges once for a fixed period. Auto-renewing subscriptions would use Razorpay Subscriptions and webhooks, which can be added next.

## Features

| Area | What it does |
|---|---|
| Accounts | Sign-up and login with email and password. Passwords are hashed with scrypt, sessions use signed HTTP-only cookies, and login is rate-limited. |
| Reader | Today's brief, an archive, and offline reading of briefs opened before. Premium sections stay locked for free readers. |
| Mobile app | Installs to the home screen on Android and iPhone (iOS 16.4+ for notifications). Has an app icon and opens full-screen. |
| Push | Standard Web Push (VAPID). Works with Chrome, Edge and Firefox on Android and desktop, and with Safari for apps added to the iPhone home screen. |
| Admin | Dashboard showing subscriber, Premium and alert counts. Drafts can be edited section by section with a Premium toggle, then published (with or without a notification), unpublished or deleted. |
| Security | Blocks requests from other websites (CSRF guard) and escapes all Markdown to prevent injected scripts. Locked content never leaves the server, and the API key is compared in constant time. |

## Files

```
server.js            API, auth, billing, ingest, admin, static files
lib/db.js            SQLite schema (Node's built-in node:sqlite)
lib/webpush.js       Web Push encryption (RFC 8291) + VAPID signing (RFC 8292)
lib/markdown.js      Safe Markdown → HTML renderer
public/              Reader app (index.html, app.js, sw.js, manifest) + admin panel
scripts/post-brief.sh  Post a Markdown brief as a draft
test/                Automated tests (npm test)
seed/                Sample briefs used on first run
```

## Possible next steps
- Use a custom domain and your own app name, colours and logo (edit the CSS variables in `public/styles.css`).
- Add OTP login by phone using MSG91 or Twilio. Many Indian readers prefer this to email and password.
- Send Premium readers a morning email digest.
- Publish to the Play Store by packaging this PWA as a Trusted Web Activity with Bubblewrap. No code changes are needed.
- Add an Odia-language version of each brief.

## Deploy on Render (recommended)

This repo includes `render.yaml` and a `Dockerfile`.

1. Sign in at [render.com](https://render.com) with GitHub and allow access to this repository.
2. Click **New → Blueprint** and pick this repository. Render reads `render.yaml`.
3. When asked, enter `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `VAPID_SUBJECT` (`mailto:you@example.com`). Leave Razorpay blank for demo mode.
4. Click **Apply**. In a few minutes the app is live at `https://daily-news-brief-xxxx.onrender.com` with HTTPS.
5. Open **Environment** in Render and copy the generated `INGEST_API_KEY`. Claude needs it to post drafts.

It uses the Starter plan (about US$7 a month) with a 1 GB disk. A disk is needed because Render's free plan erases files on every restart, which would delete your subscribers.
The `Dockerfile` also works on Railway, Fly.io or any VPS. Mount a volume at `/app/data`.
