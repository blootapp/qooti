import { NextRequest, NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { getAndConsumePasswordResetToken } from "@/lib/verification-codes";
import { blootInternalResetPassword, isBlootWorkerConfigured } from "@/lib/bloot-api";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  let body: { passwordResetToken?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const token = String(body.passwordResetToken || "").trim();
  const newPassword = String(body.newPassword || "");
  if (!token) return NextResponse.json({ error: "Invalid reset token" }, { status: 400 });
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  const tokenData = await getAndConsumePasswordResetToken(token);
  if (!tokenData) return NextResponse.json({ error: "Reset session expired" }, { status: 400 });
  const passwordHash = await hash(newPassword, 10);

  if (!isBlootWorkerConfigured()) {
    return NextResponse.json(
      {
        error:
          "Password reset is temporarily unavailable. Set BLOOT_API_URL and BLOOT_INTERNAL_SECRET.",
      },
      { status: 503 }
    );
  }

  const r = await blootInternalResetPassword({
    email: tokenData.email,
    passwordHash,
  });
  if (!r.ok) {
    return NextResponse.json({ error: r.error || "Password reset failed" }, { status: r.status || 500 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
