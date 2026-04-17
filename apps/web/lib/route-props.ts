export type RouteSearchParams = Record<string, string | string[] | undefined>;

export function normalizeSearchParams(searchParams: RouteSearchParams): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(searchParams).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.filter(Boolean).join(",") : value
    ])
  ) as Record<string, string | undefined>;
}
