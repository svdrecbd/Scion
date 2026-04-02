"use client";

import React, { createContext, useContext, useState, useEffect } from "react";

type CompareContextType = {
  selectedIds: string[];
  toggleId: (id: string) => void;
  clear: () => void;
};

const CompareContext = createContext<CompareContextType | undefined>(undefined);

export function CompareProvider({ children }: { children: React.ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("scion_compare_ids");
    if (saved) {
      try {
        setSelectedIds(JSON.parse(saved));
      } catch (e) {
        localStorage.removeItem("scion_compare_ids");
      }
    }
  }, []);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id];
      localStorage.setItem("scion_compare_ids", JSON.stringify(next));
      return next;
    });
  };

  const clear = () => {
    setSelectedIds([]);
    localStorage.removeItem("scion_compare_ids");
  };

  return (
    <CompareContext.Provider value={{ selectedIds, toggleId, clear }}>
      {children}
    </CompareContext.Provider>
  );
}

export function useCompare() {
  const context = useContext(CompareContext);
  if (context === undefined) {
    throw new Error("useCompare must be used within a CompareProvider");
  }
  return context;
}
