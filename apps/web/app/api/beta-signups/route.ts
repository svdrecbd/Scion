export const dynamic = "force-dynamic";

function getApiBaseUrl(): string {
  return (
    process.env.SCION_API_BASE_URL ??
    process.env.NEXT_PUBLIC_SCION_API_BASE_URL ??
    "http://127.0.0.1:8000/api"
  ).replace(/\/$/, "");
}

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return Response.json({ detail: "Invalid JSON payload." }, { status: 400 });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  const requestId = request.headers.get("x-request-id");
  if (requestId) {
    headers.set("X-Request-ID", requestId);
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/beta-signups`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store"
    });
  } catch {
    return Response.json({ detail: "The API could not be reached." }, { status: 502 });
  }

  const body = await response.text();
  return new Response(body || "{}", {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json"
    }
  });
}
