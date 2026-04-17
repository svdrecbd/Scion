import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiFailurePanel } from "../../../components/api-failure-panel";
import { DegradedStatusBanner } from "../../../components/degraded-status-banner";
import { getDataset, getSimilarDatasets } from "../../../lib/api";
import { isNotFoundApiError } from "../../../lib/api-errors";
import type { DatasetRecord } from "../../../lib/types";
import { FacetBar } from "../../../components/facet-bar";
import { CitationButton } from "../../../components/citation-button";

function firstAuthorLabel(datasetId: string) {
  const slug = datasetId.split("-")[0] || datasetId;
  return slug
    .split(/[_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function citationLabel(dataset: DatasetRecord) {
  return dataset.source_study_id || `${firstAuthorLabel(dataset.dataset_id)} ${dataset.year}`;
}

export default async function DatasetPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let dataset: DatasetRecord;

  try {
    dataset = await getDataset(id);
  } catch (error) {
    if (isNotFoundApiError(error)) {
      notFound();
    }

    return (
      <main>
        <div style={{ marginBottom: 24 }}>
          <Link href="/corpus" className="muted" style={{ textDecoration: "underline" }}>
            ← Back to corpus
          </Link>
        </div>
        <section className="hero">
          <h1>Dataset detail unavailable.</h1>
          <p>
            The dataset record could not be loaded right now, so the page is showing a degraded state.
          </p>
        </section>
        <ApiFailurePanel
          error={error}
          context={`dataset ${id}`}
          page="dataset-detail"
          actionHref="/corpus"
          actionLabel="Return to corpus"
        />
      </main>
    );
  }

  let similar: DatasetRecord[] = [];
  let similarError: unknown = null;

  try {
    similar = await getSimilarDatasets(id);
  } catch (error) {
    similarError = error;
  }

  return (
    <main>
      <div style={{ marginBottom: 24 }}>
        <Link href="/corpus" className="muted" style={{ textDecoration: "underline" }}>
          ← Back to corpus
        </Link>
      </div>

      <section className="hero">
        <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: 8 }}>
          <div className="kicker" style={{ margin: 0 }}>{dataset.cell_type} · {dataset.species}</div>
          {dataset.included_status === "borderline" && (
            <span className="pill badge-borderline">Borderline Study</span>
          )}
        </div>
        <h1>{dataset.title}</h1>
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <p className="muted" style={{ margin: 0 }}>
            <strong>{citationLabel(dataset)}</strong> · {dataset.source}
          </p>
          <div style={{ display: "flex", gap: "8px" }}>
            <Link
              href={`/corpus?cell_type=${encodeURIComponent(dataset.cell_type)}`}
              className="pill pill-link"
              style={{ fontSize: "0.8rem", textDecoration: "none" }}
            >
              Find datasets with same cell type
            </Link>
            <CitationButton dataset={dataset} />
          </div>
        </div>
      </section>

      {similarError ? (
        <DegradedStatusBanner
          page="dataset-detail"
          title="Dataset Detail Degraded"
          issues={[
            {
              label: "Similar datasets",
              context: "similar dataset recommendations",
              error: similarError
            }
          ]}
        />
      ) : null}

      <div className="panel-grid two" style={{ marginTop: 32 }}>
        <div className="summary-grid">
          {dataset.notes && (
            <section className="panel" style={{ borderLeft: "4px solid var(--foreground)" }}>
              <h2 className="section-title">Curation Notes</h2>
              <p style={{ fontSize: "1.1rem", lineHeight: 1.6 }}>{dataset.notes}</p>
              {dataset.included_status === "borderline" && (
                <p className="muted" style={{ fontSize: "0.9rem", marginTop: 12 }}>
                  * This study is categorized as <strong>Borderline</strong> because it met some but not all of the 
                  strict inclusion criteria for the primary corpus (e.g., partial volume or unclear resolution reporting).
                </p>
              )}
            </section>
          )}

          <section className="panel">
            <h2 className="section-title">Technical Specs</h2>
            <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
              <div>
                <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>Modality</div>
                <div style={{ fontSize: "1.1rem" }}>{dataset.modality}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>Resolution</div>
                <div style={{ fontSize: "1.1rem" }}>
                  {dataset.lateral_resolution_nm}nm x {dataset.axial_resolution_nm}nm
                  {dataset.isotropic ? " (Isotropic)" : ""}
                </div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>Sample Size</div>
                <div style={{ fontSize: "1.1rem" }}>{dataset.sample_size ?? "Unknown"}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>Whole-Cell Boundary</div>
                <div style={{ fontSize: "1.1rem" }}>{dataset.whole_cell_boundary_confirmed}</div>
              </div>
            </div>
          </section>

          {(dataset.comparator_class || dataset.comparator_detail) && (
            <section className="panel">
              <h2 className="section-title">Comparators / Conditions</h2>
              <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                {dataset.comparator_class && (
                  <div>
                    <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>Comparator Class</div>
                    <div style={{ fontSize: "1.1rem" }}>{dataset.comparator_class}</div>
                  </div>
                )}
                {dataset.comparator_detail && (
                  <div>
                    <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>Comparator Detail</div>
                    <div style={{ fontSize: "1.1rem" }}>{dataset.comparator_detail}</div>
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="panel">
            <h2 className="section-title">Provenance</h2>
            <p className="muted" style={{ marginBottom: 16 }}>
              This record was ingested from the <em>Cell Anatomy Scoping Review</em> corpus.
            </p>
            <div className="stat-row">
              {dataset.publication_pmid && (
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${dataset.publication_pmid}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pill pill-link"
                >
                  PMID {dataset.publication_pmid}
                </a>
              )}
              {dataset.source_publication_url && (
                <a
                  href={dataset.source_publication_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="button"
                  style={{ textDecoration: "none", textAlign: "center" }}
                >
                  View Publication
                </a>
              )}
              {dataset.public_data_status !== "none" && (
                <div className="pill" style={{ background: "var(--foreground)", color: "var(--background)", borderColor: "var(--foreground)" }}>
                  Public Data Available ({dataset.public_data_status})
                </div>
              )}
            </div>
            {(dataset.public_locator_urls?.length ?? 0) > 0 && (
              <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                <div className="kicker" style={{ margin: 0 }}>Public Data Links</div>
                {dataset.public_locator_urls?.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="muted"
                    style={{ textDecoration: "underline", wordBreak: "break-word" }}
                  >
                    {url}
                  </a>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside style={{ display: "grid", gap: 16 }}>
          {similar.length > 0 && (
            <section className="panel">
              <h2 className="section-title">Similar Records</h2>
              <p className="muted" style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
                These recommendations are based on shared metadata and biological overlap signals, not a claim of direct equivalence.
              </p>
              <div style={{ display: "grid", gap: "12px" }}>
                {similar.map((s) => (
                  <Link key={s.dataset_id} href={`/datasets/${s.dataset_id}`} style={{ textDecoration: "none", display: "block", borderBottom: "1px solid var(--border)", paddingBottom: "8px" }}>
                    <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>{s.cell_type}</div>
                    <div style={{ fontWeight: 500 }}>{s.title}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {similarError ? (
            <ApiFailurePanel
              error={similarError}
              context="similar dataset recommendations"
              page="dataset-detail"
              title="Similar-dataset panel unavailable"
              compact
            />
          ) : null}

          <FacetBar
            title="Organelles Captured"
            items={dataset.organelles}
          />
          <FacetBar
            title="Metric Families"
            items={dataset.metric_families}
          />
          {dataset.organelle_pairs.length > 0 && (
            <>
              <FacetBar
                title="Captured Organelle Pairs"
                items={dataset.organelle_pairs.map((p) => ({
                  label: p,
                  href: `/corpus?pair=${encodeURIComponent(p)}`
                }))}
              />
              <p className="muted" style={{ margin: "-4px 0 0", fontSize: "0.85rem", lineHeight: 1.5 }}>
                These pairs are derived from the organelles listed for this record. They should not
                be read as proof that the study explicitly quantified contact sites.
              </p>
            </>
          )}
          <section className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 className="section-title">Metadata Completeness</h2>
              <Link href="/guide" className="muted" style={{ fontSize: "0.75rem", textDecoration: "underline" }}>How It&apos;s Derived</Link>
            </div>
            <div style={{ fontSize: "2.5rem", fontWeight: 300 }}>
              {Math.round(dataset.metadata_completeness_score * 100)}%
            </div>
            <p className="muted" style={{ fontSize: "0.9rem", marginTop: 8 }}>
              Completeness score based on standardized reporting of modality, resolution, and curation status.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
