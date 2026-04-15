import { NextRequest, NextResponse } from "next/server";
import { deleteAccount, getDashboardUserByEmail } from "@/lib/dashboard";
import { getSessionFromRequest } from "@/lib/api-session";
import { deleteSession, getSessionCookieHeader, SESSION_COOKIE } from "@/lib/sessions";

export async function DELETE(request: NextRequest) {
  const session = getSessionFromRequest(request);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const expectedUsername = String(body.username || "").trim();
  const user = getDashboardUserByEmail(session.email);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (expectedUsername !== user.username) {
    return NextResponse.json({ error: "Username confirmation mismatch." }, { status: 400 });
  }
  const result = deleteAccount(user.publicId);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  deleteSession(token);
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.headers.set("Set-Cookie", getSessionCookieHeader());
  return res;
}
