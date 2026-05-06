import Link from "next/link";
import type { CompareResponse } from "../lib/types";

type Props = {
  payload: CompareResponse;
};

const fieldLabels: Record<string, string> = {
  cell_types: "Cell Type",
  species: "Species",
  organelles: "Organelles",
  organelle_pairs: "Organelle Pairs",
  metric_families: "Metric Families",
  comparator_classes: "Comparator / Condition",
  modality_families: "Modality Family",
  modalities: "Modality",
  sample_size_buckets: "Sample Size Band",
  public_data_statuses: "Public Data Status",
  boundary_confirmation: "Boundary Confirmation"
};

export function CompareSummary({ payload }: Props) {
  return (
    <section className="panel compare-card">
      <div className="kicker">Compare Mode Preview</div>
      <h3>Comparison Summary</h3>
      <p className="muted">{payload.summary}</p>

      <div className="summary-grid">
        <div>
          <h4 className="section-title">Shared Fields</h4>
          <div className="key-value-list">
            {Object.entries(payload.shared_fields).map(([key, values]) => (
              <span key={key} className="pill">
                {fieldLabels[key] ?? key}: {values.length ? values.join(", ") : "none"}
              </span>
            ))}
          </div>
        </div>

        <div>
          <h4 className="section-title">Key Differences</h4>
          <div className="key-value-list">
            {Object.entries(payload.key_differences).map(([key, values]) => (
              <span key={key} className="pill">
                {fieldLabels[key] ?? key}: {values.join(", ")}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <strong>Comparability Score:</strong>
          <span style={{ marginLeft: 8 }}>{payload.comparability_score} / 100</span>
        </div>
        <Link href="/guide" className="muted" style={{ fontSize: "0.75rem", textDecoration: "underline" }}>
          How It&apos;s Derived
        </Link>
      </div>
    </section>
  );
}
