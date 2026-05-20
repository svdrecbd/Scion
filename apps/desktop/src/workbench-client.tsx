import React, { useState, useEffect, useMemo } from "react";
import { VolumetricViewer } from "./volumetric-viewer";

export type PackagedDataset = {
  slug: string;
  title: string;
  source: string;
  entryId: string;
  experimentType: string;
  derivatives: Array<{
    source_relative_path: string;
    source_local_path: string;
    source_sha256: string;
    source_size_bytes: number;
    output_path: string;
    format: string;
    ome_ngff_version: string;
    zarr_format: number;
    array_path: string;
    shape_zyx: number[];
    chunks_zyx: number[];
    dtype: string;
    byte_size: number;
    physical_voxel_size_nm: Record<string, string | number>;
    validation: {
      status: string;
      checks: Record<string, boolean>;
    };
  }>;
  findings: Array<{
    finding_id: string;
    dataset_slug: string;
    asset_relative_path: string;
    severity: string;
    category: string;
    code: string;
    summary: string;
    impact: string;
    recommended_action: string;
    public_notice_candidate: boolean;
    review_status: string;
  }>;
};

type WorkbenchClientProps = {
  datasets: PackagedDataset[];
};

export function WorkbenchClient({ datasets }: WorkbenchClientProps) {
  const [queryString, setQueryString] = useState(() =>
    typeof window === "undefined" ? "" : window.location.search
  );
  const searchParams = useMemo(() => new URLSearchParams(queryString), [queryString]);

  // 1. Local datasets state to merge custom loaded Zarr folders dynamically
  const [localDatasets, setLocalDatasets] = useState<PackagedDataset[]>(datasets);
  const [isTauri, setIsTauri] = useState(false);
  const [openingLocal, setOpeningLocal] = useState(false);

  useEffect(() => {
    setLocalDatasets(datasets);
  }, [datasets]);

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      setIsTauri(true);
    }
  }, []);

  useEffect(() => {
    const syncFromLocation = () => setQueryString(window.location.search);
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);

  // 2. Initial State from datasets list
  const defaultDataset = localDatasets[0] || null;
  const defaultDerivative = defaultDataset?.derivatives[0] || null;

  // 3. State values synchronized with URL (with standard defaults)
  const currentDatasetSlug = searchParams.get("dataset") || defaultDataset?.slug || "";
  const currentAssetPath = searchParams.get("asset") || defaultDerivative?.source_relative_path || "";
  const currentAxis = (searchParams.get("axis") || "z") as "z" | "y" | "x";
  const currentSlice = Number(searchParams.get("slice") || 0);
  const currentMinContrast = Number(searchParams.get("minContrast") || 0);
  const currentMaxContrast = Number(searchParams.get("maxContrast") || 255);
  const currentColormap = Number(searchParams.get("colormap") || 0);
  const currentLogScale = searchParams.get("logScale") === "true";

  // 3D Viewmode and downsample states
  const currentViewMode = (searchParams.get("viewMode") || "2d") as "2d" | "3d";
  const currentDownsample = Number(searchParams.get("downsample") || 4);

  // Interactive 3D variables stored locally to avoid Next.js routing freezes during high-frequency drag/scroll actions
  const [localPitch, setLocalPitch] = useState(0.0);
  const [localYaw, setLocalYaw] = useState(0.0);
  const [localAlphaScale, setLocalAlphaScale] = useState(0.15);

  // Stateful navigation tabs
  const [activeTab, setActiveTab] = useState<"telemetry" | "image-notes" | "planner">("telemetry");

  // Calibrated coordinate probe state
  const [activeProbe, setActiveProbe] = useState<{ px: number; py: number; pz: number; xUm: number; yUm: number; zUm: number; val: number } | null>(null);

  // Logarithmic SVG Voxel Intensity Histogram state
  const [histogramData, setHistogramData] = useState<number[]>(() => new Array(256).fill(0));

  // High-performance uniform sampler for dynamic histogram updates
  const handleSliceLoaded = (data: Uint8Array | Uint16Array) => {
    const histogram = new Array(256).fill(0);
    if (data.length === 0) return;
    const step = Math.max(1, Math.floor(data.length / 10000));
    
    let maxVal = 255;
    if (data instanceof Uint16Array) {
      maxVal = 65535;
    }
    
    for (let i = 0; i < data.length; i += step) {
      const val = data[i];
      const bin = data instanceof Uint16Array
        ? Math.min(255, Math.floor((val / maxVal) * 255))
        : Math.min(255, val);
      histogram[bin]++;
    }
    setHistogramData(histogram);
  };

  // Experiment planner states connecting to the local Rust sidecar
  const [planningOrganelles, setPlanningOrganelles] = useState("nucleus,mitochondria");
  const [planningRes, setPlanningRes] = useState<number>(100);
  const [planningSample, setPlanningSample] = useState<number>(10);
  const [planningCellType, setPlanningCellType] = useState("hiPSC");
  const [planningResult, setPlanningResult] = useState<any>(null);
  const [planningLoading, setPlanningLoading] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);

  const fetchPlanningResult = async () => {
    if (planningLoading) return;
    if (!planningOrganelles.trim()) {
      setPlanningResult(null);
      setPlanningError("Enter at least one organelle marker.");
      return;
    }
    setPlanningLoading(true);
    setPlanningError(null);
    try {
      const url = `http://127.0.0.1:8080/api/datasets/analytics/plan?organelles=${encodeURIComponent(planningOrganelles)}&res=${planningRes}&ss=${planningSample}&cell_type=${encodeURIComponent(planningCellType)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Plan API error: ${res.status}`);
      }
      const data = await res.json();
      setPlanningResult(data);
    } catch (err: any) {
      setPlanningError(err.message || "Failed to load plan analytics.");
    } finally {
      setPlanningLoading(false);
    }
  };

  const maxBinValue = useMemo(() => {
    return Math.max(1, ...histogramData);
  }, [histogramData]);

  const svgPath = useMemo(() => {
    if (histogramData.length === 0) return "";
    const width = 300;
    const height = 80;
    const points = histogramData.map((val, idx) => {
      const x = (idx / 255) * width;
      const logVal = Math.log1p(val);
      const logMax = Math.log1p(maxBinValue);
      const y = height - (logVal / logMax) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M 0,${height} L ${points.join(" L ")} L ${width},${height} Z`;
  }, [histogramData, maxBinValue]);

  const urlPitch = Number(searchParams.get("pitch") || 0.0);
  const urlYaw = Number(searchParams.get("yaw") || 0.0);
  const urlAlphaScale = Number(searchParams.get("alphaScale") || 0.15);

  // Synchronize local states when URL changes externally or during load
  useEffect(() => {
    setLocalPitch(urlPitch);
  }, [urlPitch]);

  useEffect(() => {
    setLocalYaw(urlYaw);
  }, [urlYaw]);

  useEffect(() => {
    setLocalAlphaScale(urlAlphaScale);
  }, [urlAlphaScale]);

  // Debounced URL updates for pitch and yaw (400ms inactivity timeout)
  useEffect(() => {
    const handler = setTimeout(() => {
      const uPitch = Number(searchParams.get("pitch") || 0.0);
      const uYaw = Number(searchParams.get("yaw") || 0.0);
      if (Math.abs(localPitch - uPitch) > 0.005 || Math.abs(localYaw - uYaw) > 0.005) {
        updateUrlParams({
          pitch: localPitch.toFixed(3),
          yaw: localYaw.toFixed(3),
        });
      }
    }, 400);
    return () => clearTimeout(handler);
  }, [localPitch, localYaw]);

  // Debounced URL updates for alpha opacity scale
  useEffect(() => {
    const handler = setTimeout(() => {
      const uAlpha = Number(searchParams.get("alphaScale") || 0.15);
      if (Math.abs(localAlphaScale - uAlpha) > 0.001) {
        updateUrlParams({
          alphaScale: localAlphaScale.toFixed(3),
        });
      }
    }, 400);
    return () => clearTimeout(handler);
  }, [localAlphaScale]);

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
          setLocalDatasets(freshData);
          
          const targetDataset = freshData.find((d: any) => d.slug === result.slug);
          const targetDeriv = targetDataset?.derivatives[0];
          const maxVal = targetDeriv?.dtype.includes("16") || targetDeriv?.dtype === "uint16" ? 4095 : 255;

          updateUrlParams({
            dataset: result.slug,
            asset: targetDeriv ? targetDeriv.source_relative_path : null,
            axis: "z",
            slice: 0,
            minContrast: 0,
            maxContrast: maxVal,
            colormap: 0,
            logScale: false,
          });
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

  // Callback to handle drag rotations inside VolumetricViewer canvas
  const handleRotationChange = (pitch: number, yaw: number) => {
    setLocalPitch(pitch);
    setLocalYaw(yaw);
  };

  // 3. Resolve active objects
  const activeDataset = useMemo(() => {
    return localDatasets.find((d) => d.slug === currentDatasetSlug) || defaultDataset;
  }, [localDatasets, currentDatasetSlug, defaultDataset]);

  const activeDerivative = useMemo(() => {
    if (!activeDataset) return null;
    return (
      activeDataset.derivatives.find((d) => d.source_relative_path === currentAssetPath) ||
      activeDataset.derivatives[0] ||
      null
    );
  }, [activeDataset, currentAssetPath]);

  // Voxel shapes: Z, Y, X
  const zMax = activeDerivative?.shape_zyx[0] || 1;
  const yMax = activeDerivative?.shape_zyx[1] || 1;
  const xMax = activeDerivative?.shape_zyx[2] || 1;

  // Clamp current slice based on active axis limits
  const maxSlicesForAxis = useMemo(() => {
    if (currentAxis === "z") return zMax;
    if (currentAxis === "y") return yMax;
    return xMax;
  }, [currentAxis, zMax, yMax, xMax]);

  // Keep state updated in case parameters go out of bounds
  useEffect(() => {
    if (currentSlice >= maxSlicesForAxis) {
      updateUrlParams({ slice: Math.max(0, maxSlicesForAxis - 1) });
    }
  }, [currentSlice, maxSlicesForAxis]);

  // Voxel dimensions for rendering and metric calculation
  const voxelSizeZ = Number(activeDerivative?.physical_voxel_size_nm?.z || 1);
  const voxelSizeY = Number(activeDerivative?.physical_voxel_size_nm?.y || 1);
  const voxelSizeX = Number(activeDerivative?.physical_voxel_size_nm?.x || 1);

  // 4. Update url helper
  const updateUrlParams = (updates: Record<string, string | number | boolean | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined || val === null || val === "") {
        params.delete(key);
      } else {
        params.set(key, String(val));
      }
    }
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`
    );
    setQueryString(window.location.search);
  };

  // Switch Dataset
  const handleDatasetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const slug = e.target.value;
    const targetDataset = localDatasets.find((d) => d.slug === slug);
    const targetDeriv = targetDataset?.derivatives[0];
    
    // Choose sensible default limits based on voxel types
    const maxVal = targetDeriv?.dtype.includes("16") || targetDeriv?.dtype === "uint16" ? 4095 : 255;

    updateUrlParams({
      dataset: slug,
      asset: targetDeriv ? targetDeriv.source_relative_path : null,
      axis: "z",
      slice: 0,
      minContrast: 0,
      maxContrast: maxVal,
      colormap: 0,
      logScale: false,
    });
  };

  // Switch Asset File within Dataset
  const handleAssetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const path = e.target.value;
    const targetDeriv = activeDataset?.derivatives.find((d) => d.source_relative_path === path);
    const maxVal = targetDeriv?.dtype.includes("16") || targetDeriv?.dtype === "uint16" ? 4095 : 255;

    updateUrlParams({
      asset: path,
      slice: 0,
      minContrast: 0,
      maxContrast: maxVal,
    });
  };

  // Dynamic Metadata callbacks from VolumetricViewer
  const [maxPossibleIntensity, setMaxPossibleIntensity] = useState(255);
  const handleLoadedMetadata = ({ maxPossible }: { maxPossible: number }) => {
    setMaxPossibleIntensity(maxPossible);
    // If contrast boundaries are currently at the default 255 but the loaded dataset is 65535, adjust automatically.
    if (currentMaxContrast === 255 && maxPossible > 255) {
      updateUrlParams({ maxContrast: maxPossible });
    }
  };

  // Metric computations
  const totalVolumeUm3 = useMemo(() => {
    if (!activeDerivative) return 0;
    const totalVoxels = zMax * yMax * xMax;
    const voxelVolNm3 = voxelSizeZ * voxelSizeY * voxelSizeX;
    return (totalVoxels * voxelVolNm3) / 1e9; // 1 micrometer^3 = 10^9 nanometer^3
  }, [activeDerivative, zMax, yMax, xMax, voxelSizeZ, voxelSizeY, voxelSizeX]);

  const activeSliceAreaUm2 = useMemo(() => {
    if (!activeDerivative) return 0;
    let widthNm = 0;
    let heightNm = 0;
    if (currentAxis === "z") {
      widthNm = xMax * voxelSizeX;
      heightNm = yMax * voxelSizeY;
    } else if (currentAxis === "y") {
      widthNm = xMax * voxelSizeX;
      heightNm = zMax * voxelSizeZ;
    } else {
      widthNm = yMax * voxelSizeY;
      heightNm = zMax * voxelSizeZ;
    }
    return (widthNm * heightNm) / 1e6; // 1 micrometer^2 = 10^6 nanometer^2
  }, [currentAxis, activeDerivative, zMax, yMax, xMax, voxelSizeZ, voxelSizeY, voxelSizeX]);

  // Group findings related to active asset or active dataset
  const activeFindings = useMemo(() => {
    if (!activeDataset) return [];
    return activeDataset.findings.filter(
      (f) =>
        !f.asset_relative_path ||
        f.asset_relative_path === activeDerivative?.source_relative_path
    );
  }, [activeDataset, activeDerivative]);

  return (
    <div className="cockpit-grid">
      {/* 1. Left Column: Selectors, Slicing & Parameter Controls */}
      <aside className="cockpit-panel-left">
        {/* Dataset selector */}
        <div>
          <label className="kicker" style={{ display: "block", marginBottom: 6, fontSize: 11, letterSpacing: "0.08em" }}>
            1. Select Volume Dataset
          </label>
          <select
            value={currentDatasetSlug}
            onChange={handleDatasetChange}
            className="search-input"
            style={{ width: "100%", padding: "6px 12px", background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 13, outline: "none", cursor: "pointer", fontFamily: "var(--font-display)" }}
          >
            {localDatasets.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.entryId ? `[${d.source} ${d.entryId}] ` : ""}{d.slug}
              </option>
            ))}
          </select>
          {isTauri && (
            <button
              onClick={handleOpenLocalDirectory}
              disabled={openingLocal}
              className="button"
              style={{
                marginTop: 8,
                width: "100%",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                height: 31,
                fontSize: 11,
                padding: "4px 12px",
                cursor: "pointer",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--foreground)",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                fontFamily: "var(--font-display)",
              }}
            >
              {openingLocal ? "Opening..." : "+ Open Local Folder"}
            </button>
          )}
        </div>

        {/* Target 3D Asset selector */}
        <div>
          <label className="kicker" style={{ display: "block", marginBottom: 6, fontSize: 11, letterSpacing: "0.08em" }}>
            2. Target 3D Asset File
          </label>
          <select
            value={currentAssetPath}
            onChange={handleAssetChange}
            disabled={!activeDataset || activeDataset.derivatives.length <= 1}
            className="search-input"
            style={{ width: "100%", padding: "6px 12px", background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 13, outline: "none", cursor: activeDataset && activeDataset.derivatives.length > 1 ? "pointer" : "default", fontFamily: "var(--font-display)" }}
          >
            {activeDataset?.derivatives.map((deriv) => (
              <option key={deriv.source_relative_path} value={deriv.source_relative_path}>
                {deriv.source_relative_path.split("/").pop()}
              </option>
            )) || <option value="">No assets found</option>}
          </select>
        </div>

        {/* Share state Coordinate copy */}
        <div>
          <label className="kicker" style={{ display: "block", marginBottom: 6, fontSize: 11, letterSpacing: "0.08em" }}>
            3. Share State Token
          </label>
          <button
            onClick={() => {
              navigator.clipboard.writeText(window.location.href);
              alert("Workbench coordinate link copied to clipboard!");
            }}
            className="button"
            style={{ width: "100%", display: "flex", justifyContent: "center", alignItems: "center", height: 31, fontSize: 12, padding: "4px 12px", cursor: "pointer", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
          >
            Copy Coordinate URL
          </button>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "4px 0" }} />

        {/* View mode toggle: 2D vs 3D */}
        <div>
          <label className="kicker" style={{ display: "block", marginBottom: 8, fontSize: 11, letterSpacing: "0.08em" }}>
            Viewport Visualizer Mode
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              onClick={() => updateUrlParams({ viewMode: "2d" })}
              style={{
                width: "100%",
                borderRadius: 0,
                border: "1px solid",
                borderColor: currentViewMode === "2d" ? "var(--foreground)" : "var(--border)",
                background: currentViewMode === "2d" ? "var(--foreground)" : "transparent",
                color: currentViewMode === "2d" ? "var(--background)" : "var(--foreground)",
                padding: "6px 12px",
                fontSize: 11,
                cursor: "pointer",
                transition: "all 0.15s ease",
                fontFamily: "var(--font-display)",
              }}
            >
              2D SLICES
            </button>
            <button
              onClick={() => updateUrlParams({ viewMode: "3d" })}
              style={{
                width: "100%",
                borderRadius: 0,
                border: "1px solid",
                borderColor: currentViewMode === "3d" ? "var(--foreground)" : "var(--border)",
                background: currentViewMode === "3d" ? "var(--foreground)" : "transparent",
                color: currentViewMode === "3d" ? "var(--background)" : "var(--foreground)",
                padding: "6px 12px",
                fontSize: 11,
                cursor: "pointer",
                transition: "all 0.15s ease",
                fontFamily: "var(--font-display)",
              }}
            >
              3D VOLUME RAYMARCHING
            </button>
          </div>
        </div>

        {/* View-mode conditional controls */}
        {currentViewMode === "3d" ? (
          /* 3D Shader Controls */
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Raymarching Opacity
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input
                  type="range"
                  min={0.005}
                  max={0.5}
                  step={0.005}
                  value={localAlphaScale}
                  onChange={(e) => setLocalAlphaScale(Number(e.target.value))}
                  style={{ flex: 1, height: 6, outline: "none", cursor: "pointer", accentColor: "var(--atlas-blue)" }}
                />
                <span style={{ fontFamily: "monospace", fontSize: 12, width: 45, textAlign: "right" }}>
                  {localAlphaScale.toFixed(3)}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                3D Downsample Detail
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {([2, 4, 8] as const).map((factor) => {
                  const label = factor === 2 ? "2x (High Detail)" : factor === 4 ? "4x (Medium Detail)" : "8x (Low Detail)";
                  const isSelected = currentDownsample === factor;
                  return (
                    <button
                      key={factor}
                      onClick={() => updateUrlParams({ downsample: factor })}
                      style={{
                        borderRadius: 0,
                        border: "1px solid",
                        borderColor: isSelected ? "var(--foreground)" : "var(--border)",
                        background: isSelected ? "var(--foreground)" : "transparent",
                        color: isSelected ? "var(--background)" : "var(--foreground)",
                        padding: "6px 10px",
                        fontSize: 11,
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        fontFamily: "var(--font-display)",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Color Lookup Map
              </span>
              <select
                value={currentColormap}
                onChange={(e) => updateUrlParams({ colormap: Number(e.target.value) })}
                className="search-input"
                style={{ padding: "6px 12px", background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 13, outline: "none", cursor: "pointer", fontFamily: "var(--font-display)" }}
              >
                <option value={0}>Grayscale</option>
                <option value={1}>Thermal Heat</option>
                <option value={2}>Viridis (Approx)</option>
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Camera Rotation
              </span>
              <button
                onClick={() => {
                  setLocalPitch(0.0);
                  setLocalYaw(0.0);
                  updateUrlParams({ pitch: "0.000", yaw: "0.000" });
                }}
                style={{
                  width: "100%",
                  borderRadius: 0,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--foreground)",
                  padding: "6px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  fontFamily: "var(--font-display)",
                }}
              >
                Reset Camera View
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32 }}>
              <input
                type="checkbox"
                id="logscale-toggle-3d"
                checked={currentLogScale}
                onChange={(e) => updateUrlParams({ logScale: e.target.checked })}
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="logscale-toggle-3d" style={{ fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)" }}>
                Logarithmic Intensity
              </label>
            </div>
          </div>
        ) : (
          /* 2D Plane Slicing Controls */
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--font-display)", fontWeight: 600 }}>Slicing Plane</span>
              <div style={{ display: "flex", gap: 4 }}>
                {(["z", "y", "x"] as const).map((ax) => {
                  const label = ax === "z" ? "XY" : ax === "y" ? "XZ" : "YZ";
                  const isSelected = currentAxis === ax;
                  return (
                    <button
                      key={ax}
                      onClick={() => updateUrlParams({ axis: ax, slice: 0 })}
                      className={`compare-toggle-btn ${isSelected ? "selected" : ""}`}
                      style={{ border: "1px solid var(--border)", padding: "6px 12px", fontSize: 12, cursor: "pointer", transition: "all 0.1s", flex: 1, fontFamily: "var(--font-display)" }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "var(--font-display)", fontWeight: 600 }}>Color Lookup Map</span>
              <select
                value={currentColormap}
                onChange={(e) => updateUrlParams({ colormap: Number(e.target.value) })}
                className="search-input"
                style={{ padding: "6px 12px", background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 13, outline: "none", cursor: "pointer", fontFamily: "var(--font-display)" }}
              >
                <option value={0}>Grayscale</option>
                <option value={1}>Thermal Heat</option>
                <option value={2}>Viridis (Approx)</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                id="logscale-toggle-2d"
                checked={currentLogScale}
                onChange={(e) => updateUrlParams({ logScale: e.target.checked })}
                style={{ cursor: "pointer" }}
              />
              <label htmlFor="logscale-toggle-2d" style={{ fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)" }}>
                Logarithmic Intensity
              </label>
            </div>

            {/* Slice Scrub Index Slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, fontFamily: "var(--font-display)" }}>
                <span className="muted" style={{ fontWeight: 600 }}>Slice Scrub Index</span>
                <span style={{ color: "var(--atlas-blue-dark)", fontWeight: "bold" }}>
                  {currentSlice + 1} / {maxSlicesForAxis}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={maxSlicesForAxis - 1}
                value={currentSlice}
                onChange={(e) => updateUrlParams({ slice: Number(e.target.value) })}
                style={{ width: "100%", height: 6, outline: "none", cursor: "pointer", accentColor: "var(--atlas-blue)" }}
              />
            </div>
          </div>
        )}

        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "4px 0" }} />

        {/* Rigorous Contrast Range Slider controls */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 11, fontFamily: "var(--font-display)", fontWeight: 600 }}>
            <span className="muted">Rigorous Contrast Range</span>
          </div>
          <span style={{ color: "var(--atlas-orange)", display: "block", fontSize: 10, fontFamily: "monospace", marginBottom: 12 }}>
            [{currentMinContrast} - {currentMaxContrast}] / {maxPossibleIntensity}
          </span>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 10, fontFamily: "var(--font-display)", fontWeight: 600 }}>Min Cutoff</span>
                <input
                  type="number"
                  min={0}
                  max={currentMaxContrast}
                  value={currentMinContrast}
                  onChange={(e) => {
                    const val = Math.max(0, Math.min(Number(e.target.value), currentMaxContrast));
                    updateUrlParams({ minContrast: val });
                  }}
                  style={{ width: 64, textAlign: "right", fontSize: 11, background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", padding: "2px 4px", fontFamily: "monospace" }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={maxPossibleIntensity}
                value={currentMinContrast}
                onChange={(e) => {
                  const val = Math.min(Number(e.target.value), currentMaxContrast);
                  updateUrlParams({ minContrast: val });
                }}
                style={{ width: "100%", height: 4, cursor: "pointer", accentColor: "var(--atlas-blue)" }}
              />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 10, fontFamily: "var(--font-display)", fontWeight: 600 }}>Max Cutoff</span>
                <input
                  type="number"
                  min={currentMinContrast}
                  max={maxPossibleIntensity}
                  value={currentMaxContrast}
                  onChange={(e) => {
                    const val = Math.max(currentMinContrast, Math.min(Number(e.target.value), maxPossibleIntensity));
                    updateUrlParams({ maxContrast: val });
                  }}
                  style={{ width: 64, textAlign: "right", fontSize: 11, background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", padding: "2px 4px", fontFamily: "monospace" }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={maxPossibleIntensity}
                value={currentMaxContrast}
                onChange={(e) => {
                  const val = Math.max(Number(e.target.value), currentMinContrast);
                  updateUrlParams({ maxContrast: val });
                }}
                style={{ width: "100%", height: 4, cursor: "pointer", accentColor: "var(--atlas-blue)" }}
              />
            </div>
          </div>
        </div>
      </aside>

      {/* 2. Center Column: Fluid centering WebGL2 Volumetric Viewer Stage */}
      <section className="cockpit-panel-center">
        {activeDataset && activeDerivative ? (
          <VolumetricViewer
            dataset={activeDataset.slug}
            asset={activeDerivative.source_relative_path}
            zMax={zMax}
            yMax={yMax}
            xMax={xMax}
            physicalVoxelSizeNm={activeDerivative.physical_voxel_size_nm}
            axis={currentAxis}
            slice={Math.min(currentSlice, maxSlicesForAxis - 1)}
            minContrast={currentMinContrast}
            maxContrast={currentMaxContrast}
            logScale={currentLogScale}
            colormap={currentColormap}
            viewMode={currentViewMode}
            downsample={currentDownsample}
            alphaScale={localAlphaScale}
            pitch={localPitch}
            yaw={localYaw}
            onRotationChange={handleRotationChange}
            onLoadedMetadata={handleLoadedMetadata}
            onProbeChange={setActiveProbe}
            onSliceLoaded={handleSliceLoaded}
          />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#050505" }}>
            <span className="muted" style={{ fontFamily: "var(--font-display)" }}>No active 3D volume derivative has been indexed.</span>
          </div>
        )}
      </section>

      {/* 3. Right Column: Quantitative Stateful Ledger Panel */}
      <aside className="cockpit-panel-right">
        <div className="figure-plate-header" style={{ marginBottom: 16, paddingBottom: 10 }}>
          <div>
            <span className="kicker" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {activeDataset?.source} {activeDataset?.entryId}
            </span>
            <h2 style={{ fontSize: "1.25rem", fontFamily: "var(--font-body)", fontWeight: "normal", margin: "4px 0", lineHeight: 1.25, color: "var(--foreground)" }}>
              {activeDataset?.title}
            </h2>
          </div>
          <div className="figure-number" style={{ color: "var(--atlas-blue-dark)", fontSize: 10 }}>
            LEDGER
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="analytics-tabs-nav">
          <button
            className={`analytics-tab-btn ${activeTab === "telemetry" ? "active" : ""}`}
            onClick={() => setActiveTab("telemetry")}
          >
            Telemetry & Histogram
          </button>
          <button
            className={`analytics-tab-btn ${activeTab === "image-notes" ? "active" : ""}`}
            onClick={() => setActiveTab("image-notes")}
          >
            Image Notes
          </button>
          <button
            className={`analytics-tab-btn ${activeTab === "planner" ? "active" : ""}`}
            onClick={() => setActiveTab("planner")}
          >
            Planner
          </button>
        </div>

        {/* Tab 1: Telemetry */}
        {activeTab === "telemetry" && (
          <div className="tab-pane">
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  3D Spatial Boundary
                </span>
                <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {zMax} x {yMax} x {xMax} voxels ({activeDerivative?.dtype || "uint8"})
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Grid Volume
                  </span>
                  <strong style={{ fontSize: 12.5, color: "var(--atlas-blue-dark)", fontFamily: "monospace" }}>
                    {totalVolumeUm3.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} µm³
                  </strong>
                </div>
                <div>
                  <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                    Slice Area
                  </span>
                  <strong style={{ fontSize: 12.5, color: "var(--atlas-blue-dark)", fontFamily: "monospace" }}>
                    {activeSliceAreaUm2.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} µm²
                  </strong>
                </div>
              </div>

              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Microscope Spacing
                </span>
                <span style={{ fontFamily: "monospace", fontSize: 11.5 }}>
                  dx: {voxelSizeX} nm | dy: {voxelSizeY} nm | dz: {voxelSizeZ} nm
                </span>
              </div>

              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Calibrated Probe Readout
                </span>
                {activeProbe ? (
                  <div style={{ background: "rgba(0, 0, 0, 0.15)", padding: "8px 12px", border: "1px solid var(--border)" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11, fontFamily: "monospace" }}>
                      <div>
                        <span style={{ color: "var(--accent-foreground)" }}>Pixel:</span>
                        <span style={{ marginLeft: 4 }}>({activeProbe.px}, {activeProbe.py}, {activeProbe.pz})</span>
                      </div>
                      <div>
                        <span style={{ color: "var(--accent-foreground)" }}>Value:</span>
                        <span style={{ marginLeft: 4, fontWeight: "bold", color: "var(--atlas-orange)" }}>{activeProbe.val}</span>
                      </div>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, fontFamily: "monospace", borderTop: "1px solid var(--border)", paddingTop: 4 }}>
                      <span style={{ color: "var(--accent-foreground)" }}>Physical Position:</span>
                      <div style={{ color: "var(--foreground)", fontWeight: "bold", fontSize: 11.5, marginTop: 2 }}>
                        X: {activeProbe.xUm.toFixed(3)} µm | Y: {activeProbe.yUm.toFixed(3)} µm | Z: {activeProbe.zUm.toFixed(3)} µm
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontStyle: "italic", fontSize: 12, color: "var(--accent-foreground)", padding: "4px 0", fontFamily: "var(--font-body)" }}>
                    Hover cursor over WebGL2 slice canvas to probe calibrated physical values.
                  </div>
                )}
              </div>

              <div>
                <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                  Voxel Logarithmic Histogram
                </span>
                <div style={{ background: "#050505", border: "1px solid var(--border)", padding: 8, position: "relative" }}>
                  {histogramData.every(x => x === 0) ? (
                    <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontFamily: "monospace", color: "#666" }}>
                      Loading histogram buffers...
                    </div>
                  ) : (
                    <svg width="100%" height="80" viewBox="0 0 300 80" preserveAspectRatio="none" style={{ display: "block" }}>
                      <line x1="75" y1="0" x2="75" y2="80" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <line x1="150" y1="0" x2="150" y2="80" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <line x1="225" y1="0" x2="225" y2="80" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <line x1="0" y1="40" x2="300" y2="40" stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                      <path
                        d={svgPath}
                        fill="rgba(22, 139, 179, 0.25)"
                        stroke="var(--atlas-blue)"
                        strokeWidth="1.5"
                      />
                    </svg>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "monospace", color: "#888", marginTop: 4 }}>
                    <span>0 (Low)</span>
                    <span>{maxPossibleIntensity} (High)</span>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              <h3 className="kicker" style={{ fontSize: 10, marginBottom: 8, letterSpacing: "0.08em" }}>
                Scientific Data Reuse Notes
              </h3>

              {activeFindings.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: 11.5, fontStyle: "italic", fontFamily: "var(--font-body)" }}>
                  No calibration findings or caveats indexed for this volume. Direct measurements carry full standard error.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {activeFindings.map((finding) => {
                    const isCritical = finding.severity.toLowerCase() === "critical";
                    const isWarning = finding.severity.toLowerCase() === "warning" || finding.severity.toLowerCase() === "review";
                    
                    let bg = "rgba(0,0,0,0.02)";
                    let borderCol = "var(--border)";
                    let titleCol = "var(--foreground)";
                    if (isCritical) {
                      bg = "rgba(198, 111, 45, 0.04)";
                      borderCol = "rgba(198, 111, 45, 0.3)";
                      titleCol = "var(--atlas-orange)";
                    } else if (isWarning) {
                      bg = "rgba(22, 139, 179, 0.03)";
                      borderCol = "rgba(22, 139, 179, 0.3)";
                      titleCol = "var(--atlas-blue-dark)";
                    }

                    return (
                      <article
                        key={finding.finding_id}
                        className="panel"
                        style={{
                          background: bg,
                          border: `1px solid ${borderCol}`,
                          padding: "10px 14px",
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "bold", color: titleCol, fontFamily: "var(--font-display)" }}>
                            {finding.severity} · {finding.category}
                          </span>
                          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#666" }}>
                            {finding.finding_id}
                          </span>
                        </div>
                        <strong style={{ display: "block", fontSize: 11, marginBottom: 4, fontFamily: "var(--font-display)" }}>
                          {finding.asset_relative_path ? finding.asset_relative_path.split("/").pop() : "Dataset-level calibration"}
                        </strong>
                        <p className="muted" style={{ margin: "0 0 6px 0", lineHeight: 1.4, fontSize: 11.5, fontFamily: "var(--font-body)" }}>
                          {finding.summary}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Image notes */}
        {activeTab === "image-notes" && (
          <div className="tab-pane">
            <div>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Image Analysis Status
              </span>
              <h3 style={{ fontSize: "1.05rem", fontWeight: "bold", margin: "0 0 8px 0", fontFamily: "var(--font-display)" }}>
                Texture Features Not Yet Connected
              </h3>
              <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                This workbench currently exposes raw volume navigation, calibrated probe values, and sidecar-backed corpus planning. Learned image embeddings or similarity rankings should only appear here after a real model pipeline is wired into the sidecar.
              </p>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Current Volume Context
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12, fontFamily: "monospace", background: "rgba(0,0,0,0.15)", padding: "10px 12px", border: "1px solid var(--border)" }}>
                <div>
                  <div style={{ color: "var(--accent-foreground)", fontSize: 9, fontFamily: "var(--font-display)", fontWeight: 600 }}>ACTIVE DATASET</div>
                  <div style={{ fontWeight: "bold", marginTop: 2, overflowWrap: "anywhere" }}>{activeDataset?.slug}</div>
                  <div style={{ color: "#888", fontSize: 9, marginTop: 1 }}>{activeDataset?.source} {activeDataset?.entryId}</div>
                </div>
                <div>
                  <div style={{ color: "var(--accent-foreground)", fontSize: 9, fontFamily: "var(--font-display)", fontWeight: 600 }}>ACTIVE ASSET</div>
                  <div style={{ fontWeight: "bold", marginTop: 2, overflowWrap: "anywhere" }}>{activeDerivative?.source_relative_path.split("/").pop()}</div>
                  <div style={{ color: "#888", fontSize: 9, marginTop: 1 }}>{activeDerivative?.dtype} | {zMax} x {yMax} x {xMax}</div>
                </div>
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Next Analysis Hook
              </span>
              <p className="muted" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                The correct next step is a sidecar endpoint that returns model name, version, feature vector metadata, and ranked matches from actual indexed data. Until then, this panel stays descriptive instead of presenting fabricated similarity scores.
              </p>
            </div>
          </div>
        )}

        {/* Tab 3: Experiment Planner */}
        {activeTab === "planner" && (
          <div className="tab-pane">
            <div>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Live Feasibility Calculator
              </span>
              <h3 style={{ fontSize: "1.05rem", fontWeight: "bold", margin: "0 0 8px 0", fontFamily: "var(--font-display)" }}>
                Biological Experiment Planner
              </h3>
              <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-body)" }}>
                Query sidecar plan registry to assess specimen feasibility based on active resolution thresholds and target organelle structures.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                  Target Organelle Markers
                </label>
                <input
                  type="text"
                  className="search-input"
                  style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                  value={planningOrganelles}
                  onChange={(e) => {
                    setPlanningOrganelles(e.target.value);
                    setPlanningResult(null);
                    setPlanningError(null);
                  }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                    Max Res (nm)
                  </label>
                  <input
                    type="number"
                    className="search-input"
                    style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                    value={planningRes}
                    onChange={(e) => {
                      setPlanningRes(Number(e.target.value));
                      setPlanningResult(null);
                      setPlanningError(null);
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                    Min Size (n)
                  </label>
                  <input
                    type="number"
                    className="search-input"
                    style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                    value={planningSample}
                    onChange={(e) => {
                      setPlanningSample(Number(e.target.value));
                      setPlanningResult(null);
                      setPlanningError(null);
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontWeight: "bold", fontFamily: "var(--font-display)" }}>
                  Cell Line Type
                </label>
                <select
                  className="search-input"
                  style={{ width: "100%", padding: "5px 10px", fontSize: 12, background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", fontFamily: "var(--font-display)" }}
                  value={planningCellType}
                  onChange={(e) => {
                    setPlanningCellType(e.target.value);
                    setPlanningResult(null);
                    setPlanningError(null);
                  }}
                >
                  <option value="hiPSC">Human iPSC (hiPSC)</option>
                  <option value="HEK293">HEK293</option>
                  <option value="HeLa">HeLa</option>
                  <option value="RAW264">RAW264.7</option>
                </select>
              </div>

              <button
                type="button"
                className="button"
                disabled={planningLoading}
                onClick={fetchPlanningResult}
                style={{ width: "100%", padding: "7px 12px", fontSize: 11, fontFamily: "var(--font-display)" }}
              >
                {planningLoading ? "Running..." : "Run Feasibility Check"}
              </button>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Feasibility Grade Readout
              </span>

              {planningLoading ? (
                <div style={{ padding: "16px 0", textAlign: "center", fontSize: 12, fontFamily: "monospace", color: "var(--atlas-blue)" }}>
                  Querying sidecar plan registry...
                </div>
              ) : planningError ? (
                <div style={{ color: "var(--atlas-orange)", fontSize: 12, fontFamily: "monospace" }}>
                  Error: {planningError}
                </div>
              ) : planningResult ? (
                <div>
                  <div
                    style={{
                      background:
                        planningResult.status === "feasible"
                          ? "rgba(85, 184, 211, 0.05)"
                          : planningResult.status === "challenging"
                          ? "rgba(22, 139, 179, 0.04)"
                          : "rgba(198, 111, 45, 0.04)",
                      border: `1px solid ${
                        planningResult.status === "feasible"
                          ? "rgba(85, 184, 211, 0.4)"
                          : "rgba(198, 111, 45, 0.3)"
                      }`,
                      padding: "10px 14px",
                      marginBottom: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--foreground)", fontFamily: "var(--font-display)" }}>
                        STATUS: {planningResult.status}
                      </span>
                      <span style={{ fontSize: 9, fontFamily: "monospace", color: "#888" }}>
                        API ROUTE APPROVED
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.4, fontFamily: "var(--font-body)" }}>
                      {planningResult.status_message}
                    </p>
                  </div>

                  <div style={{ fontSize: 11.5, fontFamily: "monospace", background: "rgba(0,0,0,0.1)", border: "1px solid var(--border)", padding: "8px 12px" }}>
                    <div style={{ fontWeight: "bold", fontSize: 10, textTransform: "uppercase", color: "var(--accent-foreground)", marginBottom: 4, fontFamily: "var(--font-display)" }}>
                      Modality Recommendations
                    </div>
                    {planningResult.modality_recommendation}
                  </div>

                  {planningResult.precedents && planningResult.precedents.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <span className="muted" style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, fontFamily: "var(--font-display)", fontWeight: 600 }}>
                        Baseline Reference Precedents
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {planningResult.precedents.slice(0, 2).map((p: any, idx: number) => (
                          <div key={idx} style={{ padding: "8px 10px", background: "rgba(0,0,0,0.04)", border: "1px solid var(--border)", fontSize: 11, fontFamily: "monospace" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
                              <span>{p.source} {p.entry_id}</span>
                              <span style={{ color: "var(--atlas-blue)" }}>{p.lateral_resolution_nm} nm</span>
                            </div>
                            <div style={{ color: "#888", fontSize: 9, marginTop: 2 }}>
                              {p.cell_type} | Modal: {p.modality} | Size: n={p.sample_size}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontStyle: "italic", fontSize: 12, color: "#666", fontFamily: "var(--font-body)" }}>
                  Set planning inputs above, then run a feasibility check.
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
