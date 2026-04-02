import React from "react";
import Link from "next/link";
import { getDatasets, getExperimentPlan } from "../../lib/api";
import { DatasetCard } from "../../components/dataset-card";

export default async function PlanPage({
  searchParams
}: {
  searchParams: { organelles?: string; res?: string; ss?: string };
}) {
  const isPlanning = searchParams.organelles && searchParams.res && searchParams.ss;
  
  let analysis = null;
  if (isPlanning) {
    analysis = await getExperimentPlan(
      searchParams.organelles!,
      parseFloat(searchParams.res!),
      parseInt(searchParams.ss!)
    );
  }

  // Get common organelles for the dropdown
  const searchResponse = await getDatasets();
  const commonOrganelles = searchResponse.commonalities.top_organelles;

  return (
    <main>
      <section className="hero">
        <div className="kicker">Experiment Assistant</div>
        <h1>Design Your Next Study</h1>
        <p>
          Input your biological targets and technical requirements to validate your plan against the current Imaging Frontier.
        </p>
      </section>

      {!isPlanning ? (
        <section className="panel" style={{ marginTop: 48, maxWidth: "600px" }}>
          <form action="/plan" style={{ display: "grid", gap: "24px" }}>
            <div>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Target Organelles</label>
              <select name="organelles" className="search-input" style={{ width: "100%" }} required>
                <option value="">Select an organelle...</option>
                {commonOrganelles.map(o => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>Select the primary structure you intend to quantify.</p>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Required Resolution (nm)</label>
              <input type="number" name="res" defaultValue="10" className="search-input" style={{ width: "100%" }} required />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>What is the largest voxel size that still reveals your target?</p>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Statistical Scope (Cells)</label>
              <input type="number" name="ss" defaultValue="10" className="search-input" style={{ width: "100%" }} required />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>How many whole cells do you need for your analysis?</p>
            </div>

            <button type="submit" className="button" style={{ marginTop: 12 }}>Analyze Feasibility</button>
          </form>
        </section>
      ) : (
        <div style={{ marginTop: 48 }}>
          <div style={{ marginBottom: 24 }}>
            <Link href="/plan" className="muted" style={{ textDecoration: "underline" }}>
              ← Edit Plan
            </Link>
          </div>

          <div className="panel-grid two">
            <div className="summary-grid">
              <section className="panel" style={{ borderLeft: `8px solid ${getStatusColor(analysis.status)}` }}>
                <div className="kicker" style={{ color: getStatusColor(analysis.status) }}>{analysis.status.toUpperCase()}</div>
                <h2 className="section-title">Feasibility Report</h2>
                <p style={{ fontSize: "1.1rem", lineHeight: 1.6 }}>{analysis.status_message}</p>
              </section>

              <section className="panel">
                <h2 className="section-title">Modality Recommendation</h2>
                <p>{analysis.modality_recommendation}</p>
              </section>

              <section className="panel">
                <h2 className="section-title">Comparability Benchmarks</h2>
                <p className="muted">To align with the existing corpus for <strong>{analysis.biological_target}</strong>, prioritize these metrics:</p>
                <div className="pill-row" style={{ marginTop: 12 }}>
                  {analysis.standard_metrics.map((m: string) => (
                    <span key={m} className="pill">{m}</span>
                  ))}
                </div>
              </section>

              <section className="panel">
                <h2 className="section-title">Full Precedent List</h2>
                <p className="muted" style={{ marginBottom: 16 }}>Every dataset in the corpus that informs this feasibility assessment:</p>
                <div className="dataset-grid">
                  {analysis.precedents.map((p: any) => (
                    <DatasetCard key={p.dataset_id} dataset={p} />
                  ))}
                </div>
              </section>
            </div>

            <aside style={{ display: "grid", gap: 16 }}>
              <section className="panel">
                <h2 className="section-title">Baseline Data</h2>
                <p className="muted">Download these public datasets for your project:</p>
                <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                  {analysis.suggested_baselines.length > 0 ? (
                    analysis.suggested_baselines.map((b: any) => (
                      <Link key={b.dataset_id} href={`/datasets/${b.dataset_id}`} style={{ textDecoration: "none", display: "block", borderBottom: "1px solid var(--border)", paddingBottom: "12px" }}>
                        <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>{b.modality} · {b.cell_type}</div>
                        <div style={{ fontWeight: 500, fontSize: "0.95rem" }}>{b.title}</div>
                        <div className="pill pill-link" style={{ marginTop: 8, textAlign: "center", fontSize: "0.8rem" }}>
                          View Reusable Data
                        </div>
                      </Link>
                    ))
                  ) : (
                    <span className="muted">No public baseline data found for this target.</span>
                  )}
                </div>
              </section>
            </aside>
          </div>
        </div>
      )}
    </main>
  );
}

function getStatusColor(status: string) {
  switch (status) {
    case "feasible": return "#2e7d32";
    case "challenging": return "#ed6c02";
    case "high-risk": return "#d32f2f";
    case "frontier": return "#1976d2";
    default: return "var(--border)";
  }
}
