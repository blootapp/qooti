import { NextRequest, NextResponse } from "next/server";
import { checkCode, createPasswordResetToken } from "@/lib/verification-codes";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  let body: { email?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim().replace(/\D/g, "").slice(0, 6);
  if (!email || !code) {
    return NextResponse.json({ error: "Email and code are required" }, { status: 400 });
  }
  const valid = await checkCode(email, code, "reset");
  if (!valid) return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
  const passwordResetToken = await createPasswordResetToken(email);
  return NextResponse.json({ ok: true, passwordResetToken }, { status: 200 });
}
