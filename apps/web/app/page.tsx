import Link from "next/link";
import { redirect } from "next/navigation";
import { normalizeSearchParams, type RouteSearchParams } from "../lib/route-props";

const capabilityCards = [
  {
    title: "Find precedent",
    copy: "Search for where a cell type, organelle, modality, or technical range already appears in the literature."
  },
  {
    title: "Compare records",
    copy: "Line up candidate datasets and see where they genuinely overlap versus where the comparison gets weak."
  },
  {
    title: "Map the field",
    copy: "Use analytics to see crowded areas, sparse areas, and where public data is still rare."
  },
  {
    title: "Benchmark a plan",
    copy: "Check whether a proposed target, voxel size, and sample size look well-precedented or frontier."
  }
];

const screenCards = [
  {
    title: "Corpus",
    href: "/corpus",
    copy: "The working surface. Search, filter, scan records quickly, and build a compare set."
  },
  {
    title: "Compare",
    href: "/compare",
    copy: "Use after you have candidate datasets and want to inspect where they align or diverge."
  },
  {
    title: "Analytics",
    href: "/analytics",
    copy: "Use for field-level patterns: coverage, tradeoffs, benchmarks, and reporting gaps."
  },
  {
    title: "Plan",
    href: "/plan",
    copy: "Use to benchmark a proposed experiment against what the corpus already contains."
  }
];

export default async function LandingPage({
  searchParams
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const resolvedSearchParams = normalizeSearchParams(await searchParams);
  const params = new URLSearchParams();

  Object.entries(resolvedSearchParams).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });

  if (params.size > 0) {
    redirect(`/corpus?${params.toString()}`);
  }

  return (
    <main>
      <section className="hero landing-hero" style={{ marginBottom: 36 }}>
        <div className="kicker">Whole-Cell Imaging Atlas</div>
        <h1>Find Precedent, Compare Datasets, and Map the Structure of the Field.</h1>
        <p>
          Scion is a structured lookup and comparison layer for whole-cell imaging studies. It is
          meant to help you find relevant records fast, understand how they were reported, and see
          where the literature is strong, thin, or hard to compare directly.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          <Link href="/corpus" className="button" style={{ textDecoration: "none" }}>
            Open the Corpus
          </Link>
          <Link href="/analytics" className="button" style={{ textDecoration: "none" }}>
            Open Analytics
          </Link>
          <Link href="/about" className="button" style={{ textDecoration: "none" }}>
            About the Corpus
          </Link>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <div className="kicker" style={{ margin: 0 }}>What Scion helps you do</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
            marginTop: 18
          }}
        >
          {capabilityCards.map((item) => (
            <section key={item.title} className="panel" style={{ background: "var(--background)" }}>
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
            <li>Use table view to scan quickly, then open records that look promising.</li>
            <li>Build a compare set from the table or card view once you have promising records.</li>
            <li>Use Analytics or Plan once your question becomes field-level instead of record-level.</li>
          </ol>
        </section>

        <section className="panel">
          <h2 className="section-title">What Matters Most</h2>
          <div style={{ display: "grid", gap: 14 }}>
            <p className="muted" style={{ margin: 0 }}>
              <strong>Included vs Borderline</strong>: borderline records can still be useful, but
              they require more caution.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              <strong>Public Data Status</strong>: tells you whether reusable data is known to
              exist, not whether Scion already mirrors it.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              <strong>Metadata Completeness</strong>: measures reporting completeness, not
              scientific merit.
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
          {screenCards.map((screen) => (
            <section key={screen.title} className="panel" style={{ background: "var(--background)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                <h3 className="screen-card-title">{screen.title}</h3>
                <Link
                  href={screen.href}
                  className="muted"
                  style={{ textDecoration: "underline", fontSize: "0.85rem" }}
                >
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
          <h2 className="section-title">Interpretation Warning</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.7 }}>
            Scion is designed to help you find and compare records faster. It is not meant to make
            the literature seem more certain than it is. When a record matters, read the paper.
          </p>
        </section>

        <section className="panel">
          <h2 className="section-title">Need More Context?</h2>
          <p className="muted" style={{ margin: "0 0 16px", lineHeight: 1.7 }}>
            The about page holds the project context, source links, and the scoping-review
            backbone that Scion is built from.
          </p>
          <Link href="/about" className="muted" style={{ textDecoration: "underline" }}>
            Open About
          </Link>
        </section>
      </section>
    </main>
  );
}
