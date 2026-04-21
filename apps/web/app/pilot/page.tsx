import Link from "next/link";
import { getPilotIndex, getPilotRoot, isPilotEnabled } from "../../lib/public-pilot";

export const dynamic = "force-dynamic";

export default async function PilotPage() {
  const index = await getPilotIndex();

  if (!isPilotEnabled()) {
    return (
      <main>
        <section className="hero">
          <div className="kicker">Public Data Pilot</div>
          <h1>Pilot Browser Disabled</h1>
          <p>
            The public-data pilot browser is disabled in production unless
            `SCION_ENABLE_PUBLIC_DATA_PILOT=true` is set.
          </p>
        </section>
      </main>
    );
  }

  if (!index) {
    return (
      <main>
        <section className="hero">
          <div className="kicker">Public Data Pilot</div>
          <h1>No Pilot Index Found</h1>
          <p>
            Generate the local pilot index first, then reload this page. Current root:
            {" "}
            <code>{getPilotRoot()}</code>
          </p>
        </section>
        <section className="panel">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>make pilot-index</pre>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="hero">
        <div className="kicker">Public Data Pilot</div>
        <h1>Local Figure and Conversion Readiness Browser</h1>
        <p>
          This is a local inspection surface for mirrored public datasets. It reads from
          {" "}
          <code>{getPilotRoot()}</code>
          {" "}
          and does not move raw data into the Scion repo.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">Pilot Lineup</h2>
        <div className="dataset-grid" style={{ marginTop: 18 }}>
          {index.datasets.map((record) => (
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
                </div>
              </article>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
