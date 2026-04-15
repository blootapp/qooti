# Qooti License Worker

Cloudflare Worker that handles license validation for the Qooti app and admin routes for adding/checking keys. Uses **D1** for storage.

## 1. Create the D1 database (if you don’t have one)

In [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **D1** → **Create database**:

- Name: `qooti-license-db` (or any name)
- After creation, open the database and copy its **Database ID** (e.g. `45d1a962-...`)

Put that ID in `wrangler.toml` under `[[d1_databases]]` → `database_id`.

If you already created a database (e.g. the one you used for Qooti), use its name and ID in `wrangler.toml` and skip creating a new one.

## 2. Create tables in D1

From the **worker** folder in your project:

```bash
cd worker
npx wrangler d1 execute qooti --remote --file=./migrations/0001_create_licenses.sql
npx wrangler d1 execute qooti --remote --file=./migrations/0002_admin_redesign.sql
npx wrangler d1 execute qooti --remote --file=./migrations/0003_notifications.sql
npx wrangler d1 execute qooti --remote --file=./migrations/0004_bloot_users_trials.sql
npx wrangler d1 execute qooti --remote --file=./migrations/0005_single_device_limit.sql
npx wrangler d1 execute qooti --remote --file=./migrations/0006_bloot_public_id.sql
```

Replace `qooti` with your database name if different. Migration 0002 adds `revoked_at`, `license_devices`, and `admin_logs`. **0004** adds Bloot `users`, `trial_device_claims`, and extends `licenses` with `email`, `app_id`, and `trial` plan type (rebuilds `licenses`; backs up `license_devices`). **0005** enforces a single-device policy (`device_limit = 1`) for Qooti licenses. **0006** adds user-facing `public_id` (format `BLT-xxxx-xxxx-xxxx`) and migrates trial license keys to use public IDs.

## 3. Set the admin secret

Pick a long random string (e.g. `openssl rand -hex 32`) and set it as a secret:

```bash
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put INTERNAL_SECRET
```

- **ADMIN_SECRET** — value for the license **admin** page (`X-Admin-Secret`).
- **INTERNAL_SECRET** — long random string shared with the **Bloot website** only (`X-Internal-Secret` on `POST /bloot/internal/register`). Set the same value in the site’s `BLOOT_INTERNAL_SECRET` env var.

## 4. Log in and deploy

```bash
npx wrangler login
npx wrangler deploy --config ./wrangler.toml
```

When deploy finishes, Wrangler prints the Worker URL, e.g.:

**`https://qooti-license.<your-subdomain>.workers.dev`**

That URL is your **Worker base URL**. Use it in:

- **Qooti app**: set env var `QOOTI_LICENSE_API_URL` to this URL (no trailing slash).
- **Admin page**: Configuration → Worker base URL → paste this URL → Save config. Use the same secret you set in step 3 for **Admin secret**.

## 5. Add a license and test

1. Open the admin page (`admin/index.html`).
2. Set **Worker base URL** and **Admin secret** → **Save config**.
3. **Add license**: enter a key (e.g. `QOOTI-TEST-1234`), plan, device limit → **Add license**.
4. In the Qooti app, set `QOOTI_LICENSE_API_URL` to the Worker URL and enter that key on the license screen → it should activate.

## Routes

| Route | Method | Who | Description |
|-------|--------|-----|-------------|
| `/license/validate` | POST | Qooti app | Validate key + device, register device if under limit |
| `/license/status` | GET | Qooti app | Background re-check (query: `license_key`, `device_fingerprint`) |
| `/bloot/internal/register` | POST | Website (server) | Create Bloot user + 7-day Qooti trial (`X-Internal-Secret`, body: email, passwordHash, name, surname, username) |
| `/bloot/login` | POST | Website (server) | Login (body: `identifier` = username/email, `password`); returns `blootUserId` (`public_id`) |
| `/bloot/internal/reset-password` | POST | Website (server) | Reset password by email (`X-Internal-Secret`, body: email, passwordHash) |
| `/admin/licenses` | GET | Admin | Paginated list, search (query: `page`, `limit`, `search`, `status`, `plan_type`) |
| `/admin/users` | GET | Admin | Bloot website accounts from D1 (query: `page`, `limit`, `id` exact internal id or `public_id`, `email` substring) |
| `/admin/licenses` | POST | Admin | Create license (body: `planType`, `durationYears`, `deviceLimit`) – backend generates key |
| `/admin/licenses/:key` | GET | Admin | Full license details + devices |
| `/admin/licenses/:key` | PATCH | Admin | Edit plan, expiry, device limit |
| `/admin/licenses/:key/revoke` | POST | Admin | Revoke license |
| `/admin/licenses/:key/devices/reset` | POST | Admin | Reset all devices |
| `/admin/licenses/:key/devices/revoke` | POST | Admin | Revoke one device (body: `device_fingerprint`) |
| `/admin/logs` | GET | Admin | Admin audit log (query: `page`, `limit`) |

## Troubleshooting

- **“License server not configured”** in the app → set `QOOTI_LICENSE_API_URL` to the Worker URL.
- **“Unauthorized”** on admin page → `ADMIN_SECRET` in the Worker must match the Admin secret in the page.
- **“Database error”** / **“table licenses not found”** → run the migration (step 2) against the same DB name as in `wrangler.toml`.
