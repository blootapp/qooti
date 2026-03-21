# Qooti License Admin

Simple local webpage to **add** and **check** license keys stored in Cloudflare D1.

## How to use

1. Open `index.html` in your browser (double-click or `file:///.../admin/index.html`).
2. In **Configuration**, enter:
   - **Worker base URL**: your Cloudflare Worker URL (e.g. `https://qooti-license.workers.dev`).
   - **Admin secret**: a secret you define; the Worker must require it in the `X-Admin-Secret` header for admin routes.
3. Click **Save config** (stored in this browser’s localStorage only).
4. **Add license**: fill key, plan, optional expiry, device limit → **Add license**.
5. **Check status**: paste a key → **Check status** to see the license record from D1.

## Worker routes required

Your Cloudflare Worker must expose these **admin** routes and protect them with `X-Admin-Secret`.

### 1. Add a license — `POST /admin/licenses`

- **Header**: `X-Admin-Secret: <your-secret>`
- **Body** (JSON):
  ```json
  {
    "licenseKey": "QOOTI-XXXX-YYYY-ZZZZ",
    "planType": "lifetime",
    "expiresAt": 253402300799,
    "deviceLimit": 3
  }
  ```
  - `licenseKey` (required), `planType` (`lifetime` | `yearly`), `expiresAt` (Unix seconds, optional), `deviceLimit` (optional, default 3).
- **Success**: status 200, body e.g. `{ "ok": true }`.
- **Error**: status 4xx, body e.g. `{ "error": "message" }`.

### 2. Check status — `GET /admin/licenses/:key`

- **Header**: `X-Admin-Secret: <your-secret>`
- **URL**: key can be path segment (percent-encoded) or query param; your Worker decodes it.
- **Success**: status 200, body with license info from D1, e.g.:
  ```json
  {
    "license_key": "QOOTI-XXXX-YYYY-ZZZZ",
    "plan_type": "lifetime",
    "expires_at": 253402300799,
    "valid": true,
    "device_limit": 3
  }
  ```
- **Not found**: status 404, body e.g. `{ "error": "License not found" }`.

## CORS

When opening the page from `file://`, the browser may send `Origin: null`. Your Worker should allow admin requests when `X-Admin-Secret` is valid, e.g.:

- Allow `Origin: null` for admin paths, or
- Use a simple local server (e.g. `npx serve admin`) and allow that origin.

Example CORS for admin (after checking secret):

```js
// After verifying X-Admin-Secret for /admin/* routes:
headers.set("Access-Control-Allow-Origin", request.headers.get("Origin") || "*");
headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");
```

## Example Worker code

See `worker-admin.example.js` for minimal admin route handlers you can add to your existing Worker (D1 binding + env for `ADMIN_SECRET`).
