# bloot — Local setup

## 1. Environment variables

Create a file **`.env.local`** in the project root (same folder as `package.json`) with:

```env
# Required for sending verification emails (get key at https://resend.com)
RESEND_API_KEY=re_your_actual_key_here

# Optional: sender address (default: bloot <noreply@bloot.app>)
RESEND_FROM_EMAIL=bloot <noreply@bloot.app>

# bloot license Worker (Cloudflare D1) — optional; when set, login/register use the Worker
# Same URL as QOOTI_LICENSE_API_URL for the desktop app (no trailing slash).
BLOOT_API_URL=https://your-worker.workers.dev
# Must match the Worker's INTERNAL_SECRET (wrangler secret put INTERNAL_SECRET)
BLOOT_INTERNAL_SECRET=
```

- Replace `re_your_actual_key_here` with your real Resend API key.
- Without `RESEND_API_KEY`, the app will show: *"Email is not configured. Add RESEND_API_KEY to .env.local"*.
- Restart the dev server after creating or editing `.env.local` (`npm run dev`).

`.env.local` is gitignored; never commit it.

## 2. Database (SQLite vs Worker)

- **If `BLOOT_API_URL` and `BLOOT_INTERNAL_SECRET` are set:** registration creates a **bloot user ID** (UUID) and a **7-day qooti trial** in the Worker’s **D1** database; login verifies against D1. Sessions still use the in-memory store in dev (see [lib/sessions.ts](lib/sessions.ts)).
- **If those vars are unset in local dev:** the app uses **local SQLite** at **`data/bloot.sqlite`** via `better-sqlite3` (email, name, surname, username, hashed password). The numeric `id` is returned as `blootUserId` for local-only testing.
- **Production safety:** in production runtime, login/register now fail with a clear configuration error when the website is not connected to the Worker, so users are not accidentally created in local-only storage.

## 2b. qooti license renewal page

- **Dashboard → Billing (`/dashboard/billing#plans`)** — qooti packages with Telegram links to **@blootsupport** (pre-filled message with bloot user ID). Legacy **`/qooti-license`** redirects there.
