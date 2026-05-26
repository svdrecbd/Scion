import { Suspense, useEffect, useState, type DragEvent } from "react";
import { WorkbenchLogo } from "./brand";
import { WorkbenchClient, PackagedDataset } from "./workbench-client";

function CockpitHeader({
  status,
  statusColor = "var(--accent-foreground)",
}: {
  status: string;
  statusColor?: string;
}) {
  return (
    <header className="cockpit-header">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="desktop-brand-mark" aria-label="Cell Anatomy Operating System">
          <WorkbenchLogo />
          <span className="kicker" style={{ margin: 0, fontSize: 9, letterSpacing: 0, color: "var(--atlas-blue-dark)" }}>
            OPERATING SYSTEM
          </span>
        </div>
      </div>
      <span style={{ fontSize: 11, fontFamily: "var(--font-display)", color: statusColor, letterSpacing: 0, textTransform: "uppercase" }}>
        {status}
      </span>
    </header>
  );
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Data runtime responded with status: ${response.status}`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function App() {
  const [datasets, setDatasets] = useState<PackagedDataset[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isTauri, setIsTauri] = useState(false);
  const [openingLocal, setOpeningLocal] = useState(false);
  const [localImportStatus, setLocalImportStatus] = useState<string | null>(null);

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

      const result = await fetchJsonWithTimeout<{ success?: boolean; slug?: string; error?: string }>(
        `http://127.0.0.1:8080/api/volume/open-local?path=${encodeURIComponent(path)}`
      );
      if (result.success && result.slug) {
        const freshData = await fetchJsonWithTimeout<PackagedDataset[]>("http://127.0.0.1:8080/api/volume/workbench-data");
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
        params.set("viewMode", "orthogonal");
        params.set("zSlice", String(targetDeriv ? Math.floor(targetDeriv.shape_zyx[0] / 2) : 0));
        params.set("ySlice", String(targetDeriv ? Math.floor(targetDeriv.shape_zyx[1] / 2) : 0));
        params.set("xSlice", String(targetDeriv ? Math.floor(targetDeriv.shape_zyx[2] / 2) : 0));
        params.set("minContrast", "0");
        params.set("maxContrast", String(maxVal));
        params.set("colormap", "0");

        window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
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

  const handleDroppedLocalData = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    const textPath = event.dataTransfer.getData("text/plain");
    const path = file?.path || textPath;
    if (!path) {
      setLocalImportStatus(
        isTauri
          ? "Drop did not include a readable local path. Use Open Local Zarr Folder."
          : "Browser preview cannot read arbitrary local folders. Use the native Workbench shell for local import."
      );
      return;
    }

    setOpeningLocal(true);
    setLocalImportStatus(`Scanning ${path}`);
    try {
      const result = await fetchJsonWithTimeout<{ success?: boolean; slug?: string; error?: string }>(
        `http://127.0.0.1:8080/api/volume/open-local?path=${encodeURIComponent(path)}`
      );
      if (!result.success || !result.slug) {
        setLocalImportStatus(result.error || "Local import failed.");
        return;
      }
      const freshData = await fetchJsonWithTimeout<PackagedDataset[]>("http://127.0.0.1:8080/api/volume/workbench-data");
      setDatasets(freshData);
      setError(null);
      setLoading(false);
      setLocalImportStatus("Local dataset opened.");
    } catch (error) {
      setLocalImportStatus(error instanceof Error ? error.message : "Local import failed.");
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
          const data = await fetchJsonWithTimeout<PackagedDataset[]>("http://127.0.0.1:8080/api/volume/workbench-data", 5000);
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
        <CockpitHeader status="LOADING" />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#050505", borderTop: "1px solid var(--border)" }}>
          <span className="pulsing-text" style={{ fontSize: 12, fontFamily: "var(--font-display)", letterSpacing: 0, color: "var(--background)" }}>
            Loading workbench data...
          </span>
        </div>
      </main>
    );
  }

  if (error || !datasets || datasets.length === 0) {
    return (
      <main onDragOver={(event) => event.preventDefault()} onDrop={handleDroppedLocalData}>
        <CockpitHeader status="OFFLINE" statusColor="var(--atlas-orange)" />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: 40, background: "var(--accent)", borderTop: "1px solid var(--border)" }}>
          <div className="panel" style={{ maxWidth: 640, width: "100%", border: "1px solid var(--border)", background: "var(--field-background)", padding: 32 }}>
            <div style={{ display: "grid", gap: 16 }}>
              <div>
                <span className="kicker" style={{ display: "block", marginBottom: 6 }}>Local-First CAOS</span>
                <h1 style={{ margin: 0, fontSize: 22, fontFamily: "var(--font-display)" }}>
                  Open compatible local volume data to begin.
                </h1>
              </div>
              <p className="muted" style={{ margin: 0, lineHeight: 1.6, fontFamily: "var(--font-body)" }}>
                {error ? `System Diagnostics: ${error}` : "Diagnostics: No volumetric Zarr derivatives found in the local index."}
              </p>
              <p className="muted" style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                The native app launches the volume engine automatically. Current local import support expects raw uncompressed 3D Zarr v2 arrays with uint8 or uint16 voxels.
              </p>
              <div style={{ border: "1px dashed var(--border)", padding: 14, background: "var(--accent)", fontFamily: "var(--font-display)", fontSize: 12, color: "var(--accent-foreground)" }}>
                Drop a supported Zarr folder here, or use Open Local Zarr Folder in the native Workbench build.
              </div>
              {localImportStatus ? (
                <div style={{ border: "1px solid var(--border)", padding: 10, fontSize: 12, fontFamily: "var(--font-display)", color: localImportStatus.includes("failed") ? "var(--atlas-orange)" : "var(--atlas-blue-dark)" }}>
                  {localImportStatus}
                </div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                <div style={{ display: "flex", gap: 12 }}>
                  <button 
                    onClick={() => window.location.reload()} 
                    className="button"
                    style={{ cursor: "pointer", background: "var(--foreground)", color: "var(--background)", border: "none", padding: "8px 16px" }}
                  >
                    Reconnect
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
      <Suspense fallback={
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#050505", borderTop: "1px solid var(--border)" }}>
          <span className="pulsing-text" style={{ fontSize: 13, fontFamily: "var(--font-display)", letterSpacing: 0 }}>
            Loading workbench data...
          </span>
        </div>
      }>
        <WorkbenchClient datasets={datasets} />
      </Suspense>
    </main>
  );
}
