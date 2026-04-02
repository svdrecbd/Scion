"use client";

import { useCompare } from "../lib/compare-context";

export function CompareToggle({ id }: { id: string }) {
  const { selectedIds, toggleId } = useCompare();
  const isSelected = selectedIds.includes(id);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleId(id);
      }}
      className={`compare-toggle-btn ${isSelected ? "selected" : ""}`}
    >
      {isSelected ? "− Remove" : "+ Compare"}
    </button>
  );
}
