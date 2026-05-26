import Image from "next/image";
import Link from "next/link";

const roadmapItems = [
  {
    title: "Account connections",
    copy: "A lightweight way to keep Atlas and local Workbench activity connected when the account layer is ready."
  },
  {
    title: "Local data flow",
    copy: "Clearer import, indexing, and project-state handling for user-provided volumes."
  },
  {
    title: "Atlas to Workbench",
    copy: "A tighter path from public records into local inspection, measurement, regions, jobs, and exports."
  }
];

export default function CaosPage() {
  return (
    <main className="caos-page">
      <section className="hero caos-hero">
        <div className="caos-hero-copy">
          <div className="kicker">Cell Anatomy Operating System</div>
          <h1>CAOS</h1>
          <p>
            CAOS is the working name for the Cell Anatomy platform: a public Atlas for field
            context, paired with a local Workbench for inspecting and organizing volume data.
          </p>
          <div className="caos-actions">
            <Link href="/corpus" className="button" style={{ textDecoration: "none" }}>
              Open the Corpus
            </Link>
            <Link href="/plan" className="button" style={{ textDecoration: "none" }}>
              Open Plan
            </Link>
          </div>
        </div>
        <figure className="caos-screenshot">
          <Image
            src="/brand/caos-operating-system-preview.png"
            alt="CAOS local Workbench prototype showing orthogonal microscopy views and measurement tools"
            width={1800}
            height={1017}
            priority
            sizes="(max-width: 920px) 100vw, 58vw"
          />
          <figcaption>Current local Workbench prototype.</figcaption>
        </figure>
      </section>

      <section className="panel caos-roadmap" style={{ marginTop: 32 }}>
        <div>
          <div className="kicker" style={{ margin: 0 }}>Near-Term Direction</div>
          <h2 className="section-title" style={{ marginTop: 10 }}>What CAOS is building toward</h2>
        </div>
        <div className="caos-roadmap-grid">
          {roadmapItems.map((item) => (
            <section key={item.title} className="panel" style={{ background: "var(--background)" }}>
              <h3 className="screen-card-title">{item.title}</h3>
              <p className="muted" style={{ margin: "12px 0 0", lineHeight: 1.6 }}>
                {item.copy}
              </p>
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
