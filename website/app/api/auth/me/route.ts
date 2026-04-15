import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail } from "@/lib/users";
import { getSessionEmail, getSessionPayload, SESSION_COOKIE } from "@/lib/sessions";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const payload = getSessionPayload(token);
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

    const user = getUserByEmail(email);
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
