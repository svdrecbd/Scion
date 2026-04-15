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
  const rowDim = resolvedSearchParams.row || "cell_type";
  const colDim = resolvedSearchParams.col || "public_data_status";

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
        <div className="kicker">Scion Analytics</div>
        <h1>Corpus Trends & Gaps</h1>
        <p>
          Synthesize technical performance and identify research white-space across the whole-cell imaging landscape.
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
        <p className="muted" style={{ marginBottom: 32 }}>The trade-off between spatial resolution and statistical power (sample size).</p>
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
        <p className="muted" style={{ marginBottom: 32 }}>Which modalities are most effective for specific biological targets?</p>
        {toolkit ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "12px", borderBottom: "1px solid var(--border)" }}>Organelle</th>
                  {toolkit.modalities.map((m: string) => (
                    <th key={m} style={{ padding: "12px", borderBottom: "1px solid var(--border)", textAlign: "center" }}>{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {toolkit.organelles.map((organelle: string) => (
                  <tr key={organelle}>
                    <td style={{ padding: "12px", borderBottom: "1px solid var(--border)", fontWeight: 500 }}>{organelle}</td>
                    {toolkit.modalities.map((modality: string) => {
                      const count = toolkit.matrix[organelle]?.[modality] || 0;
                      const size = Math.min(32, 4 + count * 4);
                      return (
                        <td key={modality} style={{ padding: "12px", borderBottom: "1px solid var(--border)", textAlign: "center", verticalAlign: "middle" }}>
                          {count > 0 ? (
                            <Link 
                              href={`/corpus?organelle=${encodeURIComponent(organelle)}&family=${encodeURIComponent(modality)}`}
                              title={`${count} datasets`}
                              style={{ 
                                display: "block",
                                width: `${size}px`, 
                                height: `${size}px`, 
                                background: "var(--foreground)", 
                                borderRadius: 0, 
                                margin: "0 auto",
                                opacity: 0.1 + (count / 20) * 0.9,
                                transition: "transform 0.2s"
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
        <p className="muted" style={{ marginBottom: 24 }}>Typical resolution and sample sizes achieved across different imaging families.</p>
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
        <p className="muted" style={{ marginBottom: 24 }}>Cross-tabulate the corpus to find under-studied areas or reporting failures.</p>
        
        <Suspense fallback={<div style={{ height: "40px" }} />}>
          <AnalyticsControls rowDim={rowDim} colDim={colDim} />
        </Suspense>

        {data ? (
          <div style={{ overflowX: "auto" }}>
            <table className="compare-matrix" style={{ borderCollapse: "separate", borderSpacing: "2px" }}>
              <thead>
                <tr>
                  <th style={{ background: "transparent" }}></th>
                  {data.cols.map((col: string) => (
                    <th key={col} style={{ textAlign: "center", minWidth: "100px" }}>{col}</th>
                  ))}
                  <th style={{ background: "var(--accent)" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row: string) => (
                  <tr key={row}>
                    <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>{row}</th>
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
                            padding: 0,
                            border: "none",
                            background: heatmapColor,
                            borderRadius: 0
                          }}
                        >
                          {count > 0 ? (
                            <Link 
                              href={`/corpus?${params.toString()}`}
                              style={{ 
                                display: "block",
                                padding: "16px 8px",
                                textDecoration: "none",
                                color: count > 5 ? "var(--background)" : "var(--foreground)",
                                fontWeight: 600
                              }}
                            >
                              {count}
                            </Link>
                          ) : null}
                        </td>
                      );
                    })}
                    <td style={{ textAlign: "center", background: "var(--accent)", fontWeight: 600 }}>
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
        <h2 className="section-title">How to read this</h2>
        <p className="muted" style={{ lineHeight: 1.6 }}>
          • <strong>Interactive:</strong> Click any dot or count to see the underlying datasets.<br/>
          • <strong>Imaging Toolkit:</strong> The size/opacity of squares shows which modality is the "standard" for an organelle.<br/>
          • <strong>Benchmarks:</strong> Establish what is technically "standard" for a modality family.<br/>
          • <strong>Gap Finder:</strong> Find biological systems or conditions that lack specific types of evidence.
        </p>
      </section>
    </main>
  );
}
