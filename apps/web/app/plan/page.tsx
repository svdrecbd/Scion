import React from "react";
import Link from "next/link";
import { ApiFailurePanel } from "../../components/api-failure-panel";
import { BadgeLegend } from "../../components/badge-legend";
import { DegradedStatusBanner } from "../../components/degraded-status-banner";
import { getDatasets, getExperimentPlan } from "../../lib/api";
import { DatasetCard } from "../../components/dataset-card";
import { normalizeSearchParams, type RouteSearchParams } from "../../lib/route-props";

export default async function PlanPage({
  searchParams
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const resolvedSearchParams = normalizeSearchParams(await searchParams);
  const isPlanning =
    resolvedSearchParams.organelles &&
    resolvedSearchParams.res &&
    resolvedSearchParams.ss;
  
  let analysis = null;
  let analysisError: unknown = null;
  if (isPlanning) {
    try {
      analysis = await getExperimentPlan(
        resolvedSearchParams.organelles!,
        parseFloat(resolvedSearchParams.res!),
        parseInt(resolvedSearchParams.ss!)
      );
    } catch (error) {
      analysisError = error;
    }
  }

  let commonOrganelles: string[] = [];
  let corpusLookupError: unknown = null;

  try {
    const searchResponse = await getDatasets();
    commonOrganelles = searchResponse.commonalities.top_organelles;
  } catch (error) {
    corpusLookupError = error;
  }

  const degradedIssues = [
    analysisError
      ? {
          label: "Experiment analysis",
          context: "the experiment plan analysis",
          error: analysisError
        }
      : null,
    corpusLookupError
      ? {
          label: "Corpus suggestions",
          context: isPlanning ? "planner corpus suggestions" : "planner organelle suggestions",
          error: corpusLookupError
        }
      : null
  ].filter(Boolean) as Array<{ label: string; context: string; error: unknown }>;

  return (
    <main>
      <section className="hero">
        <div className="kicker">Planner</div>
        <h1>Benchmark a Proposed Study</h1>
        <p>
          Use the current corpus to benchmark a proposed target, resolution, and whole-cell count
          against existing precedent. This is a heuristic planning aid, not an experimental design oracle.
        </p>
      </section>

      {degradedIssues.length > 0 ? (
        <DegradedStatusBanner
          page="plan"
          title="Planner Degraded"
          issues={degradedIssues}
        />
      ) : null}

      {!isPlanning ? (
        <section className="panel" style={{ marginTop: 48, maxWidth: "600px" }}>
          {corpusLookupError ? (
            <div style={{ marginBottom: 20 }}>
              <ApiFailurePanel
                error={corpusLookupError}
                context="planner organelle suggestions"
                page="plan"
                title="Corpus-backed suggestions unavailable"
                compact
              />
            </div>
          ) : null}
          <form action="/plan" style={{ display: "grid", gap: "24px" }}>
            <div>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Target Organelle</label>
              {commonOrganelles.length > 0 ? (
                <select name="organelles" className="search-input" style={{ width: "100%" }} required>
                  <option value="">Select an organelle...</option>
                  {commonOrganelles.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  name="organelles"
                  defaultValue={resolvedSearchParams.organelles ?? ""}
                  className="search-input"
                  style={{ width: "100%" }}
                  placeholder="e.g. mitochondria"
                  required
                />
              )}
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                Current planner version accepts one organelle at a time and uses organelle matches
                as the biological filter.
              </p>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Required Resolution (nm)</label>
              <input type="number" name="res" defaultValue="10" className="search-input" style={{ width: "100%" }} required />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                Current planner logic treats this as the target lateral resolution threshold.
              </p>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Statistical Scope (Whole-Cell Count)</label>
              <input type="number" name="ss" defaultValue="10" className="search-input" style={{ width: "100%" }} required />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                Current planner logic interprets this as approximate whole-cell count per study, not
                pooled N across all precedent studies.
              </p>
            </div>

            <button type="submit" className="button" style={{ marginTop: 12 }}>Benchmark This Plan</button>
          </form>

          <section className="panel" style={{ background: "var(--background)", marginTop: 24 }}>
            <h2 className="section-title">Current Planner Rules</h2>
            <div className="muted" style={{ display: "grid", gap: 8, lineHeight: 1.6 }}>
              <div><strong>Frontier</strong>: no record in the corpus captures the requested organelle.</div>
              <div><strong>High-Risk</strong>: matching organelle records exist, but none meet the current resolution and sample-size thresholds.</div>
              <div><strong>Challenging</strong>: fewer than three records meet the current thresholds.</div>
              <div><strong>Feasible</strong>: three or more records meet the current thresholds.</div>
            </div>
          </section>
        </section>
      ) : (
        <div style={{ marginTop: 48 }}>
          <div style={{ marginBottom: 24 }}>
            <Link href="/plan" className="muted" style={{ textDecoration: "underline" }}>
              ← Edit Plan
            </Link>
          </div>

          {analysis ? (
            <div className="panel-grid two">
              <div className="summary-grid">
                <section className="panel" style={{ borderLeft: `8px solid ${getStatusColor(analysis.status)}` }}>
                  <div className="kicker" style={{ color: getStatusColor(analysis.status) }}>{analysis.status.toUpperCase()}</div>
                  <h2 className="section-title">Feasibility Report</h2>
                  <p style={{ fontSize: "1.1rem", lineHeight: 1.6 }}>{analysis.status_message}</p>
                  <p className="muted" style={{ margin: "12px 0 0", lineHeight: 1.6 }}>
                    This status is based on a simple corpus heuristic: organelle match first, then
                    whether records reach roughly the requested resolution and whole-cell count.
                  </p>
                </section>

                <section className="panel">
                  <h2 className="section-title">Modality Recommendation</h2>
                  <p>{analysis.modality_recommendation}</p>
                </section>

                <section className="panel">
                  <h2 className="section-title">Commonly Reported Metrics</h2>
                  <p className="muted">Across matching records for <strong>{analysis.biological_target}</strong>, these metric families appear most often:</p>
                  <div className="pill-row" style={{ marginTop: 12 }}>
                    {analysis.standard_metrics.map((m: string) => (
                      <span key={m} className="pill">{m}</span>
                    ))}
                  </div>
                </section>

                <section className="panel">
                  <h2 className="section-title">Full Precedent List</h2>
                  <p className="muted" style={{ marginBottom: 16 }}>
                    The records currently informing this planner result.
                  </p>
                  <BadgeLegend title="Card Tag Legend" compact />
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
                  <p className="muted">These public records may provide reusable baseline data for this target:</p>
                  <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                    {analysis.suggested_baselines.length > 0 ? (
                      analysis.suggested_baselines.map((b: any) => (
                        <Link key={b.dataset_id} href={`/datasets/${b.dataset_id}`} style={{ textDecoration: "none", display: "block", borderBottom: "1px solid var(--border)", paddingBottom: "12px" }}>
                          <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>{b.modality} · {b.cell_type}</div>
                          <div style={{ fontWeight: 500, fontSize: "0.95rem" }}>{b.title}</div>
                          <div className="pill pill-link" style={{ marginTop: 8, textAlign: "center", fontSize: "0.8rem" }}>
                            Open Record
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
          ) : (
            <ApiFailurePanel
              error={analysisError}
              context="the experiment plan analysis"
              page="plan"
              title="Experiment analysis unavailable"
            />
          )}
          {corpusLookupError ? (
            <div style={{ marginTop: 20 }}>
              <ApiFailurePanel
                error={corpusLookupError}
                context="planner corpus suggestions"
                page="plan"
                title="Corpus suggestion sidebar unavailable"
                compact
              />
            </div>
          ) : null}
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
