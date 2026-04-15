import { NextRequest, NextResponse } from "next/server";
import { deleteSession, getSessionCookieHeader, SESSION_COOKIE } from "@/lib/sessions";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  deleteSession(token);
  const res = NextResponse.json({ success: true });
  res.headers.set("Set-Cookie", getSessionCookieHeader());
  return res;
}
