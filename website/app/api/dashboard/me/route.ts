import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/api-session";
import { getDashboardUserByEmail, getUserApps, getUserPayments } from "@/lib/dashboard";

export async function GET(request: NextRequest) {
  const session = getSessionFromRequest(request);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = getDashboardUserByEmail(session.email);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const apps = getUserApps(user.publicId);
  const payments = getUserPayments(user.publicId);
  return NextResponse.json({ user, apps, payments }, { status: 200 });
}
