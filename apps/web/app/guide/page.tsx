import React from "react";
import Link from "next/link";

const coreUses = [
  {
    title: "Find precedent",
    copy: "See which studies already cover a cell type, organelle, modality, or technical range."
  },
  {
    title: "Compare records",
    copy: "Line up a few plausible studies side by side and see where they are aligned or mismatched."
  },
  {
    title: "Map the field",
    copy: "Use analytics to see what is crowded, what is sparse, and where public data is missing."
  },
  {
    title: "Benchmark a plan",
    copy: "Check whether a proposed target, resolution, and sample size look well-precedented or frontier."
  }
];

const screens = [
  {
    title: "Corpus",
    href: "/",
    copy: "Start here. Search and filter the atlas, scan records quickly in table view, or switch to cards when you want more context."
  },
  {
    title: "Dataset detail",
    href: "/datasets/deshmukh-2024-092",
    copy: "Use this page when you need to inspect one record properly: specs, provenance, notes, public-data status, and similar studies."
  },
  {
    title: "Compare",
    href: "/compare",
    copy: "Use this after you have picked a few candidate studies and want to see whether they are similar enough to reason about together."
  },
  {
    title: "Analytics",
    href: "/analytics",
    copy: "Use this to understand corpus-wide patterns: technical tradeoffs, modality-organelles coverage, and reporting gaps."
  },
  {
    title: "Plan",
    href: "/plan",
    copy: "Use this to benchmark a proposed experiment against what the atlas already contains."
  }
];

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
        <h1>How to Use Scion</h1>
        <p>
          Scion helps you find relevant whole-cell imaging studies, inspect how they were reported,
          compare them, and understand where the corpus is strong or thin.
        </p>
      </section>

      <section
        className="panel"
        style={{
          marginTop: 36,
          display: "grid",
          gap: 18,
          background: "var(--background)",
          borderColor: "var(--foreground)"
        }}
      >
        <div className="kicker" style={{ margin: 0 }}>What You Can Do Here</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16
          }}
        >
          {coreUses.map((item) => (
            <section key={item.title} className="panel" style={{ background: "var(--accent)" }}>
              <h2 className="section-title">{item.title}</h2>
              <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                {item.copy}
              </p>
            </section>
          ))}
        </div>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Best Way to Start</h2>
          <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 12 }}>
            <li>Open the corpus and search for a cell type, organelle, or modality family.</li>
            <li>Use the default table view to scan records quickly.</li>
            <li>Open one or two promising dataset pages and read the provenance and curation notes.</li>
            <li>Switch to card view if you want to build a compare set.</li>
            <li>Use Analytics once you want the field-level picture instead of the record-level picture.</li>
          </ol>
        </section>

        <section className="panel">
          <h2 className="section-title">Small Amount of Ethos</h2>
          <div style={{ display: "grid", gap: 14 }}>
            <p className="muted" style={{ margin: 0 }}>
              Scion favors provenance and comparability over flashy abstraction.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              That means the product tries to make records legible and traceable, not magically more
              certain than the literature actually is.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              When a record matters, the publication is still the final authority.
            </p>
          </div>
        </section>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">What Each Screen Is For</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16
          }}
        >
          {screens.map((screen) => (
            <section key={screen.title} className="panel" style={{ background: "var(--background)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                <h3 style={{ margin: 0 }}>{screen.title}</h3>
                <Link href={screen.href} className="muted" style={{ textDecoration: "underline", fontSize: "0.85rem" }}>
                  Open
                </Link>
              </div>
              <p className="muted" style={{ margin: "14px 0 0", lineHeight: 1.6 }}>
                {screen.copy}
              </p>
            </section>
          ))}
        </div>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Things That Actually Matter</h2>
          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <strong>Included vs. Borderline</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                Included records met the primary corpus criteria. Borderline records are still useful,
                but they need more caution.
              </p>
            </div>
            <div>
              <strong>Public data status</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                This tells you whether reusable public data is known to exist. It does not mean the
                data is already mirrored or equally easy to reuse.
              </p>
            </div>
            <div>
              <strong>Metadata quality</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                This is a reporting-completeness score, not a scientific-quality score.
              </p>
            </div>
            <div>
              <strong>Missing values</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                Usually a reporting or extraction gap, not proof that the study lacked that feature.
              </p>
            </div>
          </div>
        </section>

        <section className="panel">
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
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Most Useful Tips</h2>
          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <strong>Table first, cards second</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                Table view is better for scanning quickly. Card view is better when you want more
                context or want to add datasets to compare.
              </p>
            </div>
            <div>
              <strong>Compare starts in card view</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                The compare toggle lives on the cards. Select records there, then use the compare
                drawer at the bottom.
              </p>
            </div>
            <div>
              <strong>Use Analytics after you have a question</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                Analytics is best when you already know what kind of gap, tradeoff, or coverage
                pattern you are looking for.
              </p>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2 className="section-title">Interpretation Warnings</h2>
          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <strong>Compare is a ranking aid</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                A high compare score means “look here first,” not “these studies are equivalent.”
              </p>
            </div>
            <div>
              <strong>Planner is a benchmarker</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                It tells you what the atlas suggests, not what biology guarantees.
              </p>
            </div>
            <div>
              <strong>The source publication still matters</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                When a record affects a real decision, read the paper.
              </p>
            </div>
          </div>
        </section>
      </section>

      <div style={{ marginTop: 40, display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
        <Link href="/" className="button" style={{ textDecoration: "none" }}>
          Open the Corpus
        </Link>
        <Link href="/analytics" className="button" style={{ textDecoration: "none" }}>
          Open Analytics
        </Link>
      </div>
    </main>
  );
}
