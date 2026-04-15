import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/api-session";
import { updateUsername } from "@/lib/dashboard";
import { SESSION_COOKIE, updateSessionPayload } from "@/lib/sessions";

export async function PATCH(request: NextRequest) {
  const session = getSessionFromRequest(request);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const nextUsername = String(body.username || "").trim();
  const publicId = String(session.publicId || session.blootUserId || "").trim();
  if (!publicId) return NextResponse.json({ error: "User id not found." }, { status: 400 });
  const result = updateUsername(publicId, nextUsername);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  updateSessionPayload(token, { username: result.user.username });
  return NextResponse.json({ ok: true, user: result.user }, { status: 200 });
}
