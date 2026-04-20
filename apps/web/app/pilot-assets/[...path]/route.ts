import { readFile } from "fs/promises";
import { extname } from "path";
import { isPilotEnabled, safePilotPath } from "../../../lib/public-pilot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  if (!isPilotEnabled()) {
    return new Response("Public data pilot is disabled.", { status: 404 });
  }

  const params = await context.params;
  const relativePath = params.path.join("/");
  let filePath: string;
  try {
    filePath = safePilotPath(relativePath);
  } catch {
    return new Response("Invalid pilot asset path.", { status: 400 });
  }

  try {
    const file = await readFile(filePath);
    const contentType = contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream";
    return new Response(file, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": contentType,
      },
    });
  } catch {
    return new Response("Pilot asset not found.", { status: 404 });
  }
}
