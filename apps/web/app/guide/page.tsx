import React from "react";
import Link from "next/link";

export default function GuidePage() {
  return (
    <main>
      <section className="hero">
        <div className="kicker">Documentation</div>
        <h1>Guide to the Scion Platform</h1>
        <p>
          Scion is a structured lookup and comparison layer for whole-cell imaging datasets.
          This guide explains the project's ethos, how to interpret our metrics, and how to use the analytical tools.
        </p>
      </section>

      <div className="panel-grid two" style={{ marginTop: 48 }}>
        <div className="summary-grid">
          <section className="panel">
            <h2 className="section-title">Project Ethos</h2>
            <div style={{ display: "grid", gap: "24px" }}>
              <div>
                <strong>Provenance over hand-waving</strong>
                <p className="muted" style={{ marginTop: 8 }}>
                  Every record in Scion is indexed directly from the scientific literature. We prioritize 
                  clear, direct links back to original publication pages (PMIDs) and data repositories.
                </p>
              </div>
              <div>
                <strong>Comparability over completeness</strong>
                <p className="muted" style={{ marginTop: 8 }}>
                  We prioritize standardizing technical and biological metadata so researchers can 
                  actually compare studies side-by-side without "apples-to-oranges" errors.
                </p>
              </div>
              <div>
                <strong>Ad Interiora</strong>
                <p className="muted" style={{ marginTop: 8 }}>
                  "To the Interior." Scion is designed to help researchers synthesize evidence across 
                  different modalities and conditions to see deeper into cellular structure.
                </p>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2 className="section-title">Understanding the Data</h2>
            <div style={{ display: "grid", gap: "24px" }}>
              <div>
                <strong>Included vs. Borderline Studies</strong>
                <p className="muted" style={{ marginTop: 8 }}>
                  <strong>Included:</strong> Studies that met strict criteria for whole-cell imaging, 
                  confirmed cell boundaries, and clear organelle segmentation.<br/><br/>
                  <strong>Borderline:</strong> Studies that were excluded from the primary corpus but 
                  contain valuable near-miss data. Toggle "Include Borderline" in search to see them.
                </p>
              </div>
              <div>
                <strong>Verification Badges</strong>
                <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "12px", marginTop: 12, alignItems: "center" }}>
                  <span className="pill badge-verify" style={{ textAlign: "center", width: "100%" }}>Res</span>
                  <span className="muted" style={{ fontSize: "0.9rem" }}>Explicit reporting of lateral and axial resolution.</span>
                  
                  <span className="pill badge-verify" style={{ textAlign: "center", width: "100%" }}>SS</span>
                  <span className="muted" style={{ fontSize: "0.9rem" }}>Clear statement of sample size (cell count).</span>
                  
                  <span className="pill badge-verify" style={{ textAlign: "center", width: "100%" }}>Boundary</span>
                  <span className="muted" style={{ fontSize: "0.9rem" }}>Human-confirmed whole-cell boundaries.</span>
                  
                  <span className="pill badge-public" style={{ textAlign: "center", width: "100%" }}>Data</span>
                  <span className="muted" style={{ fontSize: "0.9rem" }}>Direct links to reusable raw data exist.</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside style={{ display: "grid", gap: 16 }}>
          <section className="panel">
            <h2 className="section-title">Analytical Tools</h2>
            <ul style={{ paddingLeft: 20, margin: 0, display: "grid", gap: 16 }}>
              <li>
                <strong>Gap Finder:</strong> Visit the <em>Analytics</em> page to pivot the corpus and 
                find under-studied areas or common reporting failures.
              </li>
              <li>
                <strong>Technical Benchmarks:</strong> Compare resolution and sample size norms across 
                EM, X-ray, and Optical modalities.
              </li>
              <li>
                <strong>Similarity Discovery:</strong> Use the sidebar on any dataset page to find 
                studies with the highest biological and technical overlap.
              </li>
              <li>
                <strong>Export Engine:</strong> Download your current filtered results as a 
                standardized CSV for external meta-analysis.
              </li>
            </ul>
          </section>

          <section className="panel">
            <h2 className="section-title">Comparability Scoring</h2>
            <p className="muted">
              Our alignment algorithm ranks datasets based on:
            </p>
            <ul style={{ paddingLeft: 20, marginTop: 12, display: "grid", gap: 8, fontSize: "0.9rem" }}>
              <li>Same cell type (+40 pts)</li>
              <li>Same species (+10 pts)</li>
              <li>Same modality family (+10 pts)</li>
              <li>Shared organelle pairs (+5 pts each)</li>
              <li>Shared metric families (+5 pts each)</li>
            </ul>
          </section>
        </aside>
      </div>

      <div style={{ marginTop: 48, textAlign: "center" }}>
        <Link href="/" className="button" style={{ textDecoration: "none" }}>
          Explore the Corpus
        </Link>
      </div>
    </main>
  );
}
