import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { blootCodeEmailSubject, buildBlootCodeEmailHtml } from "@/lib/email/bloot-code-email";
import { getResendFromEmail, getResendReplyTo } from "@/lib/email/resend-from";
import { setCode } from "@/lib/verification-codes";

export async function POST(request: NextRequest) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Email is not configured. Add RESEND_API_KEY to .env.local" },
      { status: 503 }
    );
  }
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const email = String(body.email || "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  setCode(email, code, "reset");
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: getResendFromEmail(),
    replyTo: getResendReplyTo(),
    to: [email],
    subject: blootCodeEmailSubject(code, "password-reset"),
    html: buildBlootCodeEmailHtml(code, "password-reset"),
  });
  if (error) {
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
