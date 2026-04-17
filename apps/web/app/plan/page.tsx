import React from "react";
import Link from "next/link";
import { ApiFailurePanel } from "../../components/api-failure-panel";
import { DegradedStatusBanner } from "../../components/degraded-status-banner";
import { getExperimentPlan, getFacets } from "../../lib/api";
import { normalizeSearchParams, type RouteSearchParams } from "../../lib/route-props";
import type { DatasetRecord, FacetResponse, PlanAnalysis } from "../../lib/types";

const modalityFamilies = ["EM", "X-ray", "optical", "other"];

export default async function PlanPage({
  searchParams
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const resolvedSearchParams = normalizeSearchParams(await searchParams);
  const selectedOrganelles = splitParam(resolvedSearchParams.organelles);
  const isPlanning = selectedOrganelles.length > 0;

  const planParams = {
    organelles: selectedOrganelles.join(","),
    res: resolvedSearchParams.res,
    ss: resolvedSearchParams.ss,
    cell_type: resolvedSearchParams.cell_type,
    metric: resolvedSearchParams.metric,
    comparator_class: resolvedSearchParams.comparator_class,
    family: resolvedSearchParams.family
  };

  let analysis: PlanAnalysis | null = null;
  let analysisError: unknown = null;
  if (isPlanning) {
    try {
      analysis = await getExperimentPlan(planParams);
    } catch (error) {
      analysisError = error;
    }
  }

  let facets: FacetResponse | null = null;
  let corpusLookupError: unknown = null;

  try {
    facets = await getFacets();
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
          label: "Planner criteria",
          context: isPlanning ? "planner criteria labels" : "planner criteria options",
          error: corpusLookupError
        }
      : null
  ].filter(Boolean) as Array<{ label: string; context: string; error: unknown }>;

  const precedentQuery = resolvedSearchParams.precedent_query || "";
  const precedentSort = resolvedSearchParams.precedent_sort || "year_desc";
  const displayedPrecedents = analysis
    ? sortPrecedents(filterPrecedents(analysis.precedents, precedentQuery), precedentSort)
    : [];
  const pmids = analysis ? unique(analysis.precedents.map((record) => record.publication_pmid).filter(Boolean) as string[]) : [];
  const planExportHref = `/api/datasets/analytics/plan/export${buildQueryString(planParams)}`;
  const pubmedHref = pmids.length > 0
    ? `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(pmids.join(","))}`
    : null;

  return (
    <main>
      <section className="hero">
        <div className="kicker">Planner</div>
        <h1>Benchmark a Proposed Study</h1>
        <p>
          Use the current corpus to benchmark a proposed target against existing precedent. This is
          a literature-navigation aid, not a judgment that the experiment is biologically feasible.
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
        <section className="panel" style={{ marginTop: 48 }}>
          {corpusLookupError ? (
            <div style={{ marginBottom: 20 }}>
              <ApiFailurePanel
                error={corpusLookupError}
                context="planner criteria options"
                page="plan"
                title="Corpus-backed criteria unavailable"
                compact
              />
            </div>
          ) : null}
          <PlanForm
            facets={facets}
            selectedOrganelles={selectedOrganelles}
            resolvedSearchParams={resolvedSearchParams}
          />

          <section className="panel" style={{ background: "var(--background)", marginTop: 24 }}>
            <h2 className="section-title">Current Planner Rules</h2>
            <div className="muted" style={{ display: "grid", gap: 8, lineHeight: 1.6 }}>
              <div><strong>Match rule</strong>: records match if they contain at least one selected organelle.</div>
              <div><strong>Resolution</strong>: blank means any; otherwise records pass if lateral resolution is within 1.5x of the requested value.</div>
              <div><strong>Statistical Scope</strong>: blank means any; otherwise records pass if whole-cell count is at least half the requested value.</div>
              <div><strong>Frontier</strong>: no record in the corpus captures the selected organelle target.</div>
              <div><strong>High-Risk</strong>: matching records exist, but none meet the active threshold filters.</div>
              <div><strong>Challenging</strong>: fewer than three records meet the active filters.</div>
              <div><strong>Feasible</strong>: three or more records meet the active filters.</div>
            </div>
          </section>
        </section>
      ) : (
        <div style={{ marginTop: 48 }}>
          <div style={{ marginBottom: 24 }}>
            <Link href="/plan" className="muted" style={{ textDecoration: "underline" }}>
              Edit Plan
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
                    {analysis.matched_records_count} records matched at least one selected organelle.{" "}
                    {analysis.threshold_records_count} records passed the active threshold filters.
                  </p>
                </section>

                <section className="panel">
                  <h2 className="section-title">Active Criteria</h2>
                  <div className="pill-row">
                    {selectedOrganelles.map((organelle) => (
                      <span key={organelle} className="pill">{organelle}</span>
                    ))}
                    <span className="pill">Resolution: {resolvedSearchParams.res ? `${resolvedSearchParams.res} nm` : "Any"}</span>
                    <span className="pill">Whole-Cell Count: {resolvedSearchParams.ss || "Any"}</span>
                    {resolvedSearchParams.cell_type ? <span className="pill">Cell Type: {resolvedSearchParams.cell_type}</span> : null}
                    {resolvedSearchParams.metric ? <span className="pill">Metric: {resolvedSearchParams.metric}</span> : null}
                    {resolvedSearchParams.comparator_class ? <span className="pill">Comparator: {resolvedSearchParams.comparator_class}</span> : null}
                    {resolvedSearchParams.family ? <span className="pill">Family: {resolvedSearchParams.family}</span> : null}
                  </div>
                </section>

                <section className="panel">
                  <h2 className="section-title">Modality Recommendation</h2>
                  <p>{analysis.modality_recommendation}</p>
                </section>

                <section className="panel">
                  <h2 className="section-title">Commonly Reported Metrics</h2>
                  <p className="muted">Across matching records for <strong>{analysis.biological_target}</strong>, these metric families appear most often:</p>
                  <div className="pill-row" style={{ marginTop: 12 }}>
                    {analysis.standard_metrics.length > 0 ? (
                      analysis.standard_metrics.map((metric: string) => (
                        <span key={metric} className="pill">{metric}</span>
                      ))
                    ) : (
                      <span className="muted">No metric families found for this criteria set.</span>
                    )}
                  </div>
                </section>

                <section className="panel precedent-section">
                  <div className="precedent-header">
                    <div>
                      <h2 className="section-title">Full Precedent List</h2>
                      <p className="muted" style={{ margin: 0 }}>
                        {displayedPrecedents.length} of {analysis.precedents.length} records shown.
                      </p>
                    </div>
                    <a href={planExportHref} className="button" style={{ textDecoration: "none" }} download>
                      Download CSV
                    </a>
                  </div>

                  <form action="/plan" className="precedent-controls">
                    <HiddenPlanInputs params={planParams} />
                    <input
                      type="search"
                      name="precedent_query"
                      defaultValue={precedentQuery}
                      className="search-input"
                      placeholder="Filter precedent table..."
                    />
                    <select name="precedent_sort" defaultValue={precedentSort} className="search-input">
                      <option value="year_desc">Newest First</option>
                      <option value="year_asc">Oldest First</option>
                      <option value="sample_desc">Largest Sample</option>
                      <option value="res_asc">Finest Resolution</option>
                      <option value="public_first">Public Data First</option>
                    </select>
                    <button type="submit" className="button">Update Table</button>
                  </form>

                  <PrecedentTable records={displayedPrecedents} />
                </section>
              </div>

              <aside style={{ display: "grid", gap: 16 }}>
                <section className="panel">
                  <h2 className="section-title">PMID List</h2>
                  {pmids.length > 0 ? (
                    <>
                      <textarea
                        readOnly
                        value={pmids.join(",")}
                        className="search-input"
                        style={{ width: "100%", minHeight: 96, resize: "vertical", fontFamily: "monospace" }}
                      />
                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
                        {pubmedHref ? (
                          <a href={pubmedHref} target="_blank" rel="noopener noreferrer" className="button" style={{ textDecoration: "none" }}>
                            Open PubMed Search
                          </a>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <p className="muted">No PMIDs are available for this precedent set.</p>
                  )}
                </section>

                <section className="panel">
                  <h2 className="section-title">Baseline Data</h2>
                  <p className="muted">These public records may provide reusable baseline data for this target:</p>
                  <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                    {analysis.suggested_baselines.length > 0 ? (
                      analysis.suggested_baselines.map((record: DatasetRecord) => (
                        <Link key={record.dataset_id} href={`/datasets/${record.dataset_id}`} style={{ textDecoration: "none", display: "block", borderBottom: "1px solid var(--border)", paddingBottom: "12px" }}>
                          <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>{record.source_study_id || record.year} · {record.cell_type}</div>
                          <div style={{ fontWeight: 500, fontSize: "0.95rem" }}>{record.title}</div>
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
        </div>
      )}
    </main>
  );
}

function PlanForm({
  facets,
  selectedOrganelles,
  resolvedSearchParams
}: {
  facets: FacetResponse | null;
  selectedOrganelles: string[];
  resolvedSearchParams: Record<string, string | undefined>;
}) {
  return (
    <form action="/plan" style={{ display: "grid", gap: "24px" }}>
      <div>
        <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Target Organelles</label>
        {facets ? (
          <div className="choice-grid">
            {facets.organelles.map((option) => (
              <label key={option.value} className="choice-option">
                <input
                  type="checkbox"
                  name="organelles"
                  value={option.value}
                  defaultChecked={selectedOrganelles.includes(option.value)}
                />
                <span>{option.value}</span>
                <span className="muted">{option.count}</span>
              </label>
            ))}
          </div>
        ) : (
          <input
            type="text"
            name="organelles"
            defaultValue={resolvedSearchParams.organelles ?? ""}
            className="search-input"
            style={{ width: "100%" }}
            placeholder="e.g. nucleus,mitochondria"
          />
        )}
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: 8 }}>
          Multiple targets are treated as a broad precedent sweep: records match if they include at
          least one selected organelle.
        </p>
      </div>

      <div className="plan-criteria-grid">
        <div>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Required Resolution (nm)</label>
          <input type="number" step="any" name="res" defaultValue={resolvedSearchParams.res ?? ""} className="search-input" style={{ width: "100%" }} placeholder="Any" />
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
            Blank means no resolution threshold.
          </p>
        </div>

        <div>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Statistical Scope (Whole-Cell Count)</label>
          <input type="number" name="ss" defaultValue={resolvedSearchParams.ss ?? ""} className="search-input" style={{ width: "100%" }} placeholder="Any" />
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
            Interpreted per study, not pooled across all studies.
          </p>
        </div>
      </div>

      <div className="plan-criteria-grid">
        <div>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Cell Type</label>
          <select name="cell_type" defaultValue={resolvedSearchParams.cell_type ?? ""} className="search-input" style={{ width: "100%" }}>
            <option value="">Any cell type</option>
            {facets?.cell_types.map((option) => (
              <option key={option.value} value={option.value}>{option.value} ({option.count})</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Comparator / Condition</label>
          <select name="comparator_class" defaultValue={resolvedSearchParams.comparator_class ?? ""} className="search-input" style={{ width: "100%" }}>
            <option value="">Any comparator</option>
            {facets?.comparator_classes.map((option) => (
              <option key={option.value} value={option.value}>{option.value} ({option.count})</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Quantified Metric</label>
          <select name="metric" defaultValue={resolvedSearchParams.metric ?? ""} className="search-input" style={{ width: "100%" }}>
            <option value="">Any metric</option>
            {facets?.metric_families.map((option) => (
              <option key={option.value} value={option.value}>{option.value} ({option.count})</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 500 }}>Modality Family</label>
          <select name="family" defaultValue={resolvedSearchParams.family ?? ""} className="search-input" style={{ width: "100%" }}>
            <option value="">Any family</option>
            {modalityFamilies.map((family) => (
              <option key={family} value={family}>{family}</option>
            ))}
          </select>
        </div>
      </div>

      <button type="submit" className="button" style={{ marginTop: 12 }}>Benchmark This Plan</button>
    </form>
  );
}

function HiddenPlanInputs({ params }: { params: Record<string, string | number | null | undefined> }) {
  return (
    <>
      {Object.entries(params).map(([key, value]) => (
        value ? <input key={key} type="hidden" name={key} value={String(value)} /> : null
      ))}
    </>
  );
}

function PrecedentTable({ records }: { records: DatasetRecord[] }) {
  if (records.length === 0) {
    return <p className="muted">No records match the current table filter.</p>;
  }

  return (
    <div className="analytics-table-wrap">
      <table className="analytics-matrix plan-precedent-table">
        <thead>
          <tr>
            <th>Study</th>
            <th>PMID</th>
            <th>Cell Type</th>
            <th>Modality</th>
            <th>Resolution</th>
            <th>Whole-Cell Count</th>
            <th>Metrics</th>
            <th>Public Data</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.dataset_id}>
              <td>
                <Link href={`/datasets/${record.dataset_id}`} style={{ textDecoration: "underline", fontWeight: 500 }}>
                  {record.source_study_id || record.dataset_id}
                </Link>
                <div className="muted" style={{ fontSize: "0.8rem" }}>{record.year} · {record.source}</div>
              </td>
              <td>
                {record.publication_pmid ? (
                  <a
                    href={`https://pubmed.ncbi.nlm.nih.gov/${record.publication_pmid}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ textDecoration: "underline" }}
                  >
                    {record.publication_pmid}
                  </a>
                ) : (
                  <span className="muted">None</span>
                )}
              </td>
              <td>{record.cell_type}</td>
              <td>{record.modality}</td>
              <td>{resolutionLabel(record)}</td>
              <td>{record.sample_size ?? "Unknown"}</td>
              <td>{record.metric_families.slice(0, 4).join(", ") || "None"}</td>
              <td>{record.public_data_status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function splitParam(value?: string) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildQueryString(params: Record<string, string | number | null | undefined>) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.set(key, String(value));
    }
  });

  const qs = searchParams.toString();
  return qs ? `?${qs}` : "";
}

function filterPrecedents(records: DatasetRecord[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return records;

  return records.filter((record) => {
    const haystack = [
      record.dataset_id,
      record.source_study_id || "",
      record.publication_pmid || "",
      record.paper_title,
      record.source,
      record.cell_type,
      record.species,
      record.modality,
      record.comparator_class || "",
      record.comparator_detail || "",
      record.organelles.join(" "),
      record.metric_families.join(" ")
    ].join(" ").toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

function sortPrecedents(records: DatasetRecord[], sortKey: string) {
  const sorted = [...records];
  sorted.sort((left, right) => {
    switch (sortKey) {
      case "year_asc":
        return left.year - right.year || left.dataset_id.localeCompare(right.dataset_id);
      case "sample_desc":
        return (right.sample_size ?? -1) - (left.sample_size ?? -1) || right.year - left.year;
      case "res_asc":
        return (left.lateral_resolution_nm ?? Number.POSITIVE_INFINITY) - (right.lateral_resolution_nm ?? Number.POSITIVE_INFINITY) || right.year - left.year;
      case "public_first":
        return publicRank(right.public_data_status) - publicRank(left.public_data_status) || right.year - left.year;
      case "year_desc":
      default:
        return right.year - left.year || left.dataset_id.localeCompare(right.dataset_id);
    }
  });
  return sorted;
}

function publicRank(status: DatasetRecord["public_data_status"]) {
  if (status === "complete") return 2;
  if (status === "partial") return 1;
  return 0;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function resolutionLabel(record: DatasetRecord) {
  if (record.lateral_resolution_nm === null || record.lateral_resolution_nm === undefined) {
    return "Unknown";
  }

  if (record.axial_resolution_nm === null || record.axial_resolution_nm === undefined) {
    return `${record.lateral_resolution_nm} nm XY`;
  }

  return `${record.lateral_resolution_nm} x ${record.axial_resolution_nm} nm`;
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
