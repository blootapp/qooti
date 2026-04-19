import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { blootCodeEmailSubject, buildBlootCodeEmailHtml } from "@/lib/email/bloot-code-email";
import { getResendFromEmail, getResendReplyTo } from "@/lib/email/resend-from";
import { internalPasswordResetPrepare, isBlootInternalApiConfigured } from "@/lib/bloot-internal-api";

export const runtime = "edge";

const GENERIC_OK = {
  ok: true,
  message: "If an account exists for that address, you will receive an email with a reset code shortly.",
};

function isValidEmailFormat(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

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
  if (!isValidEmailFormat(email)) {
    return NextResponse.json(GENERIC_OK, { status: 200 });
  }

  if (!isBlootInternalApiConfigured()) {
    return NextResponse.json(GENERIC_OK, { status: 200 });
  }

  const prep = await internalPasswordResetPrepare(email);
  if (!prep.ok) {
    if (prep.status === 429) {
      return NextResponse.json(
        { error: "Too many reset requests. Try again later." },
        { status: 429 }
      );
    }
    return NextResponse.json(GENERIC_OK, { status: 200 });
  }

  if (prep.shouldSendEmail && prep.code) {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: getResendFromEmail(),
      replyTo: getResendReplyTo(),
      to: [email],
      subject: blootCodeEmailSubject(prep.code, "password-reset"),
      html: buildBlootCodeEmailHtml(prep.code, "password-reset"),
    });
    if (error) {
      console.error("password reset email:", error);
    }
  }

  return NextResponse.json(GENERIC_OK, { status: 200 });
}
