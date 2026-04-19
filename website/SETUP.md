# bloot — Local setup

## 1. Environment variables

Create a file **`.env.local`** in the project root (same folder as `package.json`) with:

```env
# Required for sending verification emails (get key at https://resend.com)
RESEND_API_KEY=re_your_actual_key_here

# Optional: sender address (default: bloot <noreply@bloot.app>)
RESEND_FROM_EMAIL=bloot <noreply@bloot.app>

# bloot license Worker (Cloudflare D1) — required for login, register, dashboard, verification
# Same URL as the desktop app license API (no trailing slash).
BLOOT_API_URL=https://your-worker.workers.dev
# Must match the Worker's INTERNAL_SECRET (wrangler secret put INTERNAL_SECRET)
BLOOT_INTERNAL_SECRET=

# JWT signing secret for session cookies (openssl rand -hex 32)
JWT_SECRET=

# Public site URL (used for SEO / absolute links where needed)
NEXT_PUBLIC_SITE_URL=https://bloot.app

# Optional: GitHub token for /api/download/latest (private releases)
# GITHUB_TOKEN=
```

- Replace `re_your_actual_key_here` with your real Resend API key.
- Without `RESEND_API_KEY`, the app will show: *"Email is not configured. Add RESEND_API_KEY to .env.local"*.
- `BLOOT_API_URL` + `BLOOT_INTERNAL_SECRET` are required for auth, dashboard data, and email/reset verification (Worker + D1).
- `JWT_SECRET` is required for signed session cookies (`bloot_session`).
- Restart the dev server after creating or editing `.env.local` (`npm run dev`).

`.env.local` is gitignored; never commit it.

## 2. Cloudflare Pages (`@cloudflare/next-on-pages`)

Install uses `legacy-peer-deps` because the adapter expects a slightly newer Next semver than 14.2.x; CI/Linux builds should run:

- **Build command:** `npm run pages:build` (runs the Vercel-style build the adapter needs, then emits `.vercel/output/static`).
- **Output directory:** `.vercel/output/static`
- **Project root:** `website` (if the repo root is the monorepo).
- **Functions:** enable **Node.js compatibility** (`nodejs_compat`), matching [wrangler.toml](wrangler.toml).

**Local preview after a successful `pages:build`:**

```bash
npm run pages:dev
```

On Windows, the adapter may invoke tooling that expects a Unix shell; if `pages:build` fails locally, use WSL or rely on Cloudflare’s Linux build image.

## 3. qooti license renewal page

- **Dashboard → Billing (`/dashboard/billing#plans`)** — qooti packages with Telegram links to **@blootsupport** (pre-filled message with bloot user ID). Legacy **`/qooti-license`** redirects there.
