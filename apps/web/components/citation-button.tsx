"use client";

import React, { useState } from "react";
import type { DatasetRecord } from "../lib/types";

export function CitationButton({ dataset }: { dataset: DatasetRecord }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const studyLabel = dataset.source_study_id ? `${dataset.source_study_id}. ` : "";
    const pmid = dataset.publication_pmid ? ` PMID: ${dataset.publication_pmid}.` : "";
    const citation = `${studyLabel}"${dataset.paper_title}." ${dataset.source}. ${dataset.year}.${pmid} Indexed in Scion.`;
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
