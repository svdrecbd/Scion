"use client";

import React from "react";
import { useRouter } from "next/navigation";

type Props = {
  rowDim: string;
  colDim: string;
};

export function AnalyticsControls({ rowDim, colDim }: Props) {
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const row = formData.get("row") as string;
    const col = formData.get("col") as string;
    
    // Perform client-side navigation without scrolling to top
    router.push(`/analytics?row=${row}&col=${col}`, { scroll: false });
  };

  return (
    <form 
      onSubmit={handleSubmit}
      style={{ display: "flex", gap: "24px", marginBottom: 32, alignItems: "center", flexWrap: "wrap" }}
    >
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <span className="muted">Rows:</span>
        <select 
          name="row" 
          defaultValue={rowDim} 
          className="search-input" 
          style={{ padding: "4px 8px" }}
        >
          <option value="cell_type">Cell Type</option>
          <option value="species">Species</option>
          <option value="modality">Modality</option>
          <option value="comparator_class">Comparator</option>
        </select>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <span className="muted">Columns:</span>
        <select 
          name="col" 
          defaultValue={colDim} 
          className="search-input" 
          style={{ padding: "4px 8px" }}
        >
          <option value="public_data_status">Public Data Status</option>
          <option value="modality_family">Modality Family</option>
          <option value="sample_size_bucket">Sample Size Bucket</option>
          <option value="whole_cell_boundary_confirmed">Boundary Confirmed</option>
        </select>
      </div>
      <button type="submit" className="button" style={{ padding: "6px 16px", fontSize: "0.9rem" }}>Update</button>
    </form>
  );
}
