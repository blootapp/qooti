import { NextRequest, NextResponse } from "next/server";
import { getLatestReleaseAsset } from "@/lib/download-github";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const platform = request.nextUrl.searchParams.get("platform");
  if (platform !== "mac" && platform !== "win") {
    return NextResponse.json({ error: 'Invalid platform. Use "mac" or "win".' }, { status: 400 });
  }

  const result = await getLatestReleaseAsset(platform);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  if (request.nextUrl.searchParams.get("redirect") === "1") {
    return NextResponse.redirect(result.url);
  }

  return NextResponse.json({
    url: result.url,
    name: result.name,
    tag: result.tag,
  });
}
