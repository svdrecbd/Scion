"use client";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main style={{ padding: 32, maxWidth: 720, margin: "0 auto" }}>
          <h1>Scion failed to load</h1>
          <p>
            The web app does not serve fallback fixtures anymore. Fix the underlying API or
            configuration issue and retry.
          </p>
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
          <button type="button" onClick={reset}>
            Retry
          </button>
        </main>
      </body>
    </html>
  );
}
