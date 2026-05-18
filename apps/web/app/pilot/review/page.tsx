import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ADVISORY_REVIEW_STATUSES,
  type AdvisoryFinding,
  getAdvisoryReviewItems,
  getPilotRoot,
  isPilotReviewEnabled,
} from "../../../lib/public-pilot";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ updated?: string; error?: string }>;
};

function statusCounts(items: Array<{ finding: AdvisoryFinding }>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.finding.review_status] = (counts[item.finding.review_status] ?? 0) + 1;
    return counts;
  }, {});
}

function ReviewButton({
  slug,
  findingId,
  status,
  label,
  publicNoticeCandidate,
}: {
  slug: string;
  findingId: string;
  status: string;
  label: string;
  publicNoticeCandidate: boolean;
}) {
  return (
    <form method="post" action="/pilot/review/update">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="finding_id" value={findingId} />
      <input type="hidden" name="review_status" value={status} />
      <input
        type="hidden"
        name="public_notice_candidate"
        value={publicNoticeCandidate ? "true" : "false"}
      />
      <button type="submit" className="button" style={{ padding: "8px 12px", fontSize: "0.75rem" }}>
        {label}
      </button>
    </form>
  );
}

export default async function AdvisoryReviewPage({ searchParams }: PageProps) {
  if (!isPilotReviewEnabled()) {
    notFound();
  }

  const [{ updated, error }, items] = await Promise.all([
    searchParams,
    getAdvisoryReviewItems(),
  ]);
  const counts = statusCounts(items);
  const publicReady = counts.approved_public ?? 0;

  return (
    <main>
      <section className="hero">
        <div className="kicker">Local Review Suite</div>
        <h1>Advisory Flag Review</h1>
        <p>
          Review generated watchdog findings before anything appears publicly. This suite reads and
          writes advisory manifests under <code>{getPilotRoot()}</code>.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <div className="pill-row">
          <span className="pill">{items.length} total flags</span>
          {ADVISORY_REVIEW_STATUSES.map((status) => (
            <span key={status} className="pill">
              {counts[status] ?? 0} {status.replaceAll("_", " ")}
            </span>
          ))}
          <span className="pill">{publicReady} public reuse notes</span>
        </div>
        {updated ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Updated <code>{updated}</code>.
          </p>
        ) : null}
        {error ? (
          <p style={{ marginBottom: 0 }}>
            <strong>Review update failed:</strong> <code>{error}</code>
          </p>
        ) : null}
      </section>

      <section style={{ display: "grid", gap: 16, marginTop: 24 }}>
        {items.length === 0 ? (
          <section className="panel">
            <h2 className="section-title">No Flags Found</h2>
            <p className="muted" style={{ margin: 0 }}>
              Run the advisory builder against the current public-data root, then reload this page.
            </p>
          </section>
        ) : (
          items.map(({ slug, dataset, finding }) => (
            <article
              key={`${slug}:${finding.finding_id}`}
              id={finding.finding_id}
              className="panel"
            >
              <div className="kicker">
                {finding.severity} · {finding.category} · {finding.review_status.replaceAll("_", " ")}
              </div>
              <h2 className="section-title" style={{ marginTop: 6 }}>
                {finding.asset_relative_path || "Dataset-level advisory"}
              </h2>
              <p className="muted" style={{ lineHeight: 1.5 }}>
                <strong>{slug}</strong>
                {" · "}
                {dataset.source} {dataset.entry_id}
                {dataset.title ? ` · ${dataset.title}` : ""}
              </p>
              <p style={{ lineHeight: 1.6 }}>{finding.summary}</p>
              <p className="muted" style={{ lineHeight: 1.6 }}>
                {finding.impact}
              </p>
              <p className="muted" style={{ lineHeight: 1.6 }}>
                <strong>Recommended action:</strong> {finding.recommended_action}
              </p>
              <div className="pill-row">
                <span className="pill">{finding.code}</span>
                <span className="pill">
                  {finding.public_notice_candidate ? "public candidate" : "internal only"}
                </span>
                {finding.reviewed_at ? <span className="pill">reviewed {finding.reviewed_at}</span> : null}
              </div>
              <details style={{ marginTop: 14 }}>
                <summary className="muted" style={{ cursor: "pointer" }}>
                  Evidence
                </summary>
                <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>
                  {JSON.stringify(finding.evidence, null, 2)}
                </pre>
              </details>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
                <ReviewButton
                  slug={slug}
                  findingId={finding.finding_id}
                  status="approved_public"
                  label="Approve Public"
                  publicNoticeCandidate
                />
                <ReviewButton
                  slug={slug}
                  findingId={finding.finding_id}
                  status="internal_only"
                  label="Keep Internal"
                  publicNoticeCandidate={false}
                />
                <ReviewButton
                  slug={slug}
                  findingId={finding.finding_id}
                  status="dismissed"
                  label="Dismiss"
                  publicNoticeCandidate={false}
                />
                <ReviewButton
                  slug={slug}
                  findingId={finding.finding_id}
                  status="needs_human_review"
                  label="Reset Review"
                  publicNoticeCandidate={finding.public_notice_candidate}
                />
                <Link
                  href={`/pilot/${encodeURIComponent(slug)}`}
                  className="button"
                  style={{ padding: "8px 12px", fontSize: "0.75rem", textDecoration: "none" }}
                >
                  Open Dataset
                </Link>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
