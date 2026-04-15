import { getSiteUrl } from "@/lib/seo/site";

export type BlootCodeEmailVariant = "account-verify" | "password-reset";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Public absolute URL for logo in HTML (light/white mark on dark card). */
export function getBlootEmailLogoUrl(): string {
  const fromEnv = process.env.RESEND_EMAIL_LOGO_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return `${getSiteUrl()}/assets/bloot.png`;
}

const COPY: Record<
  BlootCodeEmailVariant,
  {
    eyebrow: string;
    headline: string;
    bodyHtml: string;
    codeBlockCaption: string;
    subjectLine: string;
  }
> = {
  "account-verify": {
    eyebrow: "TASDIQLASH KODI",
    headline: "Hisobingizni tasdiqlang",
    bodyHtml: `bloot hisobingizga kirish uchun quyidagi tasdiqlash kodini kiriting. Bu kod <strong style="color:rgba(240,240,238,0.65); font-weight:500;">5 daqiqa</strong> davomida amal qiladi.`,
    codeBlockCaption: "Tasdiqlash kodi",
    subjectLine: "tasdiqlash kodingiz",
  },
  "password-reset": {
    eyebrow: "PAROL TIKLASH",
    headline: "Parolingizni tiklang",
    bodyHtml: `Parolni tiklash uchun quyidagi kodni kiriting. Bu kod <strong style="color:rgba(240,240,238,0.65); font-weight:500;">5 daqiqa</strong> davomida amal qiladi.`,
    codeBlockCaption: "Tiklash kodi",
    subjectLine: "parol tiklash kodingiz",
  },
};

export function blootCodeEmailSubject(code: string, variant: BlootCodeEmailVariant): string {
  const line = COPY[variant].subjectLine;
  return `bloot: ${line} — ${code}`;
}

/**
 * Dark-branded HTML for 6-digit codes. Tables + inline styles for Gmail / Apple Mail / Outlook.
 * Max content width 560px per design spec.
 */
export function buildBlootCodeEmailHtml(code: string, variant: BlootCodeEmailVariant): string {
  const safeCode = escapeHtml(code);
  const c = COPY[variant];
  const logoUrl = escapeHtml(getBlootEmailLogoUrl());
  const site = escapeHtml(getSiteUrl());

  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <title>bloot — Tasdiqlash kodi</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; background-color: #0f0f0f; }
    @media screen and (max-width: 600px) {
      .card { border-radius: 0 !important; }
      .outer-pad { padding: 0 !important; }
    }
  </style>
</head>
<body style="background-color:#0f0f0f; margin:0; padding:0;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" class="outer-pad" style="padding: 48px 20px;">

        <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0"
          style="max-width:560px; background-color:#111111; border-radius:16px; border:1px solid rgba(255,255,255,0.07); overflow:hidden;">

          <tr>
            <td align="center" style="padding: 36px 40px 28px;">
              <img
                src="${logoUrl}"
                alt="bloot"
                width="72"
                style="display:block; width:72px; height:auto;"
              />
            </td>
          </tr>

          <tr>
            <td style="padding: 0 40px;">
              <div style="height:1px; background:rgba(255,255,255,0.06);"></div>
            </td>
          </tr>

          <tr>
            <td style="padding: 36px 40px 12px;">
              <p style="margin:0 0 8px; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:13px; font-weight:500; color:rgba(240,240,238,0.35); letter-spacing:0.06em; text-transform:uppercase;">
                ${c.eyebrow}
              </p>
              <h1 style="margin:0 0 16px; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:22px; font-weight:600; color:#f0f0ee; letter-spacing:-0.03em; line-height:1.2;">
                ${c.headline}
              </h1>
              <p style="margin:0 0 32px; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:14px; font-weight:300; color:rgba(240,240,238,0.45); line-height:1.65;">
                ${c.bodyHtml}
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 0 40px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center"
                    style="background-color:#0a0a0a; border:1px solid rgba(255,255,255,0.09); border-radius:12px; padding:28px 20px;">
                    <p style="margin:0 0 6px; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:11px; font-weight:500; color:rgba(240,240,238,0.25); letter-spacing:0.08em; text-transform:uppercase;">
                      ${c.codeBlockCaption}
                    </p>
                    <p style="margin:0; font-family:'Courier New',Courier,monospace; font-size:38px; font-weight:700; color:#f0f0ee; letter-spacing:0.18em; line-height:1;">
                      ${safeCode}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 0 40px 36px;">
              <p style="margin:0; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:12.5px; font-weight:300; color:rgba(240,240,238,0.28); line-height:1.6; text-align:center;">
                Agar siz bu so'rovni yubormagan bo'lsangiz — ushbu emailni e'tiborsiz qoldiring.<br/>
                Hisobingiz xavfsiz.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 0 40px;">
              <div style="height:1px; background:rgba(255,255,255,0.06);"></div>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding: 24px 40px;">
              <p style="margin:0 0 6px; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:12px; font-weight:300; color:rgba(240,240,238,0.2); line-height:1.5;">
                bloot tomonidan yuborildi &middot;
                <a href="${site}" style="color:rgba(240,240,238,0.2); text-decoration:none;">bloot.app</a>
                &middot;
                <a href="https://t.me/blootsupport" style="color:rgba(240,240,238,0.2); text-decoration:none;">Yordam</a>
              </p>
              <p style="margin:0; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:11px; font-weight:300; color:rgba(240,240,238,0.12);">
                noreply@bloot.app
              </p>
            </td>
          </tr>

        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          <tr>
            <td align="center" style="padding-top:20px;">
              <p style="margin:0; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; font-size:11px; color:rgba(240,240,238,0.12); font-weight:300;">
                &copy; 2026 bloot. Barcha huquqlar himoyalangan.
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}
