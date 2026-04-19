import React, { Suspense } from "react";
import Link from "next/link";
import { getAnalyticsCrossTab, getAnalyticsBenchmarks, getToolkitMatrix, getMeasurementGrammar, getReusabilityMap, getCoverageAtlas, getCorpusTimeline, getFrontierData } from "../../lib/api";
import { ApiFailurePanel } from "../../components/api-failure-panel";
import { DegradedStatusBanner } from "../../components/degraded-status-banner";
import { AnalyticsControls } from "../../components/analytics-controls";
import { FrontierPlot } from "../../components/frontier-plot";
import { CoverageTerrain } from "../../components/coverage-terrain";
import { InstrumentEnvelopePlot } from "../../components/instrument-envelope-plot";
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

  const [dataResult, benchmarksResult, toolkitResult, grammarResult, reusabilityResult, coverageResult, timelineResult, frontierResult] = await Promise.allSettled([
    getAnalyticsCrossTab(rowDim, colDim, resolvedSearchParams),
    getAnalyticsBenchmarks(),
    getToolkitMatrix(resolvedSearchParams),
    getMeasurementGrammar(resolvedSearchParams),
    getReusabilityMap(resolvedSearchParams),
    getCoverageAtlas(resolvedSearchParams),
    getCorpusTimeline(resolvedSearchParams),
    getFrontierData(resolvedSearchParams)
  ]);

  const data = dataResult.status === "fulfilled" ? dataResult.value : null;
  const benchmarks = benchmarksResult.status === "fulfilled" ? benchmarksResult.value : null;
  const toolkit = toolkitResult.status === "fulfilled" ? toolkitResult.value : null;
  const grammar = grammarResult.status === "fulfilled" ? grammarResult.value : null;
  const reusability = reusabilityResult.status === "fulfilled" ? reusabilityResult.value : null;
  const coverage = coverageResult.status === "fulfilled" ? coverageResult.value : null;
  const timeline = timelineResult.status === "fulfilled" ? timelineResult.value : null;
  const frontier = frontierResult.status === "fulfilled" ? frontierResult.value : null;
  const allUnavailable = !data && !benchmarks && !toolkit && !grammar && !reusability && !coverage && !timeline && !frontier;
  const primaryAnalyticsError =
    dataResult.status === "rejected" ? dataResult.reason :
    benchmarksResult.status === "rejected" ? benchmarksResult.reason :
    toolkitResult.status === "rejected" ? toolkitResult.reason :
    grammarResult.status === "rejected" ? grammarResult.reason :
    reusabilityResult.status === "rejected" ? reusabilityResult.reason :
    coverageResult.status === "rejected" ? coverageResult.reason :
    timelineResult.status === "rejected" ? timelineResult.reason :
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
    grammarResult.status === "rejected"
      ? {
          label: "Measurement grammar",
          context: "the organelle measurement grammar",
          error: grammarResult.reason
        }
      : null,
    reusabilityResult.status === "rejected"
      ? {
          label: "Reusability map",
          context: "the public data reusability map",
          error: reusabilityResult.reason
        }
      : null,
    coverageResult.status === "rejected"
      ? {
          label: "Coverage atlas",
          context: "the cell-type coverage atlas",
          error: coverageResult.reason
        }
      : null,
    timelineResult.status === "rejected"
      ? {
          label: "Timeline",
          context: "the corpus timeline",
          error: timelineResult.reason
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

  const maxGapCount = data
    ? Math.max(
        1,
        ...data.rows.flatMap((row: string) =>
          data.cols.map((col: string) => data.table[row]?.[col] || 0)
        )
      )
    : 1;

  const getHeatmapColor = (count: number) => {
    if (count === 0) return "transparent";
    const opacity = Math.min(0.18 + (count / maxGapCount) * 0.68, 0.86);
    return `rgba(22, 139, 179, ${opacity})`;
  };

  const maxGrammarCount = grammar
    ? Math.max(
        1,
        ...grammar.organelles.flatMap((organelleValue: string) =>
          grammar.metric_families.map(
            (metricFamily: string) => grammar.matrix[organelleValue]?.[metricFamily] || 0
          )
        )
      )
    : 1;

  const buildCorpusHref = (extra: Record<string, string | null>) => {
    const params = new URLSearchParams();
    [
      "query",
      "year",
      "cell_type",
      "organelle",
      "pair",
      "modality",
      "family",
      "metric",
      "comparator_class",
      "status",
      "public",
      "borderline"
    ].forEach((key) => {
      const value = resolvedSearchParams[key];
      if (value) params.set(key, value);
    });
    Object.entries(extra).forEach(([key, value]) => {
      if (value === null) params.delete(key);
      else params.set(key, value);
    });
    return `/corpus?${params.toString()}`;
  };

  const publicDataStatusLabels: Record<string, string> = {
    complete: "Complete",
    partial: "Partial",
    none: "None"
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

      <section className="figure-plate">
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">The Imaging Frontier</h2>
            <p className="muted">
              Resolution versus per-dataset sample size across the current corpus.
            </p>
          </div>
          <div className="figure-number">Plate A01</div>
        </div>
        {frontier ? (
          <FrontierPlot data={frontier} timeline={timeline} />
        ) : (
          <ApiFailurePanel
            error={frontierResult.status === "rejected" ? frontierResult.reason : new Error("Frontier analytics did not return data.")}
            context="the imaging frontier plot"
            page="analytics"
            title="Frontier plot unavailable"
            compact
          />
        )}
        <p className="figure-caption">
          Frontier mode is fixed log-log. Use the view controls to switch from per-record
          frontier position into corpus volume over time or public-data share.
        </p>
      </section>

      <section className="figure-plate">
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">The Imaging Toolkit</h2>
            <p className="muted">
              Which modalities are most commonly used for different biological targets in this
              corpus. Organelle names follow the source corpus terminology, including niche
              structures.
            </p>
          </div>
          <div className="figure-number">Plate A02</div>
        </div>
        {toolkit ? (
          <div className="analytics-table-wrap analytics-gap-wrap">
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
        <p className="figure-caption">
          Square area and blue intensity increase with record count. Empty cells are left as paper,
          not zero-value decoration.
        </p>
      </section>

      <section className="figure-plate">
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">Organelle Measurement Grammar</h2>
            <p className="muted">
              Which biological structures have actual quantified metric families attached to
              them, not just visual coverage.
            </p>
          </div>
          <div className="figure-number">Plate A03</div>
        </div>
        {grammar ? (
          grammar.organelles.length > 0 && grammar.metric_families.length > 0 ? (
            <div className="analytics-table-wrap">
              <table className="analytics-matrix analytics-matrix-compact measurement-grammar-matrix">
                <thead>
                  <tr>
                    <th>Organelle</th>
                    {grammar.metric_families.map((metricFamily: string) => (
                      <th key={metricFamily} style={{ textAlign: "center" }}>{metricFamily}</th>
                    ))}
                    <th style={{ textAlign: "center" }}>Metric Families</th>
                  </tr>
                </thead>
                <tbody>
                  {grammar.organelles.map((organelleValue: string) => {
                    const diversity = grammar.organelle_metric_family_counts[organelleValue] || 0;
                    const total = grammar.organelle_totals[organelleValue] || 0;
                    const diversityWidth = `${Math.round(
                      (diversity / grammar.metric_families.length) * 100
                    )}%`;

                    return (
                      <tr key={organelleValue}>
                        <td className="analytics-matrix-label">
                          <Link href={buildCorpusHref({ organelle: organelleValue })}>
                            {organelleValue}
                          </Link>
                        </td>
                        {grammar.metric_families.map((metricFamily: string) => {
                          const count = grammar.matrix[organelleValue]?.[metricFamily] || 0;
                          const size = Math.min(30, 5 + Math.sqrt(count) * 6);
                          const opacity = Math.min(0.22 + (count / maxGrammarCount) * 0.76, 0.98);

                          return (
                            <td key={metricFamily} className="analytics-matrix-cell">
                              {count > 0 ? (
                                <Link
                                  href={buildCorpusHref({
                                    organelle: organelleValue,
                                    metric: metricFamily
                                  })}
                                  aria-label={`${count} ${organelleValue} records with ${metricFamily} metrics`}
                                  title={`${count} records`}
                                  style={{
                                    width: `${size}px`,
                                    height: `${size}px`,
                                    opacity
                                  }}
                                  className="grammar-dot"
                                />
                              ) : null}
                            </td>
                          );
                        })}
                        <td className="grammar-diversity-cell">
                          <span className="grammar-diversity-track" aria-hidden="true">
                            <span
                              className="grammar-diversity-fill"
                              style={{ width: diversityWidth }}
                            />
                          </span>
                          <span>{diversity} / {grammar.metric_families.length}</span>
                          <span className="muted"> · {total} records</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="panel">
              <p className="muted" style={{ margin: 0 }}>
                No organelle-metric pairings match the current filter set.
              </p>
            </div>
          )
        ) : (
          <ApiFailurePanel
            error={grammarResult.status === "rejected" ? grammarResult.reason : new Error("Measurement grammar analytics did not return data.")}
            context="the organelle measurement grammar"
            page="analytics"
            title="Measurement grammar unavailable"
            compact
          />
        )}
        <p className="figure-caption">
          Rows are sorted by metric diversity, then record count. Click a blue mark to inspect the
          exact corpus slice behind that organelle and metric family.
        </p>
      </section>

      <section className="figure-plate">
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">Public Data Reusability Map</h2>
            <p className="muted">
              Which biological structures have reusable public data attached today, and whether
              that access is complete, partial, or absent in the current index.
            </p>
          </div>
          <div className="figure-number">Plate A04</div>
        </div>
        {reusability ? (
          reusability.organelles.length > 0 ? (
            <div className="analytics-table-wrap">
              <table className="analytics-matrix analytics-matrix-compact reusability-map-table">
                <thead>
                  <tr>
                    <th>Organelle</th>
                    {reusability.statuses.map((status: string) => (
                      <th key={status} style={{ textAlign: "center" }}>
                        {publicDataStatusLabels[status] ?? status}
                      </th>
                    ))}
                    <th style={{ textAlign: "center" }}>Reusable Share</th>
                    <th>Reusable Modalities</th>
                    <th>Reusable Metrics</th>
                  </tr>
                </thead>
                <tbody>
                  {reusability.organelles.map((organelleValue: string) => {
                    const total = reusability.row_totals[organelleValue] || 0;
                    const reusable = reusability.reusable_totals[organelleValue] || 0;
                    const share = reusability.public_share[organelleValue] || 0;
                    const modalities = reusability.reusable_modality_families[organelleValue] || [];
                    const metrics = reusability.reusable_metric_families[organelleValue] || [];

                    return (
                      <tr key={organelleValue}>
                        <td className="analytics-matrix-label">
                          <Link href={buildCorpusHref({ organelle: organelleValue })}>
                            {organelleValue}
                          </Link>
                        </td>
                        {reusability.statuses.map((status: string) => {
                          const count = reusability.matrix[organelleValue]?.[status] || 0;
                          const width = total ? `${Math.max(6, Math.round((count / total) * 100))}%` : "0%";

                          return (
                            <td key={status} className="reusability-status-cell">
                              {count > 0 ? (
                                <Link
                                  href={buildCorpusHref({
                                    organelle: organelleValue,
                                    status,
                                    public: null
                                  })}
                                  className={`reusability-status-link reusability-status-${status}`}
                                  title={`${count} ${status} records`}
                                >
                                  <span className="reusability-status-bar" style={{ width }} />
                                  <span>{count}</span>
                                </Link>
                              ) : null}
                            </td>
                          );
                        })}
                        <td className="reusability-share-cell">
                          <Link
                            href={buildCorpusHref({
                              organelle: organelleValue,
                              public: "true",
                              status: null
                            })}
                            className="reusability-share-link"
                            title={`${reusable} reusable records out of ${total}`}
                          >
                            <span className="reusability-share-track" aria-hidden="true">
                              <span
                                className="reusability-share-fill"
                                style={{ width: `${Math.round(share * 100)}%` }}
                              />
                            </span>
                            <span className="reusability-share-percent">{Math.round(share * 100)}%</span>
                          </Link>
                        </td>
                        <td className="reusability-trait-cell">
                          {modalities.length > 0 ? modalities.join(", ") : <span className="muted">none indexed</span>}
                        </td>
                        <td className="reusability-trait-cell">
                          {metrics.length > 0 ? metrics.slice(0, 5).join(", ") : <span className="muted">none indexed</span>}
                          {metrics.length > 5 ? <span className="muted"> +{metrics.length - 5}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="panel">
              <p className="muted" style={{ margin: 0 }}>
                No public-data status records match the current filter set.
              </p>
            </div>
          )
        ) : (
          <ApiFailurePanel
            error={reusabilityResult.status === "rejected" ? reusabilityResult.reason : new Error("Reusability map analytics did not return data.")}
            context="the public data reusability map"
            page="analytics"
            title="Reusability map unavailable"
            compact
          />
        )}
        <p className="figure-caption">
          Complete and partial both mean some reusable public data is known. None means Scion has
          not indexed a reusable public-data locator for that organelle in the current corpus slice.
        </p>
      </section>

      <section className="figure-plate">
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">Cell-Type Coverage Atlas</h2>
            <p className="muted">
              Organelle-by-cell-type coverage across the strongest intersections in the current
              corpus slice.
            </p>
          </div>
          <div className="figure-number">Plate A05</div>
        </div>
        {coverage ? (
          coverage.cell_types.length > 0 && coverage.organelles.length > 0 ? (
            <CoverageTerrain coverage={coverage} activeParams={resolvedSearchParams} />
          ) : (
            <div className="panel">
              <p className="muted" style={{ margin: 0 }}>
                No cell-type/organelle pairings match the current filter set.
              </p>
            </div>
          )
        ) : (
          <ApiFailurePanel
            error={coverageResult.status === "rejected" ? coverageResult.reason : new Error("Coverage atlas analytics did not return data.")}
            context="the cell-type coverage atlas"
            page="analytics"
            title="Coverage atlas unavailable"
            compact
          />
        )}
        <p className="figure-caption">
          Color encodes record count. Click labels or cells to inspect the exact records behind
          each cell-type and organelle pairing.
        </p>
      </section>

      <section className="figure-plate">
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">Instrument Envelope Plot</h2>
            <p className="muted">
              Operating range of each imaging family across reported resolution and whole-cell
              sample size.
            </p>
          </div>
          <div className="figure-number">Plate A06</div>
        </div>
        {benchmarks ? (
          <InstrumentEnvelopePlot benchmarks={benchmarks} />
        ) : (
          <ApiFailurePanel
            error={benchmarksResult.status === "rejected" ? benchmarksResult.reason : new Error("Benchmark analytics did not return data.")}
            context="the benchmark panel"
            page="analytics"
            title="Benchmark panel unavailable"
            compact
          />
        )}
        <p className="figure-caption">
          Each rectangle is the reported min-to-max envelope for one modality family. The square
          marks the median resolution and median sample size; median rules show where that point
          sits inside the envelope.
        </p>
      </section>

      <section className="figure-plate">
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">Gap Finder</h2>
            <p className="muted">
              Cross-tabulate the corpus to find thinly covered areas and reporting patterns.
            </p>
          </div>
          <div className="figure-number">Plate A07</div>
        </div>
        
        <Suspense fallback={<div style={{ height: "40px" }} />}>
          <AnalyticsControls rowDim={rowDim} colDim={colDim} />
        </Suspense>

        {data ? (
          <div className="analytics-table-wrap analytics-gap-wrap">
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
                    <th className="analytics-matrix-label" style={{ textAlign: "right" }} title={row}>{row}</th>
                    {data.cols.map((col: string) => {
                      const count = data.table[row]?.[col] || 0;
                      const heatmapColor = getHeatmapColor(count);
                      
                      const params = new URLSearchParams();
                      params.set(rowDim === "modality_family" ? "family" : rowDim, row);
                      
                      if (colDim === "public_data_status") {
                        params.set("status", col);
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
        <p className="figure-caption">
          Blue intensity is normalized to the largest cell in the current cross-tab. White space is
          meaningful: it marks combinations not represented in the current corpus slice.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 24 }}>
        <h2 className="section-title">How to Read This</h2>
        <p className="muted" style={{ lineHeight: 1.6 }}>
          • <strong>Interactive:</strong> Click any dot or count to see the underlying datasets.<br/>
          • <strong>Imaging Toolkit:</strong> The size and opacity of squares show which modalities appear most often for a target in the current corpus, not which one is universally best.<br/>
          • <strong>Measurement Grammar:</strong> Blue marks show where an organelle has quantified metric families attached; empty space means the metadata does not currently support that pairing.<br/>
          • <strong>Reusability Map:</strong> Complete and partial public-data states link to reusable corpus slices; none marks records without an indexed reusable data locator.<br/>
          • <strong>Coverage Atlas:</strong> Cell type stays the primary row label, with species shown only as context so the biological axis remains readable.<br/>
          • <strong>Imaging Frontier:</strong> Switch views to move between resolution/sample-size frontier, annual corpus volume, and public-data share.<br/>
          • <strong>Instrument Envelope:</strong> These summarize reported operating ranges and medians within each modality family.<br/>
          • <strong>Gap Finder:</strong> Use this to compare cell types, modalities, comparators, public-data status, modality families, and sample-size buckets.
        </p>
      </section>
    </main>
  );
}
