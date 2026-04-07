import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiFailurePanel } from "../../../components/api-failure-panel";
import { DegradedStatusBanner } from "../../../components/degraded-status-banner";
import { getDataset, getSimilarDatasets } from "../../../lib/api";
import { isNotFoundApiError } from "../../../lib/api-errors";
import type { DatasetRecord } from "../../../lib/types";
import { FacetBar } from "../../../components/facet-bar";
import { CitationButton } from "../../../components/citation-button";

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
          <Link href="/" className="muted" style={{ textDecoration: "underline" }}>
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
          actionHref="/"
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
        <Link href="/" className="muted" style={{ textDecoration: "underline" }}>
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
            Published in <strong>{dataset.paper_title}</strong> ({dataset.year})
          </p>
          <div style={{ display: "flex", gap: "8px" }}>
            <Link
              href={`/?cell_type=${encodeURIComponent(dataset.cell_type)}`}
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
                <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>Boundary Confirmed</div>
                <div style={{ fontSize: "1.1rem" }}>{dataset.whole_cell_boundary_confirmed}</div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2 className="section-title">Provenance</h2>
            <p className="muted" style={{ marginBottom: 16 }}>
              This record was ingested from the <em>Cell Anatomy Scoping Review</em> corpus.
            </p>
            <div className="stat-row">
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
          </section>
        </div>

        <aside style={{ display: "grid", gap: 16 }}>
          {similar.length > 0 && (
            <section className="panel">
              <h2 className="section-title">Most Comparable Datasets</h2>
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
            <FacetBar
              title="Targeted Contacts"
              items={dataset.organelle_pairs.map((p) => ({
                label: p,
                href: `/?pair=${encodeURIComponent(p)}`
              }))}
            />
          )}
          <section className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 className="section-title">Metadata Quality</h2>
              <Link href="/guide" className="muted" style={{ fontSize: "0.75rem", textDecoration: "underline" }}>How is this calculated?</Link>
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
