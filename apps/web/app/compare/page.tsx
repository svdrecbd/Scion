import Link from "next/link";
import { getCompare } from "../../lib/api";
import { CompareSummary } from "../../components/compare-summary";

export default async function ComparePage({
  searchParams
}: {
  searchParams: { ids?: string };
}) {
  const ids = searchParams.ids?.split(",").filter(Boolean) || [];

  if (ids.length < 2) {
    return (
      <main>
        <div style={{ marginBottom: 24 }}>
          <Link href="/" className="muted" style={{ textDecoration: "underline" }}>
            ← Back to corpus
          </Link>
        </div>
        <section className="hero">
          <h1>Compare Mode</h1>
          <p>Please select at least two datasets from the corpus to compare them side-by-side.</p>
        </section>
      </main>
    );
  }

  const payload = await getCompare(ids);

  return (
    <main>
      <div style={{ marginBottom: 24 }}>
        <Link href="/" className="muted" style={{ textDecoration: "underline" }}>
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
