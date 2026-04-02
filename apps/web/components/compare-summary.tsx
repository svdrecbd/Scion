import Link from "next/link";
import type { CompareResponse } from "../lib/types";

type Props = {
  payload: CompareResponse;
};

export function CompareSummary({ payload }: Props) {
  return (
    <section className="panel compare-card">
      <div className="kicker">Compare mode preview</div>
      <h3>Example compare summary</h3>
      <p className="muted">{payload.summary}</p>

      <div className="summary-grid">
        <div>
          <h4 className="section-title">Shared fields</h4>
          <div className="key-value-list">
            {Object.entries(payload.shared_fields).map(([key, values]) => (
              <span key={key} className="pill">
                {key}: {values.length ? values.join(", ") : "none"}
              </span>
            ))}
          </div>
        </div>

        <div>
          <h4 className="section-title">Key differences</h4>
          <div className="key-value-list">
            {Object.entries(payload.key_differences).map(([key, values]) => (
              <span key={key} className="pill">
                {key}: {values.join(", ")}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <strong>Comparability score:</strong>
          <span style={{ marginLeft: 8 }}>{payload.comparability_score} / 100</span>
        </div>
        <Link href="/guide" className="muted" style={{ fontSize: "0.75rem", textDecoration: "underline" }}>
          How is this calculated?
        </Link>
      </div>
    </section>
  );
}
