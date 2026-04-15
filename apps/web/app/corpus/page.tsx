import Link from "next/link";
import { ApiFailurePanel } from "../../components/api-failure-panel";
import { DegradedStatusBanner } from "../../components/degraded-status-banner";
import { CompareToggle } from "../../components/compare-toggle";
import { DatasetCard } from "../../components/dataset-card";
import { FacetBar } from "../../components/facet-bar";
import { getCompare, getDatasets, pickExampleCompareIds } from "../../lib/api";
import { CompareSummary } from "../../components/compare-summary";
import { ResultSummary } from "../../components/result-summary";
import { normalizeSearchParams, type RouteSearchParams } from "../../lib/route-props";
import type { CompareResponse, SearchResponse } from "../../lib/types";

export default async function CorpusPage({
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
          <div className="kicker">Corpus</div>
          <h1>Search the Whole-Cell Imaging Corpus.</h1>
          <p>
            The corpus view could not load this request right now, but the rest of the platform is
            still available.
          </p>
        </section>
        <ApiFailurePanel
          error={error}
          context="corpus search"
          page="corpus"
          actionHref="/corpus"
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

  const getFilterUrl = (
    newParams: Record<string, string | null>,
    base = "/corpus"
  ) => {
    const params = new URLSearchParams();
    if (resolvedSearchParams.public === "true") params.set("public", "true");
    if (resolvedSearchParams.borderline === "true") params.set("borderline", "true");
    if (resolvedSearchParams.query) params.set("query", resolvedSearchParams.query);
    if (resolvedSearchParams.family) params.set("family", resolvedSearchParams.family);
    if (resolvedSearchParams.organelle) params.set("organelle", resolvedSearchParams.organelle);
    if (resolvedSearchParams.modality) params.set("modality", resolvedSearchParams.modality);
    if (resolvedSearchParams.pair) params.set("pair", resolvedSearchParams.pair);
    if (resolvedSearchParams.view) params.set("view", resolvedSearchParams.view);

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
        <div className="kicker">Corpus</div>
        <h1>Search the Whole-Cell Imaging Corpus.</h1>
        <p>
          Filter the atlas, inspect records quickly in table view, switch to cards when you want
          more context, and build a compare set from either view.
        </p>
      </section>

      {compareError ? (
        <DegradedStatusBanner
          page="corpus"
          title="Corpus View Degraded"
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
          <h2 className="section-title">Use This Page</h2>
          <div className="pill-row">
            {["scan", "filter", "open records", "compare"].map((item) => (
              <span key={item} className="pill">
                {item}
              </span>
            ))}
          </div>
          <p className="muted">
            Table view is best for scanning fast. Cards give more context. Compare selection now
            works in both views, and the drawer follows you until you clear it or open Compare.
          </p>
        </section>

        <FacetBar
          title="Most Common Traits in This Slice"
          items={[
            {
              label: `datasets: ${searchResponse.total}`,
              href: getFilterUrl({
                organelle: null,
                modality: null,
                family: null,
                pair: null,
                query: null
              })
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 12,
            flexWrap: "wrap",
            gap: "12px"
          }}
        >
          <h2 className="section-title" style={{ margin: 0 }}>
            {searchResponse.total} {searchResponse.total === 1 ? "result" : "results"}
            {resolvedSearchParams.query && ` for "${resolvedSearchParams.query}"`}
            {resolvedSearchParams.organelle &&
              ` filtered by organelle: ${resolvedSearchParams.organelle}`}
            {resolvedSearchParams.modality &&
              ` filtered by modality: ${resolvedSearchParams.modality}`}
            {resolvedSearchParams.family &&
              ` filtered by family: ${resolvedSearchParams.family}`}
            {resolvedSearchParams.pair && ` filtered by pair: ${resolvedSearchParams.pair}`}
            {resolvedSearchParams.public === "true" && " (Public data only)"}
            {resolvedSearchParams.borderline === "true" && " (Including borderline)"}
          </h2>

          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: "16px",
              alignItems: "baseline"
            }}
          >
            <div style={{ display: "flex", gap: "8px", marginRight: "16px" }}>
              <Link
                href={getFilterUrl({ view: "cards" })}
                className={`pill ${!isTable ? "selected" : ""}`}
                style={{ fontSize: "0.8rem", padding: "2px 8px" }}
              >
                Cards
              </Link>
              <Link
                href={getFilterUrl({ view: "table" })}
                className={`pill ${isTable ? "selected" : ""}`}
                style={{ fontSize: "0.8rem", padding: "2px 8px" }}
              >
                Table
              </Link>
            </div>

            <span className="muted" style={{ fontSize: "0.9rem" }}>
              Export:
            </span>
            <a
              href={exportCsvUrl}
              className="muted"
              style={{ fontSize: "0.9rem", textDecoration: "underline" }}
              download
            >
              CSV
            </a>
            <a
              href={exportJsonUrl}
              className="muted"
              style={{ fontSize: "0.9rem", textDecoration: "underline" }}
              download
            >
              JSON
            </a>
            <a
              href={exportBibtexUrl}
              className="muted"
              style={{ fontSize: "0.9rem", textDecoration: "underline" }}
              download
            >
              BibTeX
            </a>

            {Object.keys(resolvedSearchParams).length > 0 && (
              <Link
                href="/corpus"
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
                  <th>Compare</th>
                  <th>Dataset</th>
                  <th>Cell Type</th>
                  <th>Modality</th>
                  <th>Resolution (XY/Z)</th>
                  <th>Sample</th>
                  <th>Public data</th>
                </tr>
              </thead>
              <tbody>
                {searchResponse.results.map((d) => (
                  <tr key={d.dataset_id}>
                    <td>
                      <CompareToggle id={d.dataset_id} compact />
                    </td>
                    <td>
                      <Link
                        href={`/datasets/${d.dataset_id}`}
                        style={{ fontWeight: 500, textDecoration: "underline" }}
                      >
                        {d.title}
                      </Link>
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {d.source}, {d.year}
                      </div>
                    </td>
                    <td>{d.cell_type}</td>
                    <td>{d.modality}</td>
                    <td>
                      {d.lateral_resolution_nm} x {d.axial_resolution_nm}
                    </td>
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
            page="corpus"
            title="Compare preview unavailable"
            compact
          />
        </section>
      ) : null}
    </main>
  );
}
