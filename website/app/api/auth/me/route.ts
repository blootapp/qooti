import { NextRequest, NextResponse } from "next/server";
import { validateSessionPayload } from "@/lib/api-session";
import { getUserByEmail } from "@/lib/users";
import { SESSION_COOKIE } from "@/lib/bloot-session";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function GET(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const payload = await validateSessionPayload(token);
    const email = payload?.email ?? null;

    if (!email) {
      return NextResponse.json({ user: null }, { status: 200 });
    }

    if (payload?.blootUserId && payload.name != null && payload.username != null) {
      return NextResponse.json({
        user: {
          email,
          name: payload.name,
          surname: payload.surname ?? "",
          username: payload.username,
          blootUserId: payload.blootUserId,
          publicId: payload.publicId ?? payload.blootUserId,
          language: payload.language ?? "uz",
        },
      });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return NextResponse.json({ user: null }, { status: 200 });
    }

    return NextResponse.json({
      user: {
        email: user.email,
        name: user.name,
        surname: user.surname,
        username: user.username,
        blootUserId: payload?.blootUserId ?? String(user.id),
        publicId: user.publicId,
        language: user.language,
      },
    });
  } catch (e) {
    console.error("me error:", e);
    return NextResponse.json({ user: null }, { status: 500 });
  }
}
