"use client";

import Link from "next/link";
import { useCompare } from "../lib/compare-context";

export function CompareDrawer() {
  const { selectedIds, clear } = useCompare();

  if (selectedIds.length === 0) return null;

  return (
    <div className="compare-drawer">
      <div className="compare-drawer-content">
        <div className="compare-drawer-info">
          <strong>{selectedIds.length}</strong> {selectedIds.length === 1 ? "dataset" : "datasets"} selected
        </div>
        <div className="compare-drawer-actions">
          <button type="button" onClick={clear} className="nav-link-btn" style={{ fontSize: "0.9rem" }}>
            Clear
          </button>
          <Link
            href={`/compare?ids=${selectedIds.join(",")}`}
            className="button"
            style={{ padding: "8px 20px", fontSize: "0.9rem", textDecoration: "none" }}
          >
            Compare Now
          </Link>
        </div>
      </div>
    </div>
  );
}
