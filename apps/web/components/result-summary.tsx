import React from "react";
import Link from "next/link";
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
  const buildCorpusHref = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    Object.entries(extra).forEach(([key, value]) => {
      params.set(key, value);
    });
    return `/corpus?${params.toString()}`;
  };

  const inlineLinkStyle = {
    color: "inherit",
    fontWeight: 700,
    textDecoration: "underline"
  };

  return (
    <div className="result-summary-box" style={{ marginBottom: 24, padding: "16px", background: "var(--accent)", borderRadius: 0, border: "1px solid var(--border)" }}>
      <p style={{ margin: 0, lineHeight: 1.6, fontSize: "1.05rem" }}>
        {hasFilters ? "In this slice of the corpus, " : "Across the current corpus, "}
        <strong>{response.total}</strong> dataset {response.total === 1 ? "record matches" : "records match"}.{" "}
        {topModality ? (
          <Link href={buildCorpusHref({ family: topModality })} style={inlineLinkStyle}>
            {topModality}
          </Link>
        ) : null}{" "}
        is the most common imaging family
        {topOrganelle ? (
          <>
            {" "}and{" "}
            <Link href={buildCorpusHref({ organelle: topOrganelle })} style={inlineLinkStyle}>
              {topOrganelle}
            </Link>{" "}
            is the organelle that appears most often
          </>
        ) : null}
        {topMetric ? (
          <>
            {" "}with{" "}
            <Link href={buildCorpusHref({ metric: topMetric })} style={inlineLinkStyle}>
              {topMetric}
            </Link>{" "}
            as the most common metric family.
          </>
        ) : "."}
        {commonalities.top_organelle_pairs.length > 0 && (
          <>
            {" "}The most common captured organelle pair is{" "}
            <Link href={buildCorpusHref({ pair: commonalities.top_organelle_pairs[0] })} style={inlineLinkStyle}>
              {commonalities.top_organelle_pairs[0]}
            </Link>.
          </>
        )}
      </p>
    </div>
  );
}
