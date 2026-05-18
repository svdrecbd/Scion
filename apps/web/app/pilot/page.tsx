import Link from "next/link";
import {
  getPilotIndex,
  getPilotRoot,
  isPilotEnabled,
  publicAdvisoryCount,
} from "../../lib/public-pilot";

export const dynamic = "force-dynamic";

export default async function PilotPage() {
  const index = await getPilotIndex();
  const isProduction = process.env.NODE_ENV === "production";

  if (!isPilotEnabled()) {
    return (
      <main>
        <section className="hero">
          <div className="kicker">Public Data</div>
          <h1>Data Browser Disabled</h1>
          <p>
            The public dataset browser is disabled unless the data runtime flag is enabled.
          </p>
        </section>
      </main>
    );
  }

  if (!index) {
    return (
      <main>
        <section className="hero">
          <div className="kicker">Public Data</div>
          <h1>No Data Index Found</h1>
          {isProduction ? (
            <p>The public dataset index is not available for this deployment.</p>
          ) : (
            <p>
              Generate the local data index first, then reload this page. Current root:{" "}
              <code>{getPilotRoot()}</code>
            </p>
          )}
        </section>
        {!isProduction ? (
          <section className="panel">
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>make pilot-index</pre>
          </section>
        ) : null}
      </main>
    );
  }

  return (
    <main>
      <section className="hero">
        <div className="kicker">Public Data</div>
        <h1>Dataset Browser</h1>
        {isProduction ? (
          <p>
            Inspection records for mirrored public datasets, conversion readiness, and reviewed
            data reuse notes.
          </p>
        ) : (
          <p>
            Local inspection records for mirrored public datasets. This reads from{" "}
            <code>{getPilotRoot()}</code> and does not move raw data into the project repo.
          </p>
        )}
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">Dataset Lineup</h2>
        <div className="dataset-grid" style={{ marginTop: 18 }}>
          {index.datasets.map((record) => {
            const visibleAdvisories = publicAdvisoryCount(record.advisory);

            return (
              <Link
                key={record.slug}
                href={`/pilot/${encodeURIComponent(record.slug)}`}
                className="dataset-card-link"
              >
                <article className="panel dataset-card pilot-lineup-card">
                  <div className="kicker">
                    {record.dataset.source} {record.dataset.entry_id}
                  </div>
                  <h3>{record.slug}</h3>
                  <p className="muted" style={{ lineHeight: 1.5 }}>
                    {record.dataset.title}
                  </p>
                  <div className="pill-row">
                    <span className="pill">{record.report.file_count} files</span>
                    <span className="pill">{record.report.total_gib} GiB</span>
                    <span className="pill">{record.readiness.ready_assets} ready</span>
                    <span className="pill">{record.readiness.blocked_assets} blocked</span>
                    {visibleAdvisories > 0 ? (
                      <span className="pill">{visibleAdvisories} reuse notes</span>
                    ) : null}
                  </div>
                </article>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
