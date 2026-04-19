"use client";

import Link from "next/link";
import type { DatasetRecord } from "../lib/types";
import { publicationHref, publicDataHref, publicDataLabel, studyCitationLabel } from "../lib/display";
import { CompareToggle } from "./compare-toggle";

type Props = {
  dataset: DatasetRecord;
};

export function DatasetCard({ dataset }: Props) {
  const hasResolution = dataset.lateral_resolution_nm && dataset.axial_resolution_nm;
  const hasSampleSize = dataset.sample_size && dataset.sample_size > 0;
  const isPublic = dataset.public_data_status !== "none";
  const paperHref = publicationHref(dataset);
  const dataHref = publicDataHref(dataset);

  return (
    <article className="panel dataset-card" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div className="kicker" style={{ margin: 0 }}>{dataset.cell_type}</div>
        <CompareToggle id={dataset.dataset_id} />
      </div>
      
      <Link href={`/datasets/${dataset.dataset_id}`} className="dataset-card-link" style={{ flex: 1 }}>
        <h3>{dataset.title}</h3>
        <p className="muted" style={{ marginBottom: 16 }}>
          {studyCitationLabel(dataset)} · {dataset.modality}
        </p>

        <div className="panel-grid" style={{ gap: 12, marginBottom: 16 }}>
          <div className="pill-row">
            {dataset.included_status === "borderline" && (
              <span className="pill badge-borderline" title="Study met some but not all inclusion criteria">Borderline</span>
            )}
            {hasResolution && <span className="pill badge-verify" title="Resolution reported">Res</span>}
            {hasSampleSize && <span className="pill badge-verify" title="Sample size reported">SS</span>}
            {dataset.whole_cell_boundary_confirmed === "yes" && (
              <span className="pill badge-verify" title="Whole-cell boundary confirmed">Boundary</span>
            )}
            {isPublic && (
              <span className="pill badge-public" title={publicDataLabel(dataset)}>
                Data: {publicDataLabel(dataset).replace("Data Publicly Available: ", "")}
              </span>
            )}
          </div>
          
          <div className="dataset-card-organelles">
            <div className="dataset-card-organelles-title">Key Organelles</div>
            <div className="pill-row">
              {dataset.organelles.slice(0, 3).map((organelle) => (
                <span key={organelle} className="pill organelle-pill">
                  {organelle}
                </span>
              ))}
            </div>
          </div>
        </div>
        {dataset.notes ? (
          <p className="muted" style={{ margin: "0 0 16px", lineHeight: 1.5 }}>
            <strong>Curation note:</strong> {dataset.notes}
          </p>
        ) : null}
      </Link>

      <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="stat-row" style={{ margin: 0, fontSize: "0.85rem" }}>
          <span>Metadata: {Math.round(dataset.metadata_completeness_score * 100)}%</span>
        </div>
        
        <div style={{ display: "flex", gap: "8px" }}>
          <Link href={`/datasets/${dataset.dataset_id}`} className="muted" style={{ fontSize: "0.85rem", textDecoration: "underline" }}>
            Details
          </Link>
          {paperHref && (
            <a 
              href={paperHref}
              target="_blank" 
              rel="noopener noreferrer"
              className="muted"
              style={{ fontSize: "0.85rem", textDecoration: "underline", color: "var(--foreground)" }}
              onClick={(e) => e.stopPropagation()}
            >
              Paper →
            </a>
          )}
          {dataHref && (
            <a
              href={dataHref}
              target="_blank"
              rel="noopener noreferrer"
              className="muted"
              style={{ fontSize: "0.85rem", textDecoration: "underline", color: "var(--foreground)" }}
              onClick={(e) => e.stopPropagation()}
            >
              Data →
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
