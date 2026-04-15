import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username")?.trim() || "";
  if (username.length < 3) {
    return NextResponse.json({ available: true, warning: "Too short" }, { status: 200 });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return NextResponse.json({ available: true, warning: "Invalid format" }, { status: 200 });
  }
  return NextResponse.json({ available: true }, { status: 200 });
}
