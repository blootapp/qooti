import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/bloot-session";
import { consumeRegistrationToken, getRegistrationToken } from "@/lib/verification-codes";
import { hash } from "bcryptjs";
import { blootInternalRegister, blootLogin, isBlootWorkerConfigured } from "@/lib/bloot-api";
import { getRequestClientIp } from "@/lib/client-ip";

export const runtime = "edge";

const GENERIC_REGISTER_FAIL =
  "We could not complete registration. If you already have an account, try signing in.";

function isValidEmailFormat(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { registrationToken, password, email, username, acceptedTerms } = body;
    const hasRegistrationToken = !!(registrationToken && typeof registrationToken === "string");
    const tokenValue = hasRegistrationToken ? String(registrationToken) : "";

    if (acceptedTerms !== true) {
      return NextResponse.json(
        { error: "You must accept the Terms and Conditions to create an account." },
        { status: 400 }
      );
    }

    if (!password || typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }
    let regEmail = "";
    let regUsername = "";
    let regName = "";
    let regSurname = "";
    if (hasRegistrationToken) {
      const data = await getRegistrationToken(tokenValue);
      if (!data) {
        return NextResponse.json(
          { error: "Registration session expired or invalid. Please verify your email again." },
          { status: 400 }
        );
      }
      regEmail = data.email;
      regUsername = data.profile.username;
      regName = data.profile.name;
      regSurname = data.profile.surname;
    } else {
      if (!email || typeof email !== "string" || !email.trim()) {
        return NextResponse.json({ error: "Email is required" }, { status: 400 });
      }
      if (!username || typeof username !== "string" || !username.trim()) {
        return NextResponse.json({ error: "Username is required" }, { status: 400 });
      }
      regEmail = email.trim().toLowerCase();
      regUsername = username.trim();
      regName = regUsername;
      regSurname = "User";
    }

    if (!isValidEmailFormat(regEmail)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    const passwordHash = await hash(password, 10);

    if (!isBlootWorkerConfigured()) {
      return NextResponse.json(
        {
          error:
            "Registration is temporarily unavailable. Set BLOOT_API_URL and BLOOT_INTERNAL_SECRET to the bloot license service.",
        },
        { status: 503 }
      );
    }

    const r = await blootInternalRegister(
      {
        email: regEmail,
        passwordHash,
        name: regName,
        surname: regSurname,
        username: regUsername,
      },
      getRequestClientIp(request)
    );
    if (!r.ok) {
      if (r.status === 429) {
        return NextResponse.json(
          { error: "Too many registration attempts from this network. Try again later." },
          { status: 429 }
        );
      }
      if (r.status === 409) {
        const retry = await blootLogin({ identifier: regEmail, password });
        if (retry.ok) {
          const u = retry.user;
          if (hasRegistrationToken) await consumeRegistrationToken(tokenValue);
          const { cookie } = await createSession(u.email, {
            blootUserId: u.blootUserId,
            publicId: u.blootUserId,
            name: u.name,
            surname: u.surname,
            username: u.username,
            language: "uz",
            pwdTs: u.passwordChangedAt ?? 0,
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
        }
      }
      return NextResponse.json({ error: GENERIC_REGISTER_FAIL }, { status: 400 });
    }

    if (hasRegistrationToken) await consumeRegistrationToken(tokenValue);
    const { cookie } = await createSession(r.email, {
      blootUserId: r.blootUserId,
      publicId: r.blootUserId,
      name: r.name,
      surname: r.surname,
      username: r.username,
      language: "uz",
      pwdTs: r.passwordChangedAt ?? 0,
    });
    const res = NextResponse.json({
      success: true,
      user: {
        email: r.email,
        name: r.name,
        surname: r.surname,
        username: r.username,
        blootUserId: r.blootUserId,
      },
    });
    res.headers.set("Set-Cookie", cookie);
    return res;
  } catch (e) {
    console.error("register error:", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
