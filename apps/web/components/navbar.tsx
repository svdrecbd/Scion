"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Logo } from "./logo";
import { useCompare } from "../lib/compare-context";

export function Navbar() {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  
  const searchParams = useSearchParams();
  const router = useRouter();
  const { selectedIds } = useCompare();
  
  const query = searchParams.get("query") ?? "";
  const isPublic = searchParams.get("public") === "true";
  const isBorderline = searchParams.get("borderline") === "true";
  const selectedOrganelle = searchParams.get("organelle") ?? "";
  const selectedModality = searchParams.get("family") ?? "";

  const compareHref = selectedIds.length > 0 
    ? `/compare?ids=${selectedIds.join(",")}` 
    : "/compare";

  const handleSubmit = (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const formData = e ? new FormData(e.currentTarget) : null;
    
    const q = formData ? formData.get("query") as string : query;
    const pub = formData ? formData.get("public") === "true" : isPublic;
    const bld = formData ? formData.get("borderline") === "true" : isBorderline;
    const org = formData ? formData.get("organelle") as string : selectedOrganelle;
    const mod = formData ? formData.get("family") as string : selectedModality;
    
    const params = new URLSearchParams();
    if (q) params.set("query", q);
    if (pub) params.set("public", "true");
    if (bld) params.set("borderline", "true");
    if (org) params.set("organelle", org);
    if (mod) params.set("family", mod);
    
    // Preserve other fixed filters
    ["pair", "cell_type", "modality"].forEach(key => {
      const val = searchParams.get(key);
      if (val) params.set(key, val);
    });

    router.push(`/?${params.toString()}`);
  };

  useEffect(() => {
    if (query || isPublic || isBorderline || selectedOrganelle || selectedModality) {
      setIsSearchOpen(true);
    }
  }, [query, isPublic, isBorderline, selectedOrganelle, selectedModality]);

  return (
    <nav className="navbar-container">
      <div className="navbar">
        <div className="nav-title">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Logo />
            <span>Scion</span>
          </Link>
        </div>

        <div className="nav-links">
          {isSearchOpen ? (
            <form onSubmit={handleSubmit} className="nav-search-form" style={{ gap: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", borderBottom: "1px solid var(--foreground)" }}>
                <input
                  autoFocus
                  name="query"
                  type="text"
                  placeholder="Search..."
                  defaultValue={query}
                  className="nav-search-input"
                />
              </div>
              
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                  <input
                    type="checkbox"
                    name="public"
                    value="true"
                    defaultChecked={isPublic}
                    onChange={(e) => e.target.form?.requestSubmit()}
                  />
                  Public
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                  <input
                    type="checkbox"
                    name="borderline"
                    value="true"
                    defaultChecked={isBorderline}
                    onChange={(e) => e.target.form?.requestSubmit()}
                  />
                  Borderline
                </label>
                <button 
                  type="button" 
                  className="muted" 
                  style={{ background: "none", border: "none", fontSize: "0.85rem", textDecoration: "underline", cursor: "pointer" }}
                  onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
                >
                  {isAdvancedOpen ? "Less" : "More"}
                </button>
              </div>

              <button type="button" className="nav-close-btn" onClick={() => setIsSearchOpen(false)} style={{ marginLeft: "8px" }}>
                ×
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                className="nav-link-btn"
                onClick={() => setIsSearchOpen(true)}
              >
                Search
              </button>
              <Link href={compareHref} className="nav-link">
                Compare
              </Link>
              <Link href="/analytics" className="nav-link">
                Analytics
              </Link>
              <Link href="/plan" className="nav-link">
                Plan
              </Link>
              <a 
                href="https://pubmed.ncbi.nlm.nih.gov/?term=31805442,25714487,26045447,37948126,33245857,26101352,37749240,37449034,26919978,35921440,34616042,28827720,38438356,34819398,37157259,36950762,24895185,38501891,23231852,34726165,32000578,19692536,37071854,36921538,37808751,22955498,37946316,38854505,37852350,26888543,38590054,38352445,38081848,26882843,34616045,21050209,38014052,37996434,34798356,37670547,35816515,23332214,36560654,37523497,33055261,28499405,30559414,37156644,30827917,34499794,30406204,38786091,26470812,37908116,37980360,26877112,36416933,18345384,29044158,22872316,25837406,38416776,20869520,23461734,17710148,19116171,31949053,19718033,28049718,23300909,37805154,20534442,35535544,29226240,38232737,37600951,14699066,30978201,35324950,29674564,28960304,34729550,35148829,37933490,36912880,22432024,36712360,37169939,37455654,20865129,33326005,24935612,21907806,26063819,18069000,28444369,29049927,26811738,22155668,18387313,17419771,32815431,32648890,21567937,26306199,32511279,26772147,37737610,19880740,21360734,32382522,33594064,34215695,28538724,25611576,37519903,23326471,22780318,33298443,32814034,38198284,21908548,29765603,22505187" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="nav-link"
              >
                Literature ↗
              </a>
              <Link href="/guide" className="nav-link">
                Guide
              </Link>
            </>
          )}
        </div>
      </div>

      {isSearchOpen && isAdvancedOpen && (
        <div className="navbar-secondary">
          <form className="nav-search-form" style={{ justifyContent: "flex-end", width: "100%", gap: "24px" }} onChange={(e) => (e.currentTarget as HTMLFormElement).requestSubmit()}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Organelle:</span>
              <select name="organelle" defaultValue={selectedOrganelle} className="search-input" style={{ padding: "2px 8px", fontSize: "0.85rem" }}>
                <option value="">All</option>
                <option value="nucleus">Nucleus</option>
                <option value="mitochondria">Mitochondria</option>
                <option value="er">ER</option>
                <option value="golgi">Golgi</option>
                <option value="lysosome">Lysosome</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>Modality:</span>
              <select name="family" defaultValue={selectedModality} className="search-input" style={{ padding: "2px 8px", fontSize: "0.85rem" }}>
                <option value="">All</option>
                <option value="EM">EM</option>
                <option value="X-ray">X-ray</option>
                <option value="optical">Optical</option>
              </select>
            </div>
          </form>
        </div>
      )}
    </nav>
  );
}
