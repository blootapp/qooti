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
  const resend = new Resend(apiKey);

  try {
    let body: {
      email?: string;
      purpose?: string;
      username?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }
    const { email, purpose, username } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const purposeVal = purpose === "register" ? "register" : "login";

    if (purposeVal === "register") {
      if (!username || typeof username !== "string" || !username.trim()) {
        return NextResponse.json({ error: "Username is required" }, { status: 400 });
      }
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const emailNorm = String(email).trim().toLowerCase();
    const profile =
      purposeVal === "register" && username
        ? { name: username.trim(), surname: "User", username: username.trim() }
        : undefined;
    setCode(emailNorm, code, purposeVal, profile);

    const { data, error } = await resend.emails.send({
      from: getResendFromEmail(),
      replyTo: getResendReplyTo(),
      to: [emailNorm],
      subject: blootCodeEmailSubject(code, "account-verify"),
      html: buildBlootCodeEmailHtml(code, "account-verify"),
    });

    if (error) {
      console.error("Resend error:", error);
      return NextResponse.json(
        { error: "Failed to send verification email" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, id: data?.id });
  } catch (e) {
    console.error("send-code error:", e);
    const message = e instanceof Error ? e.message : "Something went wrong";
    return NextResponse.json(
      { error: process.env.NODE_ENV === "development" ? message : "Something went wrong" },
      { status: 500 }
    );
  }
}
