import { isPilotEnabled } from "../../lib/public-pilot";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { enabled: isPilotEnabled() },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
