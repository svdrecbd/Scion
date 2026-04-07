import { describeApiError, type ApiFailureState } from "./api-errors";

export function logDegradedSection(params: {
  page: string;
  context: string;
  error: unknown;
  title?: string;
}) {
  const details = describeApiError(params.error, params.context);

  console.warn(
    JSON.stringify({
      event: "web_degraded_section",
      page: params.page,
      context: params.context,
      title: params.title ?? details.title,
      status_code: details.statusCode ?? null,
      request_id: details.requestId ?? null
    })
  );

  return details;
}

export function logDegradedSummary(params: {
  page: string;
  scope: string;
  issues: Array<{
    label: string;
    details: ApiFailureState;
  }>;
}) {
  console.warn(
    JSON.stringify({
      event: "web_degraded_summary",
      page: params.page,
      scope: params.scope,
      issue_count: params.issues.length,
      issues: params.issues.map((issue) => ({
        label: issue.label,
        title: issue.details.title,
        status_code: issue.details.statusCode ?? null,
        request_id: issue.details.requestId ?? null
      }))
    })
  );
}
