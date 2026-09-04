export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SignupPayload = {
  first_name?: unknown;
  last_name?: unknown;
  affiliation?: unknown;
  email?: unknown;
  source_path?: unknown;
  consent_text_version?: unknown;
  website?: unknown;
};

function optionalText(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error("field_too_long");
  return normalized;
}

function json(detail: string, status: number) {
  return Response.json(
    { detail },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json("The signup payload is too large.", 413);
  }

  let payload: SignupPayload;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json("The signup payload is too large.", 413);
    }
    payload = JSON.parse(raw) as SignupPayload;
  } catch {
    return json("Invalid JSON payload.", 400);
  }

  try {
    const website = optionalText(payload.website, 200);
    if (website) return Response.json({ status: "ok" }, { status: 201 });

    const email = optionalText(payload.email, 254)?.toLowerCase();
    if (!email || !EMAIL_PATTERN.test(email)) {
      return json("Enter a valid email address.", 422);
    }

    const firstName = optionalText(payload.first_name, 80);
    const lastName = optionalText(payload.last_name, 80);
    const affiliation = optionalText(payload.affiliation, 160);
    const sourcePath = optionalText(payload.source_path, 300);
    const consentTextVersion = optionalText(payload.consent_text_version, 40) ?? "beta-interest-v1";
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const { env } = await import("cloudflare:workers");

    const result = await env.SIGNUPS_DB.prepare(
      `INSERT OR IGNORE INTO beta_signups
        (id, created_at, email, first_name, last_name, affiliation, source_path, consent_text_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, createdAt, email, firstName, lastName, affiliation, sourcePath, consentTextVersion)
      .run();

    console.info(JSON.stringify({
      event: result.meta.changes > 0 ? "beta_signup_saved" : "beta_signup_duplicate",
      id,
      source_path: sourcePath
    }));
    return Response.json({ status: "ok" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "field_too_long") {
      return json("One or more fields are too long.", 422);
    }
    console.error(JSON.stringify({
      event: "beta_signup_write_failed",
      message: error instanceof Error ? error.message : "unknown"
    }));
    return json("The signup could not be saved. Retry later.", 503);
  }
}
