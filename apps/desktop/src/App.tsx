import { Suspense, useEffect, useState } from "react";
import { WorkbenchClient, PackagedDataset } from "./workbench-client";

export default function App() {
  const [datasets, setDatasets] = useState<PackagedDataset[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isTauri, setIsTauri] = useState(false);
  const [openingLocal, setOpeningLocal] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      setIsTauri(true);
    }
  }, []);

  const handleOpenLocalDirectory = async () => {
    if (openingLocal) return;
    try {
      setOpeningLocal(true);
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string | null>("select_local_directory");
      if (!path) {
        setOpeningLocal(false);
        return;
      }

      const response = await fetch(`http://127.0.0.1:8080/api/volume/open-local?path=${encodeURIComponent(path)}`);
      const result = await response.json();
      if (result.success && result.slug) {
        const freshResponse = await fetch("http://127.0.0.1:8080/api/volume/workbench-data");
        if (freshResponse.ok) {
          const freshData = await freshResponse.json();
          setDatasets(freshData);
          setError(null);
          setLoading(false);
          
          const targetDataset = freshData.find((d: any) => d.slug === result.slug);
          const targetDeriv = targetDataset?.derivatives[0];
          const maxVal = targetDeriv?.dtype.includes("16") || targetDeriv?.dtype === "uint16" ? 4095 : 255;
          
          const params = new URLSearchParams();
          params.set("dataset", result.slug);
          if (targetDeriv) {
            params.set("asset", targetDeriv.source_relative_path);
          }
          params.set("axis", "z");
          params.set("slice", "0");
          params.set("minContrast", "0");
          params.set("maxContrast", String(maxVal));
          params.set("colormap", "0");

          window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
        }
      } else {
        alert(`Failed to open local directory: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("Error opening directory picker:", error);
      alert("Directory selection failed. Please ensure the Cell Anatomy volume engine sidecar is running.");
    } finally {
      setOpeningLocal(false);
    }
  };

  useEffect(() => {
    let active = true;

    async function loadWorkbenchData() {
      setLoading(true);
      setError(null);

      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        try {
          const response = await fetch("http://127.0.0.1:8080/api/volume/workbench-data");
          if (!response.ok) {
            throw new Error(`Data runtime responded with status: ${response.status}`);
          }

          const data = await response.json();
          if (active) {
            setDatasets(data);
            setLoading(false);
          }
          return;
        } catch (err) {
          lastError = err;
          if (attempt < 20) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }

      if (active) {
        console.error("Failed to fetch workbench data:", lastError);
        setError(
          lastError instanceof Error
            ? lastError.message
            : "Could not connect to the local Cell Anatomy Volumetric Engine."
        );
        setLoading(false);
      }
    }

    loadWorkbenchData();

    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <main>
        <header className="cockpit-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="kicker" style={{ margin: 0, fontSize: 9, letterSpacing: "0.15em", color: "var(--atlas-blue-dark)" }}>CELL ANATOMY WORKBENCH</span>
            <span style={{ color: "var(--border)", fontSize: 16 }}>|</span>
            <h1 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 500, fontFamily: "var(--font-display)" }}>Biological Volumetric Terminal</h1>
          </div>
          <span style={{ fontSize: 9, fontFamily: "var(--font-display)", color: "var(--accent-foreground)", letterSpacing: "0.1em", textTransform: "uppercase" }}>INITIALIZING</span>
        </header>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#050505", borderTop: "1px solid var(--border)" }}>
          <span className="pulsing-text" style={{ fontSize: 13, fontFamily: "monospace", letterSpacing: "0.08em", color: "var(--foreground)" }}>
            INITIALIZING WORKBENCH INTERFACE MATRIX...
          </span>
        </div>
      </main>
    );
  }

  if (error || !datasets || datasets.length === 0) {
    return (
      <main>
        <header className="cockpit-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="kicker" style={{ margin: 0, fontSize: 9, letterSpacing: "0.15em", color: "var(--atlas-blue-dark)" }}>CELL ANATOMY WORKBENCH</span>
            <span style={{ color: "var(--border)", fontSize: 16 }}>|</span>
            <h1 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 500, fontFamily: "var(--font-display)" }}>Terminal Offline</h1>
          </div>
          <span style={{ fontSize: 9, fontFamily: "var(--font-display)", color: "var(--atlas-orange)", letterSpacing: "0.1em", textTransform: "uppercase" }}>DIAGNOSTICS FAILED</span>
        </header>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: 40, background: "var(--accent)", borderTop: "1px solid var(--border)" }}>
          <div className="panel" style={{ maxWidth: 640, width: "100%", border: "1px solid var(--border)", background: "var(--background)", padding: 32 }}>
            <div style={{ display: "grid", gap: 16 }}>
              <p className="muted" style={{ margin: 0, lineHeight: 1.6, fontFamily: "var(--font-body)" }}>
                {error ? `System Diagnostics: ${error}` : "Diagnostics: No volumetric Zarr derivatives found in the local index."}
              </p>
              <p className="muted" style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                Please ensure the desktop sidecar is running. The native app launches the volume engine automatically, or you can run <code>cargo run --release</code> in <code>workers/volume-engine</code>.
              </p>
              <div style={{ marginTop: 8 }}>
                <div style={{ display: "flex", gap: 12 }}>
                  <button 
                    onClick={() => window.location.reload()} 
                    className="button"
                    style={{ cursor: "pointer", background: "var(--foreground)", color: "var(--background)", border: "none", padding: "8px 16px" }}
                  >
                    Reconnect Terminal
                  </button>
                  {isTauri && (
                    <button 
                      onClick={handleOpenLocalDirectory} 
                      disabled={openingLocal}
                      className="button"
                      style={{ cursor: "pointer", background: "transparent", color: "var(--foreground)", border: "1px solid var(--border)", padding: "8px 16px" }}
                    >
                      {openingLocal ? "Opening..." : "+ Open Local Zarr Folder"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="cockpit-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="kicker" style={{ margin: 0, fontSize: 9, letterSpacing: "0.15em", color: "var(--atlas-blue-dark)" }}>CELL ANATOMY WORKBENCH</span>
          <span style={{ color: "var(--border)", fontSize: 16 }}>|</span>
          <h1 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 500, fontFamily: "var(--font-display)" }}>Biological Volumetric Terminal</h1>
        </div>
        <span style={{ fontSize: 9, fontFamily: "var(--font-display)", color: "var(--accent-foreground)", letterSpacing: "0.1em", textTransform: "uppercase" }}>OPERATIONAL INSTRUMENT DECK</span>
      </header>

      <Suspense fallback={
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#050505", borderTop: "1px solid var(--border)" }}>
          <span className="pulsing-text" style={{ fontSize: 13, fontFamily: "monospace", letterSpacing: "0.08em" }}>
            INITIALIZING WORKBENCH INTERFACE MATRIX...
          </span>
        </div>
      }>
        <WorkbenchClient datasets={datasets} />
      </Suspense>
    </main>
  );
}
