import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieHeader } from "@/lib/bloot-session";

export const runtime = "edge";

export async function POST(_request: NextRequest) {
  const res = NextResponse.json({ success: true });
  res.headers.set("Set-Cookie", getSessionCookieHeader());
  return res;
}
