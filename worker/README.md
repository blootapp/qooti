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
```

Replace `qooti` with your database name if different. Migration 0002 adds `revoked_at`, `license_devices`, and `admin_logs`.

## 3. Set the admin secret

Pick a long random string (e.g. `openssl rand -hex 32`) and set it as a secret:

```bash
npx wrangler secret put ADMIN_SECRET
```

Paste your secret when prompted. This is the value you’ll enter in the **Admin secret** field of the admin page.

## 4. Log in and deploy

```bash
npx wrangler login
npx wrangler deploy
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
| `/admin/licenses` | GET | Admin | Paginated list, search (query: `page`, `limit`, `search`, `status`, `plan_type`) |
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
