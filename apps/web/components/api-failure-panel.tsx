import Link from "next/link";

import { describeApiError } from "../lib/api-errors";
import { logDegradedSection } from "../lib/web-observability";
import { FailureDebugFooter } from "./failure-debug-footer";

export function ApiFailurePanel({
  error,
  context,
  page = "unknown",
  title,
  compact = false,
  actionHref,
  actionLabel
}: {
  error: unknown;
  context: string;
  page?: string;
  title?: string;
  compact?: boolean;
  actionHref?: string;
  actionLabel?: string;
}) {
  const details = page
    ? logDegradedSection({ page, context, error, title })
    : describeApiError(error, context);

  return (
    <section
      className="panel"
      style={{
        borderLeft: "6px solid #d32f2f",
        display: "grid",
        gap: compact ? 8 : 12
      }}
    >
      <div className="kicker" style={{ color: "#d32f2f", margin: 0 }}>
        Degraded State
      </div>
      <h2 className="section-title" style={{ margin: 0 }}>
        {title ?? details.title}
      </h2>
      <p style={{ margin: 0, lineHeight: 1.6 }}>{details.summary}</p>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        {details.recommendation}
      </p>
      <FailureDebugFooter requestId={details.requestId} statusCode={details.statusCode} />
      {actionHref && actionLabel ? (
        <div>
          <Link href={actionHref} className="button" style={{ textDecoration: "none", display: "inline-block" }}>
            {actionLabel}
          </Link>
        </div>
      ) : null}
    </section>
  );
}
