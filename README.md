# DarkSpaAntibot

Web anti-bot starter built for your flow:
- React frontend (fingerprint + interaction telemetry)
- Express API (risk scoring + challenge decision)
- MongoDB (event logging)
- Railway-ready deployment config

## 1) Install

From project root:

```bash
npm install
npm run install:all
```

## 2) Configure env

Copy env templates:

- Root `.env.example` -> `.env` (mainly for server values)
- `client/.env.example` -> `client/.env`

Required server values:
- `MONGODB_URI`
- `PORT` (default `8080`)
- `CORS_ORIGIN` (default `http://localhost:5173`)
- `TURNSTILE_SECRET_KEY` (optional, needed for real Turnstile validation)
- `TURNSTILE_SITE_KEY` (optional)
- `ADMIN_API_KEY` (recommended, protects `/api/admin/*` routes)
- `TELEGRAM_BOT_TOKEN` (optional, enable per-visit alerts)
- `TELEGRAM_CHAT_ID` (optional, chat/user/group id to receive alerts)
- `TELEGRAM_NOTIFY_EVERY_VISIT` (default `true`)
- `IPINFO_TOKEN` (optional, enables ipinfo geo lookup for visitor IPs; falls back to ipwho.is)
- `AUTO_BLOCK_ENABLED` (default `true`)
- `AUTO_BLOCK_THRESHOLD` (default `3`, challenge/block events within window)
- `AUTO_BLOCK_WINDOW_MINUTES` (default `15`)

Client values:
- `VITE_API_BASE_URL` (e.g. `http://localhost:8080`)
- `VITE_TURNSTILE_SITE_KEY` (optional)
- `VITE_ADMIN_API_KEY` (must match server `ADMIN_API_KEY` for dashboard requests)
- `VITE_FINGERPRINTJS_PUBLIC_KEY` (Fingerprint.com browser token/public key)
- `VITE_FINGERPRINTJS_REGION` (optional, e.g. `us`, `eu`, `ap`)

## 3) Run local dev

```bash
npm run dev
```

- Client: http://localhost:5173
- API health: http://localhost:8080/api/health

## 4) Railway deploy

This repo includes:
- `railway.json`
- `Procfile`

Deploy as a Node service with env vars:
- `MONGODB_URI` (use Railway Mongo plugin or Atlas URI)
- `TURNSTILE_SECRET_KEY` (if using challenge verification)
- `CORS_ORIGIN` (your frontend URL)
- `TRUST_PROXY=true`

Use `npm start` as the start command.

## API endpoints

- `GET /api/health`
- `POST /api/antibot/assess`
- `GET /api/admin/summary`
- `GET /api/admin/events?limit=50&action=allow|challenge|block&source=...&country=...&device=...`
- `GET /api/admin/blacklist?limit=200`
- `POST /api/admin/blacklist`
- `DELETE /api/admin/blacklist`
- `GET /api/admin/settings/profiles`
- `GET /api/admin/settings/profiles/:profileId`
- `POST /api/admin/settings/profiles/save`
- `POST /api/admin/settings/profiles/activate`
- `GET /api/admin/settings/export/index-php?profileId=profile_1`

`/api/admin/summary` now includes:
- hourly traffic buckets (last 24h)
- source breakdown
- country breakdown
- device breakdown

## Profile-based filter settings

- You can keep multiple project profiles (e.g. `profile_1` ... `profile_7`) with custom names.
- Each profile stores:
  - human/bot redirect URLs
  - filter level and behavior thresholds
  - browser time + interaction requirements
  - challenge/block score thresholds
  - auto-blacklist thresholds
- Activate the profile you want live; assessment API will use that profile and return `redirectUrl`.

## Download index.php for cPanel

- From the dashboard `Settings` tab, choose profile and click `Download index.php`.
- Or use API export endpoint for the selected profile.
- In cPanel File Manager:
  1. Open `public_html` (or your domain docroot)
  2. Upload downloaded file
  3. Rename to `index.php` if needed
  4. Ensure your domain points to that directory

Request sample:

```json
{
  "sessionId": "sess_abc",
  "fingerprint": "ua|lang|platform|...",
  "fingerprintVisitorId": "fp_visitor_id_optional",
  "fingerprintRequestId": "fp_request_id_optional",
  "behavior": {
    "mouseMoves": 35,
    "clicks": 3,
    "keydowns": 7,
    "scrolls": 6,
    "dwellMs": 12250
  },
  "turnstileToken": "optional-token"
}
```

Response sample:

```json
{
  "success": true,
  "allow": true,
  "action": "allow",
  "score": 42,
  "reasons": ["low_interaction", "medium_velocity"],
  "profile": { "id": "profile_1", "name": "Profile 1" },
  "redirectUrl": "https://example.com/human"
}
```

## Telegram visitor notifications

When Telegram env vars are set, each `/api/antibot/assess` visit sends a detailed visitor analytics message to your Telegram chat.
The notifier includes client telemetry, headers, user-agent, and IP geolocation enrichment.
