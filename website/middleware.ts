import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { rotateSessionJwtIfValid, SESSION_COOKIE } from "./lib/bloot-session";

const intlMiddleware = createMiddleware(routing);

const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

export default async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const base = (process.env.BLOOT_API_URL || "").trim().replace(/\/+$/, "");
    const secret = (process.env.BLOOT_INTERNAL_SECRET || "").trim();
    if (base && secret) {
      const { getRequestClientIp } = await import("./lib/client-ip");
      const ip = getRequestClientIp(request);
      try {
        const r = await fetch(`${base}/bloot/internal/rate-limit/global-api`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": secret,
          },
          body: JSON.stringify({ ip }),
        });
        if (r.status === 429) {
          const ra = r.headers.get("Retry-After") || "60";
          return new NextResponse(JSON.stringify({ error: "Too many requests" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": ra,
            },
          });
        }
      } catch {
        /* allow request if rate-limit service unreachable */
      }
    }
    return NextResponse.next();
  }

  if (request.nextUrl.pathname === "/download/thank-you") {
    return NextResponse.next();
  }
  let response = intlMiddleware(request);
  if (response instanceof Promise) response = await response;

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const { validateSessionPayload } = await import("./lib/api-session");
    const payload = await validateSessionPayload(token);
    if (!payload) {
      response.cookies.set(SESSION_COOKIE, "", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
        secure: process.env.NODE_ENV === "production",
      });
      return response;
    }
    const newJwt = await rotateSessionJwtIfValid(token);
    if (newJwt) {
      response.cookies.set(SESSION_COOKIE, newJwt, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_SEC,
        secure: process.env.NODE_ENV === "production",
      });
    }
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next|_vercel|.*\\..*).*)"],
};
