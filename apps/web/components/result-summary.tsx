import React from "react";
import type { SearchResponse } from "../lib/types";

type Props = {
  response: SearchResponse;
  searchParams: Record<string, string | undefined>;
};

export function ResultSummary({ response, searchParams }: Props) {
  if (response.total === 0) return null;

  const { commonalities } = response;
  const topModality = commonalities.top_modalities[0];
  const topOrganelle = commonalities.top_organelles[0];
  const topMetric = commonalities.top_metric_families[0];

  const hasFilters = Object.keys(searchParams).length > 0;

  return (
    <div className="result-summary-box" style={{ marginBottom: 24, padding: "16px", background: "var(--accent)", borderRadius: 0, border: "1px solid var(--border)" }}>
      <p style={{ margin: 0, lineHeight: 1.6, fontSize: "1.05rem" }}>
        {hasFilters ? "In this slice of the corpus, " : "Across the current corpus, "}
        <strong>{topModality}</strong> is the most common imaging family
        {topOrganelle ? (
          <>
            {" "}and <strong>{topOrganelle}</strong> is the organelle that appears most often
          </>
        ) : null}
        {topMetric ? <> with <strong>{topMetric}</strong> as the most common metric family.</> : "."}
        {commonalities.top_organelle_pairs.length > 0 && (
          <>
            {" "}The most common targeted contact is <strong>{commonalities.top_organelle_pairs[0]}</strong>.
          </>
        )}
      </p>
    </div>
  );
}
