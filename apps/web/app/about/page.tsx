import Link from "next/link";

const sourceLinks = [
  {
    label: "BMC Biology scoping review",
    href: "https://doi.org/10.1186/s12915-026-02556-0",
    copy: "The review paper that defined the initial corpus and the inclusion logic."
  },
  {
    label: "Cell-Anatomy-Scoping-Review repository",
    href: "https://github.com/mmirvis/Cell-Anatomy-Scoping-Review",
    copy: "The source extraction and analysis repository behind the Cell Anatomy Corpus."
  },
  {
    label: "Literature corpus query",
    href: "https://pubmed.ncbi.nlm.nih.gov/?term=31805442,25714487,26045447,37948126,33245857,26101352,37749240,37449034,26919978,35921440,34616042,28827720,38438356,34819398,37157259,36950762,24895185,38501891,23231852,34726165,32000578,19692536,37071854,36921538,37808751,22955498,37946316,38854505,37852350,26888543,38590054,38352445,38081848,26882843,34616045,21050209,38014052,37996434,34798356,37670547,35816515,23332214,36560654,37523497,33055261,28499405,30559414,37156644,30827917,34499794,30406204,38786091,26470812,37908116,37980360,26877112,36416933,18345384,29044158,22872316,25837406,38416776,20869520,23461734,17710148,19116171,31949053,19718033,28049718,23300909,37805154,20534442,35535544,29226240,38232737,37600951,14699066,30978201,35324950,29674564,28960304,34729550,35148829,37933490,36912880,22432024,36712360,37169939,37455654,20865129,33326005,24935612,21907806,26063819,18069000,28444369,29049927,26811738,22155668,18387313,17419771,32815431,32648890,21567937,26306199,32511279,26772147,37737610,19880740,21360734,32382522,33594064,34215695,28538724,25611576,37519903,23326471,22780318,33298443,32814034,38198284,21908548,29765603,22505187",
    copy: "The broader literature backbone used to assemble and verify the corpus."
  }
];

const feedbackEmail = "svdrecbd@gmail.com";
const feedbackSubject = "Cell Anatomy feedback or correction";
const feedbackHref = `mailto:${feedbackEmail}?subject=${encodeURIComponent(feedbackSubject)}`;
const corpusCitation = "Mirvis, M., Weingard, B., Goodman, S. et al. A scoping study of the whole-cell imaging literature as a foundation for the emerging field of cell anatomy. BMC Biol (2026). https://doi.org/10.1186/s12915-026-02556-0";

const acknowledgementItems = [
  {
    label: "Scientific Lead",
    copy: "Mary Mirvis, PhD."
  },
  {
    label: "Technical Lead",
    copy: "Salvador Escobedo"
  }
];

