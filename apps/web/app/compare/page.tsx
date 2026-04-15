import Link from "next/link";
import { ApiFailurePanel } from "../../components/api-failure-panel";
import { getCompare } from "../../lib/api";
import { CompareSummary } from "../../components/compare-summary";
import { normalizeSearchParams, type RouteSearchParams } from "../../lib/route-props";

export default async function ComparePage({
  searchParams
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const resolvedSearchParams = normalizeSearchParams(await searchParams);
  const ids = resolvedSearchParams.ids?.split(",").filter(Boolean) || [];

  if (ids.length < 2) {
    return (
      <main>
        <div style={{ marginBottom: 24 }}>
          <Link href="/corpus" className="muted" style={{ textDecoration: "underline" }}>
            ← Back to corpus
          </Link>
        </div>
        <section className="hero">
          <h1>Compare Mode</h1>
          <p>
            Compare starts in the corpus. Select two or more datasets from either the table or card
            view, then return here to inspect where they align and where they do not.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <Link href="/corpus" className="button" style={{ textDecoration: "none" }}>
              Open corpus
            </Link>
            <Link href="/guide" className="button" style={{ textDecoration: "none" }}>
              Compare guide
            </Link>
          </div>
        </section>
      </main>
    );
  }

  let payload;

  try {
    payload = await getCompare(ids);
  } catch (error) {
    return (
      <main>
        <div style={{ marginBottom: 24 }}>
          <Link href="/corpus" className="muted" style={{ textDecoration: "underline" }}>
            ← Back to corpus
          </Link>
        </div>

        <section className="hero">
          <div className="kicker">Compare View</div>
          <h1>Compare Mode is temporarily degraded.</h1>
          <p>
            The selected dataset set could not be aligned right now.
          </p>
        </section>

        <ApiFailurePanel
          error={error}
          context="the compare view"
          page="compare"
          actionHref="/corpus"
          actionLabel="Back to corpus selection"
        />
      </main>
    );
  }

  return (
    <main>
      <div style={{ marginBottom: 24 }}>
        <Link href="/corpus" className="muted" style={{ textDecoration: "underline" }}>
          ← Back to corpus
        </Link>
      </div>

      <section className="hero">
        <div className="kicker">Compare View</div>
        <h1>Cross-study alignment for {payload.datasets.length} datasets.</h1>
        <p>{payload.summary}</p>
      </section>

      <div style={{ marginTop: 32 }}>
        <CompareSummary payload={payload} />
      </div>

      <div className="compare-matrix-wrapper">
        <table className="compare-matrix">
          <thead>
            <tr>
              <th>Feature</th>
              {payload.datasets.map((d) => (
                <th key={d.dataset_id}>
                  <Link href={`/datasets/${d.dataset_id}`} style={{ textDecoration: "underline" }}>
                    {d.title}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Cell Type</th>
              {payload.datasets.map((d) => (
                <td key={d.dataset_id}>{d.cell_type}</td>
              ))}
            </tr>
            <tr>
              <th>Species</th>
              {payload.datasets.map((d) => (
                <td key={d.dataset_id}>{d.species}</td>
              ))}
            </tr>
            <tr>
              <th>Modality</th>
              {payload.datasets.map((d) => (
                <td key={d.dataset_id}>{d.modality}</td>
              ))}
            </tr>
            <tr>
              <th>Resolution (XY/Z)</th>
              {payload.datasets.map((d) => (
                <td key={d.dataset_id}>
                  {d.lateral_resolution_nm}nm / {d.axial_resolution_nm}nm
                </td>
              ))}
            </tr>
            <tr>
              <th>Organelles</th>
              {payload.datasets.map((d) => (
                <td key={d.dataset_id}>
                  <div className="pill-row">
                    {d.organelles.map((o) => (
                      <span key={o} className={`pill ${payload.shared_fields.organelles.includes(o) ? "match-highlight" : ""}`}>
                        {o}
                      </span>
                    ))}
                  </div>
                </td>
              ))}
            </tr>
            <tr>
              <th>Metrics</th>
              {payload.datasets.map((d) => (
                <td key={d.dataset_id}>
                  <div className="pill-row">
                    {d.metric_families.map((m) => (
                      <span key={m} className={`pill ${payload.shared_fields.metric_families.includes(m) ? "match-highlight" : ""}`}>
                        {m}
                      </span>
                    ))}
                  </div>
                </td>
              ))}
            </tr>
            <tr>
              <th>Public Data</th>
              {payload.datasets.map((d) => (
                <td key={d.dataset_id}>{d.public_data_status}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}
