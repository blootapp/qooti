import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/api-session";
import { updatePassword } from "@/lib/dashboard";

export async function PATCH(request: NextRequest) {
  const session = getSessionFromRequest(request);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const publicId = String(session.publicId || session.blootUserId || "").trim();
  if (!publicId) return NextResponse.json({ error: "User id not found." }, { status: 400 });
  const result = await updatePassword(
    publicId,
    String(body.currentPassword || ""),
    String(body.newPassword || "")
  );
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json({ ok: true }, { status: 200 });
}
