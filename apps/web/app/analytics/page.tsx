import React, { Suspense } from "react";
import Link from "next/link";
import { getAnalyticsCrossTab, getAnalyticsBenchmarks, getToolkitMatrix, getFrontierData } from "../../lib/api";
import { ApiFailurePanel } from "../../components/api-failure-panel";
import { DegradedStatusBanner } from "../../components/degraded-status-banner";
import { AnalyticsControls } from "../../components/analytics-controls";
import { FrontierPlot } from "../../components/frontier-plot";
import { normalizeSearchParams, type RouteSearchParams } from "../../lib/route-props";

export default async function AnalyticsPage({
  searchParams
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const resolvedSearchParams = normalizeSearchParams(await searchParams);
  const allowedRowDims = new Set(["cell_type", "modality", "comparator_class"]);
  const allowedColDims = new Set(["public_data_status", "modality_family", "sample_size_bucket"]);
  const rowDim = allowedRowDims.has(resolvedSearchParams.row || "") ? resolvedSearchParams.row! : "cell_type";
  const colDim = allowedColDims.has(resolvedSearchParams.col || "") ? resolvedSearchParams.col! : "public_data_status";

  const [dataResult, benchmarksResult, toolkitResult, frontierResult] = await Promise.allSettled([
    getAnalyticsCrossTab(rowDim, colDim, resolvedSearchParams),
    getAnalyticsBenchmarks(),
    getToolkitMatrix(resolvedSearchParams),
    getFrontierData(resolvedSearchParams)
  ]);

  const data = dataResult.status === "fulfilled" ? dataResult.value : null;
  const benchmarks = benchmarksResult.status === "fulfilled" ? benchmarksResult.value : null;
  const toolkit = toolkitResult.status === "fulfilled" ? toolkitResult.value : null;
  const frontier = frontierResult.status === "fulfilled" ? frontierResult.value : null;
  const allUnavailable = !data && !benchmarks && !toolkit && !frontier;
  const primaryAnalyticsError =
    dataResult.status === "rejected" ? dataResult.reason :
    benchmarksResult.status === "rejected" ? benchmarksResult.reason :
    toolkitResult.status === "rejected" ? toolkitResult.reason :
    frontierResult.status === "rejected" ? frontierResult.reason :
    new Error("Analytics data did not return.");
  const degradedIssues = [
    frontierResult.status === "rejected"
      ? {
          label: "Frontier plot",
          context: "the imaging frontier plot",
          error: frontierResult.reason
        }
      : null,
    toolkitResult.status === "rejected"
      ? {
          label: "Toolkit matrix",
          context: "the imaging toolkit matrix",
          error: toolkitResult.reason
        }
      : null,
    benchmarksResult.status === "rejected"
      ? {
          label: "Benchmark panel",
          context: "the benchmark panel",
          error: benchmarksResult.reason
        }
      : null,
    dataResult.status === "rejected"
      ? {
          label: "Gap finder",
          context: "the gap finder",
          error: dataResult.reason
        }
      : null
  ].filter(Boolean) as Array<{ label: string; context: string; error: unknown }>;

  const getHeatmapColor = (count: number) => {
    if (count === 0) return "transparent";
    const opacity = Math.min(0.1 + (count / 10) * 0.9, 0.8);
    return `rgba(0, 0, 0, ${opacity})`;
  };

  return (
    <main>
      <section className="hero">
        <div className="kicker">Analytics</div>
        <h1>Corpus Patterns and Reporting Gaps</h1>
        <p>
          Use the current corpus to inspect technical tradeoffs, common reporting patterns, and
          areas that still look thin or unevenly covered.
        </p>
      </section>

      {allUnavailable ? (
        <ApiFailurePanel
          error={primaryAnalyticsError}
          context="the analytics suite"
          page="analytics"
          actionHref="/corpus"
          actionLabel="Back to corpus"
        />
      ) : null}

      {degradedIssues.length > 0 ? (
        <DegradedStatusBanner
          page="analytics"
          title="Analytics Degraded"
          issues={degradedIssues}
        />
      ) : null}

      {/* Frontier Plot: Resolution vs Sample Size */}
      <div className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">The Imaging Frontier</h2>
        <p className="muted" style={{ marginBottom: 32 }}>
          Resolution versus per-dataset sample size across the current corpus.
        </p>
        {frontier ? (
          <FrontierPlot data={frontier} />
        ) : (
          <ApiFailurePanel
            error={frontierResult.status === "rejected" ? frontierResult.reason : new Error("Frontier analytics did not return data.")}
            context="the imaging frontier plot"
            page="analytics"
            title="Frontier plot unavailable"
            compact
          />
        )}
      </div>

      {/* Toolkit Matrix: Organelle vs Modality */}
      <div className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">The Imaging Toolkit</h2>
        <p className="muted" style={{ marginBottom: 32 }}>
          Which modalities are most commonly used for different biological targets in this corpus.
          Organelle names follow the source corpus terminology, including niche structures.
        </p>
        {toolkit ? (
          <div className="analytics-table-wrap">
            <table className="analytics-matrix analytics-matrix-compact">
              <thead>
                <tr>
                  <th>Organelle</th>
                  {toolkit.modalities.map((m: string) => (
                    <th key={m} style={{ textAlign: "center" }}>{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {toolkit.organelles.map((organelle: string) => (
                  <tr key={organelle}>
                    <td className="analytics-matrix-label">{organelle}</td>
                    {toolkit.modalities.map((modality: string) => {
                      const count = toolkit.matrix[organelle]?.[modality] || 0;
                      const size = Math.min(32, 4 + count * 4);
                      return (
                        <td key={modality} className="analytics-matrix-cell">
                          {count > 0 ? (
                            <Link 
                              href={`/corpus?organelle=${encodeURIComponent(organelle)}&family=${encodeURIComponent(modality)}`}
                              title={`${count} datasets`}
                              style={{
                                width: `${size}px`,
                                height: `${size}px`,
                                opacity: 0.1 + (count / 20) * 0.9
                              }}
                              className="toolkit-dot"
                            />
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ApiFailurePanel
            error={toolkitResult.status === "rejected" ? toolkitResult.reason : new Error("Toolkit analytics did not return data.")}
            context="the imaging toolkit matrix"
            page="analytics"
            title="Toolkit matrix unavailable"
            compact
          />
        )}
      </div>

      <div className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">Modality Performance Benchmarks</h2>
        <p className="muted" style={{ marginBottom: 24 }}>
          Typical reported resolution and sample sizes across different imaging families.
        </p>
        {benchmarks ? (
          <div style={{ display: "grid", gap: "24px" }}>
            {benchmarks.map((b: any) => (
              <div key={b.modality_family} className="panel" style={{ background: "var(--background)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
                  <h3 style={{ margin: 0 }}>{b.modality_family}</h3>
                  <span className="muted">{b.count} datasets</span>
                </div>
                
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "40px" }}>
                  <div>
                    <div className="kicker">Resolution (nm)</div>
                    {b.resolution_stats ? (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", marginBottom: 4 }}>
                          <span>Median: {b.resolution_stats.median}nm</span>
                          <span className="muted">Range: {b.resolution_stats.min}–{b.resolution_stats.max}nm</span>
                        </div>
                        <div style={{ height: "8px", background: "var(--accent)", borderRadius: 0, overflow: "hidden" }}>
                          <div style={{ 
                            width: `${Math.max(5, (10 / b.resolution_stats.median) * 100)}%`, 
                            height: "100%", 
                            background: "var(--foreground)" 
                          }} />
                        </div>
                      </div>
                    ) : <span className="muted">No data</span>}
                  </div>
                  
                  <div>
                    <div className="kicker">Sample Size</div>
                    {b.sample_size_stats ? (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", marginBottom: 4 }}>
                          <span>Median: {b.sample_size_stats.median}</span>
                          <span className="muted">Avg: {b.sample_size_stats.avg}</span>
                        </div>
                        <div style={{ height: "8px", background: "var(--accent)", borderRadius: 0, overflow: "hidden" }}>
                          <div style={{ 
                            width: `${Math.min(100, (b.sample_size_stats.median / 50) * 100)}%`, 
                            height: "100%", 
                            background: "var(--foreground)" 
                          }} />
                        </div>
                      </div>
                    ) : <span className="muted">No data</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <ApiFailurePanel
            error={benchmarksResult.status === "rejected" ? benchmarksResult.reason : new Error("Benchmark analytics did not return data.")}
            context="the benchmark panel"
            page="analytics"
            title="Benchmark panel unavailable"
            compact
          />
        )}
      </div>

      <div className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">Gap Finder</h2>
        <p className="muted" style={{ marginBottom: 24 }}>
          Cross-tabulate the corpus to find thinly covered areas and reporting patterns.
        </p>
        
        <Suspense fallback={<div style={{ height: "40px" }} />}>
          <AnalyticsControls rowDim={rowDim} colDim={colDim} />
        </Suspense>

        {data ? (
          <div className="analytics-table-wrap">
            <table className="analytics-matrix analytics-gap-matrix">
              <thead>
                <tr>
                  <th></th>
                  {data.cols.map((col: string) => (
                    <th key={col} style={{ textAlign: "center" }}>{col}</th>
                  ))}
                  <th className="analytics-total-col">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row: string) => (
                  <tr key={row}>
                    <th className="analytics-matrix-label" style={{ textAlign: "right" }}>{row}</th>
                    {data.cols.map((col: string) => {
                      const count = data.table[row]?.[col] || 0;
                      const heatmapColor = getHeatmapColor(count);
                      
                      const params = new URLSearchParams();
                      params.set(rowDim === "modality_family" ? "family" : rowDim, row);
                      
                      if (colDim === "public_data_status" && col !== "none") {
                        params.set("public", "true");
                      } else if (colDim === "whole_cell_boundary_confirmed") {
                        // Boundary isn't a direct filter yet
                      } else {
                        params.set(colDim === "modality_family" ? "family" : colDim, col);
                      }

                      return (
                        <td 
                          key={col} 
                          style={{ 
                            background: heatmapColor
                          }}
                          className="analytics-gap-cell"
                        >
                          {count > 0 ? (
                            <Link 
                              href={`/corpus?${params.toString()}`}
                              className="analytics-gap-link"
                              style={{
                                color: count > 5 ? "var(--background)" : "var(--foreground)"
                              }}
                            >
                              {count}
                            </Link>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className="analytics-total-col" style={{ textAlign: "center" }}>
                      {data.row_totals[row]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ApiFailurePanel
            error={dataResult.status === "rejected" ? dataResult.reason : new Error("Cross-tab analytics did not return data.")}
            context="the gap finder"
            page="analytics"
            title="Gap finder unavailable"
            compact
          />
        )}
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <h2 className="section-title">How to Read This</h2>
        <p className="muted" style={{ lineHeight: 1.6 }}>
          • <strong>Interactive:</strong> Click any dot or count to see the underlying datasets.<br/>
          • <strong>Imaging Toolkit:</strong> The size and opacity of squares show which modalities appear most often for a target in the current corpus, not which one is universally best.<br/>
          • <strong>Benchmarks:</strong> These summarize reported medians and ranges within each modality family.<br/>
          • <strong>Gap Finder:</strong> Use this to compare cell types, modalities, comparators, public-data status, modality families, and sample-size buckets.
        </p>
      </section>
    </main>
  );
}
