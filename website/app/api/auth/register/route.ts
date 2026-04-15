import { NextRequest, NextResponse } from "next/server";
import { createUser, getUserByEmail, upsertUserMirror } from "@/lib/users";
import { createSession } from "@/lib/sessions";
import { consumeRegistrationToken, getRegistrationToken } from "@/lib/verification-codes";
import { compare, hash } from "bcryptjs";
import { blootInternalRegister, blootLogin, isBlootWorkerConfigured } from "@/lib/bloot-api";

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function hasBlootApiUrl(): boolean {
  return !!(process.env.BLOOT_API_URL || "").trim();
}

function hasBlootInternalSecret(): boolean {
  return !!(process.env.BLOOT_INTERNAL_SECRET || "").trim();
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
      const data = getRegistrationToken(tokenValue);
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

    const passwordHash = await hash(password, 10);

    if (isBlootWorkerConfigured()) {
      const r = await blootInternalRegister({
        email: regEmail,
        passwordHash,
        name: regName,
        surname: regSurname,
        username: regUsername,
      });
      if (!r.ok) {
        if (r.status === 409) {
          // Idempotent completion: account may already exist from previous successful attempt.
          const retry = await blootLogin({ identifier: regEmail, password });
          if (retry.ok) {
            const u = retry.user;
            try {
              upsertUserMirror({
                publicId: u.blootUserId,
                email: u.email,
                name: u.name,
                surname: u.surname,
                username: u.username,
                passwordHash,
                language: "uz",
              });
            } catch (e) {
              console.warn("mirror upsert failed during register retry-login:", e);
            }
            if (hasRegistrationToken) consumeRegistrationToken(tokenValue);
            const { cookie } = createSession(u.email, {
              blootUserId: u.blootUserId,
              publicId: u.blootUserId,
              name: u.name,
              surname: u.surname,
              username: u.username,
              language: "uz",
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
        return NextResponse.json({ error: r.error || "Registration failed" }, { status: r.status === 409 ? 409 : 500 });
      }
      try {
        upsertUserMirror({
          publicId: r.blootUserId,
          email: r.email,
          name: r.name,
          surname: r.surname,
          username: r.username,
          passwordHash,
          language: "uz",
        });
      } catch (e) {
        console.warn("mirror upsert failed after register success:", e);
      }
      if (hasRegistrationToken) consumeRegistrationToken(tokenValue);
      const { cookie } = createSession(r.email, {
        blootUserId: r.blootUserId,
        publicId: r.blootUserId,
        name: r.name,
        surname: r.surname,
        username: r.username,
        language: "uz",
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
    }

    if (hasBlootApiUrl() && !hasBlootInternalSecret()) {
      return NextResponse.json(
        {
          error:
            "Registration is temporarily unavailable. Missing BLOOT_INTERNAL_SECRET on the website server.",
        },
        { status: 500 }
      );
    }

    if (isProductionRuntime()) {
      return NextResponse.json(
        {
          error:
            "Registration is temporarily unavailable. Website is not connected to the bloot license service.",
        },
        { status: 500 }
      );
    }

    const user = createUser({
      email: regEmail,
      name: regName,
      surname: regSurname,
      username: regUsername,
      passwordHash,
    });

    if (!user) {
      const existing = getUserByEmail(regEmail);
      if (existing) {
        const samePassword = await compare(password, existing.passwordHash);
        if (samePassword) {
          if (hasRegistrationToken) consumeRegistrationToken(tokenValue);
          const { cookie } = createSession(existing.email, {
            blootUserId: String(existing.id),
            publicId: existing.publicId,
            name: existing.name,
            surname: existing.surname,
            username: existing.username,
            language: existing.language,
          });
          const res = NextResponse.json({
            success: true,
            user: {
              email: existing.email,
              name: existing.name,
              surname: existing.surname,
              username: existing.username,
              blootUserId: String(existing.id),
            },
          });
          res.headers.set("Set-Cookie", cookie);
          return res;
        }
      }
      return NextResponse.json(
        { error: "An account with this email already exists. Log in instead." },
        { status: 409 }
      );
    }

    if (hasRegistrationToken) consumeRegistrationToken(tokenValue);
    const { cookie } = createSession(user.email, {
      blootUserId: String(user.id),
      publicId: user.publicId,
      name: user.name,
      surname: user.surname,
      username: user.username,
      language: user.language,
    });
    const res = NextResponse.json({
      success: true,
      user: {
        email: user.email,
        name: user.name,
        surname: user.surname,
        username: user.username,
        blootUserId: String(user.id),
      },
    });
    res.headers.set("Set-Cookie", cookie);
    return res;
  } catch (e) {
    console.error("register error:", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
