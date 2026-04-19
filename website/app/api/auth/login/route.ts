import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/bloot-session";
import { blootLogin } from "@/lib/bloot-api";

export const runtime = "edge";

const GENERIC_AUTH_ERROR = "Incorrect email or password";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { identifier, email, password } = body;
    const identifierValue = String(identifier || email || "").trim();

    if (!identifierValue) {
      return NextResponse.json({ error: "Username or email is required" }, { status: 400 });
    }
    if (!password || typeof password !== "string") {
      return NextResponse.json({ error: "Password is required" }, { status: 400 });
    }

    if (!(process.env.BLOOT_API_URL || "").trim()) {
      return NextResponse.json(
        {
          error:
            "Login is temporarily unavailable. Website is not connected to the bloot license service (BLOOT_API_URL).",
        },
        { status: 503 }
      );
    }

    const r = await blootLogin({ identifier: identifierValue, password });
    if (!r.ok) {
      if (r.status === 429) {
        return NextResponse.json(
          { error: "Too many login attempts. Try again later." },
          {
            status: 429,
            headers: { "Retry-After": "900" },
          }
        );
      }
      return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
    }
    const u = r.user;
    const pwdTs = u.passwordChangedAt ?? 0;
    const { cookie } = await createSession(u.email, {
      blootUserId: u.blootUserId,
      publicId: u.blootUserId,
      name: u.name,
      surname: u.surname,
      username: u.username,
      language: "uz",
      pwdTs,
    });
    const res = NextResponse.json({
      success: true,
      user: {
        email: u.email,
        name: u.name,
        surname: u.surname,
        username: u.username,
        blootUserId: u.blootUserId,
      },
    });
    res.headers.set("Set-Cookie", cookie);
    return res;
  } catch (e) {
    console.error("login error:", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
