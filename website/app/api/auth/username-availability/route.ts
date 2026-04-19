import { NextRequest, NextResponse } from "next/server";
import { isUsernameAvailable } from "@/lib/users";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username")?.trim() || "";
  const excludePublicId = request.nextUrl.searchParams.get("exclude_public_id")?.trim() || undefined;

  if (username.length < 3) {
    return NextResponse.json({ available: true, warning: "Too short" }, { status: 200 });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return NextResponse.json({ available: true, warning: "Invalid format" }, { status: 200 });
  }

  const available = await isUsernameAvailable(username, excludePublicId);
  return NextResponse.json({ available }, { status: 200 });
}
