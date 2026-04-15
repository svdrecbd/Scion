"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Logo } from "./logo";
import { useCompare } from "../lib/compare-context";

export function Navbar() {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { selectedIds } = useCompare();
  
  const query = searchParams.get("query") ?? "";
  const isPublic = searchParams.get("public") === "true";
  const isBorderline = searchParams.get("borderline") === "true";
  const selectedOrganelle = searchParams.get("organelle") ?? "";
  const selectedModality = searchParams.get("family") ?? "";

  const compareHref = selectedIds.length > 0 ? `/compare?ids=${selectedIds.join(",")}` : "/compare";
  const isCorpusRoute = pathname === "/corpus";

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

    router.push(`/corpus${params.toString() ? `?${params.toString()}` : ""}`);
  };

  useEffect(() => {
    if (isCorpusRoute && (query || isPublic || isBorderline || selectedOrganelle || selectedModality)) {
      setIsSearchOpen(true);
    }
  }, [isCorpusRoute, query, isPublic, isBorderline, selectedOrganelle, selectedModality]);

  useEffect(() => {
    if (!isCorpusRoute) {
      setIsSearchOpen(false);
      setIsAdvancedOpen(false);
    }
  }, [isCorpusRoute]);

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
          {isCorpusRoute && isSearchOpen ? (
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
              {!isCorpusRoute ? (
                <Link href="/corpus" className="nav-link">
                  Corpus
                </Link>
              ) : (
                <button
                  type="button"
                  className="nav-link-btn"
                  onClick={() => setIsSearchOpen(true)}
                >
                  Search
                </button>
              )}
              <Link href={compareHref} className="nav-link">
                Compare
              </Link>
              <Link href="/analytics" className="nav-link">
                Analytics
              </Link>
              <Link href="/plan" className="nav-link">
                Plan
              </Link>
              <Link href="/about" className="nav-link">
                About
              </Link>
            </>
          )}
        </div>
      </div>

      {isCorpusRoute && isSearchOpen && isAdvancedOpen && (
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
