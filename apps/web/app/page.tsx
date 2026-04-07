import Link from "next/link";
import { ApiFailurePanel } from "../components/api-failure-panel";
import { DegradedStatusBanner } from "../components/degraded-status-banner";
import { DatasetCard } from "../components/dataset-card";
import { FacetBar } from "../components/facet-bar";
import { getCompare, getDatasets, pickExampleCompareIds } from "../lib/api";
import { CompareSummary } from "../components/compare-summary";
import { ResultSummary } from "../components/result-summary";
import { normalizeSearchParams, type RouteSearchParams } from "../lib/route-props";
import type { CompareResponse, SearchResponse } from "../lib/types";

export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const resolvedSearchParams = normalizeSearchParams(await searchParams);
  let searchResponse: SearchResponse;

  try {
    searchResponse = await getDatasets(resolvedSearchParams);
  } catch (error) {
    return (
      <main>
        <section className="hero" style={{ marginBottom: 48 }}>
          <h1>Search the Corpus for Cross-Study Commonalities.</h1>
          <p>
            The corpus view is still available, but the backend did not return search results for
            this request.
          </p>
        </section>
        <ApiFailurePanel
          error={error}
          context="corpus search"
          page="home"
          actionHref="/"
          actionLabel="Return to corpus root"
        />
      </main>
    );
  }

  const exampleIds = pickExampleCompareIds(searchResponse);
  let comparePayload: CompareResponse | null = null;
  let compareError: unknown = null;

  if (exampleIds.length >= 2) {
    try {
      comparePayload = await getCompare(exampleIds);
    } catch (error) {
      compareError = error;
    }
  }

  const isTable = resolvedSearchParams.view !== "cards";

  // Helper to keep filters when clicking other facets
  const getFilterUrl = (newParams: Record<string, string | null>, base = "/") => {
    const params = new URLSearchParams();
    // Preserve current filters
    if (resolvedSearchParams.public === "true") params.set("public", "true");
    if (resolvedSearchParams.borderline === "true") params.set("borderline", "true");
    if (resolvedSearchParams.query) params.set("query", resolvedSearchParams.query);
    if (resolvedSearchParams.family) params.set("family", resolvedSearchParams.family);
    if (resolvedSearchParams.organelle) params.set("organelle", resolvedSearchParams.organelle);
    if (resolvedSearchParams.modality) params.set("modality", resolvedSearchParams.modality);
    if (resolvedSearchParams.pair) params.set("pair", resolvedSearchParams.pair);
    if (resolvedSearchParams.view) params.set("view", resolvedSearchParams.view);
    
    // Apply new filters
    Object.entries(newParams).forEach(([key, value]) => {
      if (value === null) params.delete(key);
      else params.set(key, value);
    });
    
    const qs = params.toString();
    return `${base}${qs ? `?${qs}` : ""}`;
  };

  const exportCsvUrl = getFilterUrl({ format: "csv" }, "/api/datasets/export");
  const exportJsonUrl = getFilterUrl({ format: "json" }, "/api/datasets/export");
  const exportBibtexUrl = getFilterUrl({ format: "bibtex" }, "/api/datasets/export");

  return (
    <main>
      <section className="hero" style={{ marginBottom: 48 }}>
        <h1>Search the Corpus for Cross-Study Commonalities.</h1>
      </section>

      {compareError ? (
        <DegradedStatusBanner
          page="home"
          title="Search View Degraded"
          issues={[
            {
              label: "Compare preview",
              context: "the example comparison panel",
              error: compareError
            }
          ]}
        />
      ) : null}

      <section className="panel-grid two" style={{ marginBottom: 20 }}>
        <section className="panel">
          <h2 className="section-title">Workflow</h2>
          <div className="pill-row">
            {["search", "match", "compare", "cite"].map((item) => (
              <span key={item} className="pill">
                {item}
              </span>
            ))}
          </div>
          <p className="muted">
            The result page should tell a researcher what relevant evidence exists, what
            commonalities recur, and which datasets are strong candidates for comparison.
          </p>
        </section>

        <FacetBar
          title="Commonality snapshot"
          items={[
            { 
              label: `datasets: ${searchResponse.total}`, 
              href: getFilterUrl({ organelle: null, modality: null, family: null, pair: null, query: null }) 
            },
            ...searchResponse.commonalities.top_organelles.slice(0, 2).map((o) => ({
              label: `organelle: ${o}`,
              href: getFilterUrl({ organelle: o })
            })),
            ...searchResponse.commonalities.top_modalities.slice(0, 2).map((m) => ({
              label: `modality: ${m}`,
              href: getFilterUrl({ family: m })
            }))
          ]}
        />
      </section>

      <section className="panel" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: "12px" }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            {searchResponse.total} {searchResponse.total === 1 ? "result" : "results"}
            {resolvedSearchParams.query && ` for "${resolvedSearchParams.query}"`}
            {resolvedSearchParams.organelle && ` filtered by organelle: ${resolvedSearchParams.organelle}`}
            {resolvedSearchParams.modality && ` filtered by modality: ${resolvedSearchParams.modality}`}
            {resolvedSearchParams.family && ` filtered by family: ${resolvedSearchParams.family}`}
            {resolvedSearchParams.pair && ` filtered by pair: ${resolvedSearchParams.pair}`}
            {resolvedSearchParams.public === "true" && " (Public Data Only)"}
            {resolvedSearchParams.borderline === "true" && " (Including Borderline)"}
          </h2>
          
          <div style={{ marginLeft: "auto", display: "flex", gap: "16px", alignItems: "baseline" }}>
            <div style={{ display: "flex", gap: "8px", marginRight: "16px" }}>
              <Link href={getFilterUrl({ view: "cards" })} className={`pill ${!isTable ? "selected" : ""}`} style={{ fontSize: "0.8rem", padding: "2px 8px" }}>Cards</Link>
              <Link href={getFilterUrl({ view: "table" })} className={`pill ${isTable ? "selected" : ""}`} style={{ fontSize: "0.8rem", padding: "2px 8px" }}>Table</Link>
            </div>

            <span className="muted" style={{ fontSize: "0.9rem" }}>Export:</span>
            <a href={exportCsvUrl} className="muted" style={{ fontSize: "0.9rem", textDecoration: "underline" }} download>CSV</a>
            <a href={exportJsonUrl} className="muted" style={{ fontSize: "0.9rem", textDecoration: "underline" }} download>JSON</a>
            <a href={exportBibtexUrl} className="muted" style={{ fontSize: "0.9rem", textDecoration: "underline" }} download>BibTeX</a>
            
            {Object.keys(resolvedSearchParams).length > 0 && (
              <Link
                href="/"
                className="muted"
                style={{ fontSize: "0.9rem", textDecoration: "underline", marginLeft: "8px" }}
              >
                Clear all
              </Link>
            )}
          </div>
        </div>

        <ResultSummary response={searchResponse} searchParams={resolvedSearchParams} />

        {isTable ? (
          <div style={{ overflowX: "auto" }}>
            <table className="compare-matrix" style={{ background: "var(--background)" }}>
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Cell Type</th>
                  <th>Modality</th>
                  <th>Res (nm)</th>
                  <th>Sample</th>
                  <th>Public</th>
                </tr>
              </thead>
              <tbody>
                {searchResponse.results.map((d) => (
                  <tr key={d.dataset_id}>
                    <td>
                      <Link href={`/datasets/${d.dataset_id}`} style={{ fontWeight: 500, textDecoration: "underline" }}>{d.title}</Link>
                      <div className="muted" style={{ fontSize: "0.8rem" }}>{d.source}, {d.year}</div>
                    </td>
                    <td>{d.cell_type}</td>
                    <td>{d.modality}</td>
                    <td>{d.lateral_resolution_nm} x {d.axial_resolution_nm}</td>
                    <td>{d.sample_size}</td>
                    <td>{d.public_data_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dataset-grid">
            {searchResponse.results.map((dataset) => (
              <DatasetCard key={dataset.dataset_id} dataset={dataset} />
            ))}
          </div>
        )}
      </section>

      {comparePayload ? (
        <CompareSummary payload={comparePayload} />
      ) : compareError ? (
        <section style={{ marginTop: 24 }}>
          <ApiFailurePanel
            error={compareError}
            context="the example comparison panel"
            page="home"
            title="Compare preview unavailable"
            compact
          />
        </section>
      ) : null}
    </main>
  );
}
