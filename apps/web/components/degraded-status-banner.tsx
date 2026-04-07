import { describeApiError } from "../lib/api-errors";
import { logDegradedSummary } from "../lib/web-observability";

export function DegradedStatusBanner({
  page,
  issues,
  title = "Degraded Mode"
}: {
  page: string;
  issues: Array<{
    label: string;
    context: string;
    error: unknown;
  }>;
  title?: string;
}) {
  const resolvedIssues = issues.map((issue) => ({
    label: issue.label,
    details: describeApiError(issue.error, issue.context)
  }));
  const requestIds = Array.from(
    new Set(resolvedIssues.map((issue) => issue.details.requestId).filter(Boolean))
  ) as string[];

  logDegradedSummary({
    page,
    scope: title,
    issues: resolvedIssues
  });

  return (
    <section className="status-ribbon" aria-live="polite">
      <div className="status-ribbon-title">{title}</div>
      <div className="status-ribbon-copy">
        {resolvedIssues.length === 1
          ? `${resolvedIssues[0].label} is unavailable right now.`
          : `${resolvedIssues.length} sections are running in degraded mode.`}
      </div>
      <div className="status-ribbon-tags">
        {resolvedIssues.map((issue) => (
          <span key={issue.label} className="status-ribbon-tag">
            {issue.label}
          </span>
        ))}
      </div>
      {requestIds.length > 0 ? (
        <div className="status-ribbon-meta">
          request_ids: {requestIds.join(", ")}
        </div>
      ) : null}
    </section>
  );
}
