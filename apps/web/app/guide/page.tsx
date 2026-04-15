import React from "react";
import Link from "next/link";

const badges = [
  {
    label: "Res",
    className: "pill badge-verify",
    copy: "Resolution is explicitly reported."
  },
  {
    label: "SS",
    className: "pill badge-verify",
    copy: "Sample size is explicitly reported."
  },
  {
    label: "Boundary",
    className: "pill badge-verify",
    copy: "Whole-cell boundary confirmation is present."
  },
  {
    label: "Data",
    className: "pill badge-public",
    copy: "Reusable public data is known to exist."
  },
  {
    label: "Borderline",
    className: "pill badge-borderline",
    copy: "Useful near-miss record; keep it in context, but verify more carefully."
  }
];

export default function GuidePage() {
  return (
    <main>
      <section className="hero">
        <div className="kicker">Guide</div>
        <h1>How to Interpret Scion</h1>
        <p>
          Use this page when you need the meaning of a score, badge, or status label. For general
          orientation, start from the landing page. For project context and source links, use
          About.
        </p>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Comparability Score</h2>
          <p className="muted" style={{ margin: "0 0 14px", lineHeight: 1.7 }}>
            This is a ranking aid for likely overlap, not a claim that two studies are equivalent.
            It rewards shared biology and shared technical structure, then compresses that into a
            quick reading. A high score means “look here first,” not “pool these records without
            caveats.”
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            <div className="muted" style={{ fontSize: "0.95rem" }}>
              Current heuristic:
            </div>
            <div className="muted" style={{ display: "grid", gap: 6, lineHeight: 1.6 }}>
              <div><strong>+25</strong> if all selected datasets share the same cell type</div>
              <div><strong>+10</strong> if all selected datasets share the same species</div>
              <div><strong>+5 each</strong> for shared organelle pairs, capped at <strong>+20</strong></div>
              <div><strong>+3 each</strong> for shared metric families, capped at <strong>+15</strong></div>
              <div><strong>+10</strong> if all selected datasets share the same modality family</div>
              <div><strong>+10</strong> if they share a comparator class</div>
              <div><strong>+10</strong> if every selected record has metadata completeness of at least 0.8</div>
              <div>The total is capped at <strong>100</strong>.</div>
              <div>
                Current reading bands: <strong>75+</strong> high overlap, <strong>50-74</strong>
                {" "}moderate overlap, and <strong>below 50</strong> analog-level comparison.
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2 className="section-title">Metadata Completeness</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.7 }}>
            This measures how fully a record reports standardized fields such as modality,
            resolution, sample size, and curation status. It is not a scientific-quality score.
          </p>
        </section>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Public Data Status</h2>
          <div style={{ display: "grid", gap: 12 }}>
            <p className="muted" style={{ margin: 0 }}>
              <strong>None</strong>: no reusable public data source is known from the current corpus
              materials.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              <strong>Partial</strong>: some public underlying data or assets are available, but not
              necessarily the full dataset.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              <strong>Complete</strong>: reusable public data is known to exist for the dataset in a
              stronger form.
            </p>
          </div>
        </section>

        <section className="panel">
          <h2 className="section-title">Included vs Borderline</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.7 }}>
            Included records met the primary corpus criteria. Borderline records are still useful,
            but they usually have a methodological, reporting, or whole-cell-coverage caveat that
            should remain visible.
          </p>
        </section>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">Badge Legend</h2>
        <div style={{ display: "grid", gap: 12 }}>
          {badges.map((badge) => (
            <div
              key={badge.label}
              style={{
                display: "grid",
                gridTemplateColumns: "120px 1fr",
                gap: 12,
                alignItems: "center"
              }}
            >
              <span className={badge.className} style={{ textAlign: "center", width: "100%" }}>
                {badge.label}
              </span>
              <span className="muted" style={{ fontSize: "0.95rem" }}>
                {badge.copy}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Compare Workflow</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.7 }}>
            The current compare workflow starts from the corpus. Add two or more datasets from the
            table or card view, then use the compare drawer or Compare link. The empty compare page
            is just a destination, not where selection begins.
          </p>
        </section>

        <section className="panel">
          <h2 className="section-title">Best Next Step</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link href="/corpus" className="button" style={{ textDecoration: "none" }}>
              Open the Corpus
            </Link>
            <Link href="/about" className="button" style={{ textDecoration: "none" }}>
              Open About
            </Link>
          </div>
        </section>
      </section>
    </main>
  );
}
