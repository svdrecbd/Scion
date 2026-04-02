"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Props = {
  initialQuery?: string;
  initialPublic?: boolean;
  initialBorderline?: boolean;
  onlyToggle?: boolean;
};

export function HeroSearch({ initialQuery, initialPublic, initialBorderline, onlyToggle }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleToggle = (key: string, checked: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (checked) {
      params.set(key, "true");
    } else {
      params.delete(key);
    }
    router.push(`/?${params.toString()}`);
  };

  if (onlyToggle) {
    return (
      <div style={{ display: "flex", gap: "24px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.9rem" }}>
          <input
            type="checkbox"
            checked={initialPublic}
            onChange={(e) => handleToggle("public", e.target.checked)}
          />
          Show only datasets with public data
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.9rem" }}>
          <input
            type="checkbox"
            checked={initialBorderline}
            onChange={(e) => handleToggle("borderline", e.target.checked)}
          />
          Include borderline studies
        </label>
      </div>
    );
  }

  return (
    <form action="/" className="search-row" style={{ marginTop: 24, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "20px" }}>
      <div style={{ flex: 1, minWidth: "300px", display: "flex", gap: "12px" }}>
        <input
          type="text"
          name="query"
          placeholder="Search by title, species, cell type, modality..."
          defaultValue={initialQuery}
          className="search-input"
        />
        <button type="submit" className="button">
          Search
        </button>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.9rem" }}>
        <input
          type="checkbox"
          name="public"
          value="true"
          defaultChecked={initialPublic}
          onChange={(e) => {
            const form = e.target.form;
            if (form) form.submit();
          }}
        />
        Show only datasets with public data
      </label>
    </form>
  );
}