export default function AboutPage() {
  return (
    <main>
      <section className="hero">
        <div className="kicker">About</div>
        <h1>What the Cell Anatomy Corpus Is Built From</h1>
        <p>
          The Cell Anatomy Corpus is a structured interface over a manually curated whole-cell
          imaging corpus. It is meant to make the literature easier to search, compare, and
          benchmark without pretending the underlying studies are more uniform than they are.
        </p>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Project Stance</h2>
          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <strong>Comparability over abstraction</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                The corpus tries to help you line records up honestly, not flatten the field into
                fake equivalence.
              </p>
            </div>
            <div>
              <strong>Provenance over hand-waving</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                Records point back to the paper and to known public data when it exists.
              </p>
            </div>
            <div>
              <strong>The paper still wins</strong>
              <p className="muted" style={{ margin: "8px 0 0" }}>
                This atlas is a comparison layer, not a replacement for reading the source
                publication when a decision matters.
              </p>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2 className="section-title">Current Scope</h2>
          <div style={{ display: "grid", gap: 16 }}>
            <p className="muted" style={{ margin: 0 }}>
              The current metadata MVP indexes dataset-level records derived from the scoping review
              corpus. It is strongest at discovery, comparison, field-level analytics, and plan
              benchmarking.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              It is not yet a full public-data mirror, image viewer, or curation workflow system.
            </p>
            <Link href="/corpus" className="button" style={{ textDecoration: "none", width: "fit-content" }}>
              Open the Corpus
            </Link>
          </div>
        </section>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">Source Links</h2>
        <div style={{ display: "grid", gap: 16 }}>
          {sourceLinks.map((link) => (
            <section key={link.label} className="panel" style={{ background: "var(--background)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 8 }}>
                  <strong>{link.label}</strong>
                  <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                    {link.copy}
                  </p>
                </div>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="button"
                  style={{ textDecoration: "none", alignSelf: "center", whiteSpace: "nowrap" }}
                >
                  Open ↗
                </a>
              </div>
            </section>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">If You Use This Platform or Corpus</h2>
        <p className="muted" style={{ margin: "0 0 16px", lineHeight: 1.7 }}>
          Please cite the underlying scoping study that defined the starting corpus and inclusion
          logic.
        </p>
        <p style={{ margin: 0, lineHeight: 1.7 }}>
          {corpusCitation}
        </p>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Acknowledgements</h2>
          <div className="acknowledgement-list">
            {acknowledgementItems.map((item) => (
              <section key={item.label} className="acknowledgement-item">
                <strong>{item.label}</strong>
                <p className="muted">{item.copy}</p>
              </section>
            ))}
          </div>
          <div style={{ display: "grid", gap: 18, marginTop: 18 }}>
            <section>
              <strong>Contact</strong>
              <p className="muted" style={{ margin: "8px 0 0", lineHeight: 1.7 }}>
                Mary Mirvis:{" "}
                <a href="mailto:mariya.mirvis@ucsf.edu" style={{ textDecoration: "underline" }}>
                  mariya.mirvis@ucsf.edu
                </a>
                {" "} / {" "}
                <a href="mailto:mirvis.mary@gmail.com" style={{ textDecoration: "underline" }}>
                  mirvis.mary@gmail.com
                </a>
                {" "} / {" "}
                <a href="https://mary.mirv.is" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
                  mary.mirv.is
                </a>
              </p>
              <p className="muted" style={{ margin: "8px 0 0", lineHeight: 1.7 }}>
                Salvador Escobedo:{" "}
                <a href="mailto:svdrecbd@gmail.com" style={{ textDecoration: "underline" }}>
                  svdrecbd@gmail.com
                </a>
              </p>
            </section>

            <section>
              <strong>Affiliation & Support</strong>
              <p className="muted" style={{ margin: "8px 0 0", lineHeight: 1.7 }}>
                Scientific work for the corpus is tied to the{" "}
                <a
                  href="https://biochemistry.ucsf.edu/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline" }}
                >
                  Department of Biochemistry and Biophysics at UCSF
                </a>
                {" "}and the{" "}
                <a
                  href="https://cellgeometry.ucsf.edu/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline" }}
                >
                  Laboratory of Cell Geometry
                </a>
                , directed by Wallace F. Marshall.
              </p>
              <p className="muted" style={{ margin: "8px 0 0", lineHeight: 1.7 }}>
                The underlying work was supported by the{" "}
                <a
                  href="https://pbbr.ucsf.edu/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline" }}
                >
                  UCSF Sandler Program for Breakthrough Biomedical Research
                </a>.
              </p>
            </section>
          </div>
        </section>

        <section className="panel feedback-panel">
          <div className="kicker">Feedback & Corrections</div>
          <h2 className="section-title">Help Improve the Index</h2>
          <p className="muted" style={{ lineHeight: 1.6 }}>
            Send corrections, missing-public-data leads, confusing labels, or feature requests.
            The most useful reports include the page or record, what looks wrong, and the source
            that supports the change.
          </p>

          <div className="feedback-actions">
            <a href={feedbackHref} className="button" style={{ textDecoration: "none" }}>
              Send Feedback
            </a>
            <span className="muted">Project inbox: {feedbackEmail}</span>
          </div>
        </section>
      </section>
    </main>
  );
}
