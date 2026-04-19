import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/api-session";
import { updateLanguage } from "@/lib/dashboard";
import { SESSION_COOKIE, updateSessionPayload } from "@/lib/bloot-session";

export const runtime = "edge";

export async function PATCH(request: NextRequest) {
  const session = await getSessionFromRequest(request);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const language = body.language === "en" ? "en" : "uz";
  const publicId = String(session.publicId || session.blootUserId || "").trim();
  if (!publicId) return NextResponse.json({ error: "User id not found." }, { status: 400 });
  const user = await updateLanguage(publicId, language);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const setCookie = await updateSessionPayload(token, { language });
  const res = NextResponse.json({ ok: true, user }, { status: 200 });
  if (setCookie) res.headers.set("Set-Cookie", setCookie);
  return res;
}
