"use client";

import { useCompare } from "../lib/compare-context";

export function CompareToggle({ id, compact = false }: { id: string; compact?: boolean }) {
  const { selectedIds, toggleId } = useCompare();
  const isSelected = selectedIds.includes(id);
  const label = compact
    ? isSelected
      ? "Selected"
      : "Select"
    : isSelected
      ? "− Remove"
      : "+ Compare";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleId(id);
      }}
      className={`compare-toggle-btn ${isSelected ? "selected" : ""}`}
      aria-pressed={isSelected}
      aria-label={isSelected ? "Remove dataset from compare set" : "Add dataset to compare set"}
    >
      {label}
    </button>
  );
}
