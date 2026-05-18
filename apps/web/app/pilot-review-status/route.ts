import { NextResponse } from "next/server";
import { isPilotReviewEnabled } from "../../lib/public-pilot";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { enabled: isPilotReviewEnabled() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
