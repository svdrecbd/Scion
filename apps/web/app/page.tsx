import Link from "next/link";
import { DatasetCard } from "../components/dataset-card";
import { FacetBar } from "../components/facet-bar";
import { getCompare, getDatasets, pickExampleCompareIds } from "../lib/api";
import { CompareSummary } from "../components/compare-summary";
import { ResultSummary } from "../components/result-summary";

export default async function HomePage({
  searchParams
}: {
  searchParams: { [key: string]: string | undefined };
}) {
  const searchResponse = await getDatasets(searchParams);
  const exampleIds = pickExampleCompareIds(searchResponse);
  const comparePayload = exampleIds.length >= 2 ? await getCompare(exampleIds) : null;
  const isTable = searchParams.view === "table";

  // Helper to keep filters when clicking other facets
  const getFilterUrl = (newParams: Record<string, string | null>, base = "/") => {
    const params = new URLSearchParams();
    // Preserve current filters
    if (searchParams.public === "true") params.set("public", "true");
    if (searchParams.borderline === "true") params.set("borderline", "true");
    if (searchParams.query) params.set("query", searchParams.query);
    if (searchParams.family) params.set("family", searchParams.family);
    if (searchParams.organelle) params.set("organelle", searchParams.organelle);
    if (searchParams.modality) params.set("modality", searchParams.modality);
    if (searchParams.pair) params.set("pair", searchParams.pair);
    if (searchParams.view) params.set("view", searchParams.view);
    
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
            {searchParams.query && ` for "${searchParams.query}"`}
            {searchParams.organelle && ` filtered by organelle: ${searchParams.organelle}`}
            {searchParams.modality && ` filtered by modality: ${searchParams.modality}`}
            {searchParams.family && ` filtered by family: ${searchParams.family}`}
            {searchParams.pair && ` filtered by pair: ${searchParams.pair}`}
            {searchParams.public === "true" && " (Public Data Only)"}
            {searchParams.borderline === "true" && " (Including Borderline)"}
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
            
            {Object.keys(searchParams).length > 0 && (
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

        <ResultSummary response={searchResponse} searchParams={searchParams} />

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

      {comparePayload && <CompareSummary payload={comparePayload} />}
    </main>
  );
}
