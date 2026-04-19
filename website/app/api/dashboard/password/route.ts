import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/bloot-session";
import { getSessionFromRequest } from "@/lib/api-session";
import { updatePassword } from "@/lib/dashboard";
import { getUserByEmail } from "@/lib/users";
import { SESSION_COOKIE } from "@/lib/bloot-session";

export const runtime = "edge";

export async function PATCH(request: NextRequest) {
  const session = await getSessionFromRequest(request);
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

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const user = await getUserByEmail(session.email);
  if (user) {
    const { cookie } = await createSession(user.email, {
      blootUserId: user.publicId,
      publicId: user.publicId,
      name: user.name,
      surname: user.surname,
      username: user.username,
      language: user.language,
      pwdTs: user.passwordChangedAt,
    });
    const res = NextResponse.json({ ok: true }, { status: 200 });
    res.headers.set("Set-Cookie", cookie);
    return res;
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
