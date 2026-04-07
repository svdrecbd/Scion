import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main>
      <section className="hero">
        <div className="kicker">Not Found</div>
        <h1>Scion could not find that record.</h1>
        <p>
          The requested dataset may have been removed, renamed, or never existed in the seeded corpus.
        </p>
      </section>

      <section className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          Return to the corpus and reselect the record from a live search result.
        </p>
        <Link href="/" className="button" style={{ textDecoration: "none", display: "inline-block" }}>
          Back to corpus
        </Link>
      </section>
    </main>
  );
}
