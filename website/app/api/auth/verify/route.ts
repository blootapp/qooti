import { NextRequest, NextResponse } from "next/server";
import { checkCode, getCodeEntry, createRegistrationToken } from "@/lib/verification-codes";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, code, purpose } = body;

    if (!email || !code) {
      return NextResponse.json(
        { error: "Email and code are required" },
        { status: 400 }
      );
    }

    const purposeVal = purpose === "register" ? "register" : "login";
    const emailNorm = String(email).trim().toLowerCase();
    const codeNorm = String(code).trim().replace(/\D/g, "").slice(0, 6);
    const entryBeforeCheck = getCodeEntry(emailNorm, purposeVal);
    const valid = checkCode(emailNorm, codeNorm, purposeVal);

    if (!valid && process.env.NODE_ENV === "development") {
      console.log("[verify] failed", {
        emailNorm,
        purposeVal,
        codeLen: codeNorm.length,
        hasEntry: !!entryBeforeCheck,
        expired: entryBeforeCheck ? Date.now() > entryBeforeCheck.expiresAt : null,
      });
    }

    if (!valid) {
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 400 }
      );
    }

    if (purposeVal === "register" && entryBeforeCheck?.profile) {
      const registrationToken = createRegistrationToken(emailNorm, entryBeforeCheck.profile);
      return NextResponse.json({
        success: true,
        purpose: "register",
        registrationToken,
        email: emailNorm,
      });
    }

    return NextResponse.json({
      success: true,
      email: emailNorm,
      purpose: purposeVal,
    });
  } catch (e) {
    console.error("verify error:", e);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
