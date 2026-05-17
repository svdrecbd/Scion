"use client";

import React, { useState } from "react";
import { studyCitationLabel } from "../lib/display";
import type { DatasetRecord } from "../lib/types";

export function CitationButton({ dataset }: { dataset: DatasetRecord }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const pmid = dataset.publication_pmid ? ` PMID: ${dataset.publication_pmid}.` : "";
    const publicationUrl = dataset.source_publication_url ? ` ${dataset.source_publication_url}` : "";
    const citation = `${studyCitationLabel(dataset)}. "${dataset.paper_title}."${pmid} Indexed in the Cell Anatomy Corpus.${publicationUrl}`;
    navigator.clipboard.writeText(citation);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="pill pill-link"
      style={{ 
        fontSize: "0.8rem", 
        fontFamily: "inherit",
        background: copied ? "var(--foreground)" : "var(--accent)",
        color: copied ? "var(--background)" : "var(--foreground)",
        border: "1px solid var(--border)",
        cursor: "pointer",
        transition: "all 0.2s"
      }}
    >
      {copied ? "Copied!" : "Copy Citation"}
    </button>
  );
}
