export const dynamic = "force-dynamic";

function getApiBaseUrl(): string {
  return (
    process.env.SCION_API_BASE_URL ??
    process.env.NEXT_PUBLIC_SCION_API_BASE_URL ??
    "http://127.0.0.1:8000/api"
  ).replace(/\/$/, "");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const requestHeaders = new Headers();
  const requestId = request.headers.get("x-request-id");
  if (requestId) requestHeaders.set("X-Request-ID", requestId);

  let response: Response;
  try {
    response = await fetch(
      `${getApiBaseUrl()}/datasets/${encodeURIComponent(id)}/caos-handoff`,
      { headers: requestHeaders, cache: "no-store" },
    );
  } catch {
    return Response.json({ detail: "The API could not be reached." }, { status: 502 });
  }

  const headers = new Headers({
    "Content-Type": response.headers.get("content-type") ?? "application/json",
    "Cache-Control": response.headers.get("cache-control") ?? "no-store",
  });
  for (const name of ["content-disposition", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
