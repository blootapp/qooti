import { NextRequest, NextResponse } from "next/server";
import { getUserByUsernameOrEmail, upsertUserMirror } from "@/lib/users";
import { createSession } from "@/lib/sessions";
import { compare } from "bcryptjs";
import { blootInternalRegister, blootLogin, isBlootWorkerConfigured } from "@/lib/bloot-api";

function useBlootWorker(): boolean {
  return !!(process.env.BLOOT_API_URL || "").trim();
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

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

    if (useBlootWorker()) {
      const r = await blootLogin({ identifier: identifierValue, password });
      if (!r.ok) {
        // Dev safety net: if this account was created in local SQLite before Worker wiring,
        // migrate it to Worker on first successful local login.
        if (!isProductionRuntime()) {
          const localUser = getUserByUsernameOrEmail(identifierValue);
          if (localUser) {
            const localMatch = await compare(password, localUser.passwordHash);
            if (localMatch) {
              if (isBlootWorkerConfigured()) {
                const sync = await blootInternalRegister({
                  email: localUser.email,
                  passwordHash: localUser.passwordHash,
                  name: localUser.name,
                  surname: localUser.surname,
                  username: localUser.username,
                });
                if (sync.ok) {
                  try {
                    upsertUserMirror({
                      publicId: sync.blootUserId,
                      email: sync.email,
                      name: sync.name,
                      surname: sync.surname,
                      username: sync.username,
                      passwordHash: localUser.passwordHash,
                      language: "uz",
                    });
                  } catch (e) {
                    console.warn("mirror upsert failed during login sync:", e);
                  }
                  const { cookie } = createSession(sync.email, {
                    blootUserId: sync.blootUserId,
                    publicId: sync.blootUserId,
                    name: sync.name,
                    surname: sync.surname,
                    username: sync.username,
                    language: "uz",
                  });
                  const res = NextResponse.json({
                    success: true,
                    user: {
                      email: sync.email,
                      name: sync.name,
                      surname: sync.surname,
                      username: sync.username,
                      blootUserId: sync.blootUserId,
                    },
                  });
                  res.headers.set("Set-Cookie", cookie);
                  return res;
                }
                // If user already exists remotely, retry remote login once.
                if (sync.status === 409) {
                  const retry = await blootLogin({ identifier: identifierValue, password });
                  if (retry.ok) {
                    const u = retry.user;
                    try {
                      upsertUserMirror({
                        publicId: u.blootUserId,
                        email: u.email,
                        name: u.name,
                        surname: u.surname,
                        username: u.username,
                        language: "uz",
                      });
                    } catch (e) {
                      console.warn("mirror upsert failed during retry login:", e);
                    }
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
              }
              // Last-resort dev fallback keeps old local users usable.
              const { cookie } = createSession(localUser.email, {
                blootUserId: String(localUser.id),
                publicId: localUser.publicId,
                name: localUser.name,
                surname: localUser.surname,
                username: localUser.username,
                language: localUser.language,
              });
              const res = NextResponse.json({
                success: true,
                user: {
                  email: localUser.email,
                  name: localUser.name,
                  surname: localUser.surname,
                  username: localUser.username,
                  blootUserId: String(localUser.id),
                },
              });
              res.headers.set("Set-Cookie", cookie);
              return res;
            }
          }
        }
        const status = r.status === 401 ? 401 : r.status === 404 ? 404 : 400;
        return NextResponse.json(
          { error: r.error || "Login failed" },
          { status }
        );
      }
      const u = r.user;
      try {
        upsertUserMirror({
          publicId: u.blootUserId,
          email: u.email,
          name: u.name,
          surname: u.surname,
          username: u.username,
          language: "uz",
        });
      } catch (e) {
        console.warn("mirror upsert failed after worker login:", e);
      }
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

    if (isProductionRuntime()) {
      return NextResponse.json(
        {
          error:
            "Login is temporarily unavailable. Website is not connected to the bloot license service.",
        },
        { status: 500 }
      );
    }

    const user = getUserByUsernameOrEmail(identifierValue);

    if (!user) {
      return NextResponse.json(
        { error: "Account not found (or duplicate username). Use email or bloot id." },
        { status: 404 }
      );
    }

    const match = await compare(password, user.passwordHash);
    if (!match) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
    }

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
    console.error("login error:", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
