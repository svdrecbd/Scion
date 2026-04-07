"use client";

import { FailureDebugFooter } from "../components/failure-debug-footer";
import { describeApiError } from "../lib/api-errors";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const details = describeApiError(error, "this page");

  return (
    <html lang="en">
      <body>
        <main style={{ padding: 32, maxWidth: 720, margin: "0 auto" }}>
          <h1>{details.title}</h1>
          <p>
            {details.summary}
          </p>
          <p>{details.recommendation}</p>
          <pre
            style={{
              overflowX: "auto",
              padding: 16,
              borderRadius: 0,
              background: "var(--accent)",
              color: "var(--foreground)"
            }}
          >
            {error.message}
          </pre>
          <FailureDebugFooter requestId={details.requestId} statusCode={details.statusCode} />
          <button type="button" onClick={reset}>
            Retry
          </button>
        </main>
      </body>
    </html>
  );
}
