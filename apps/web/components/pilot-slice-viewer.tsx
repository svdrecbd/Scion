"use client";

import { useEffect, useRef, useState } from "react";

type SliceFrame = {
  sequenceIndex: number;
  zIndex: number;
  href: string;
  width: number;
  height: number;
};

type PilotSliceViewerProps = {
  title: string;
  sourceRelativePath: string;
  sourceShapeZyx: number[];
  physicalVoxelSizeNm: Record<string, string | number>;
  samplingMode: string;
  sourceSlices: number;
  contrastMode: string;
  contrastNote: string;
  frames: SliceFrame[];
};

function valueLabel(value: string | number | undefined): string {
  if (value === undefined || value === "") return "unknown";
  return String(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function prioritizedIndices(length: number, center: number): number[] {
  const safeCenter = clamp(center, 0, Math.max(length - 1, 0));
  const indices: number[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const before = safeCenter - offset;
    const after = safeCenter + offset;
    if (before >= 0) indices.push(before);
    if (offset > 0 && after < length) indices.push(after);
  }
  return indices;
}

export function PilotSliceViewer({
  title,
  sourceRelativePath,
  sourceShapeZyx,
  physicalVoxelSizeNm,
  samplingMode,
  sourceSlices,
  contrastMode,
  contrastNote,
  frames,
}: PilotSliceViewerProps) {
  const [frameIndex, setFrameIndex] = useState(Math.floor(frames.length / 2));
  const warmedFrames = useRef<Set<string>>(new Set());
  const [warmedFrameCount, setWarmedFrameCount] = useState(0);
  const [warmupComplete, setWarmupComplete] = useState(frames.length <= 1);
  const frame = frames[frameIndex] || frames[0];
  const isSampled = samplingMode !== "all" && frames.length < sourceSlices;

  useEffect(() => {
    warmedFrames.current.clear();
    setWarmedFrameCount(0);
    setWarmupComplete(frames.length <= 1);
  }, [frames]);

  useEffect(() => {
    if (frames.length === 0) return;
    let cancelled = false;
    let cursor = 0;
    const concurrency = Math.min(4, frames.length);
    const orderedFrames = prioritizedIndices(frames.length, frameIndex).map((index) => frames[index]);

    function markWarmed(href: string) {
      if (cancelled || warmedFrames.current.has(href)) return;
      warmedFrames.current.add(href);
      setWarmedFrameCount(warmedFrames.current.size);
      if (warmedFrames.current.size >= frames.length) {
        setWarmupComplete(true);
      }
    }

    function preloadFrame(href: string): Promise<void> {
      if (warmedFrames.current.has(href)) return Promise.resolve();
      return new Promise((resolve) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => {
          markWarmed(href);
          resolve();
        };
        image.onerror = () => {
          resolve();
        };
        image.src = href;
      });
    }

    async function worker() {
      while (!cancelled && cursor < orderedFrames.length) {
        const nextFrame = orderedFrames[cursor];
        cursor += 1;
        await preloadFrame(nextFrame.href);
      }
    }

    const start = window.setTimeout(() => {
      void Promise.all(Array.from({ length: concurrency }, worker));
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(start);
    };
  }, [frameIndex, frames]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;

      if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        setFrameIndex((index) => clamp(index + 1, 0, frames.length - 1));
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        setFrameIndex((index) => clamp(index - 1, 0, frames.length - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        setFrameIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setFrameIndex(frames.length - 1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [frames.length]);

  if (!frame) {
    return (
      <section className="panel">
        <h2 className="section-title">Slice Viewer</h2>
        <p className="muted">No cached frames exist for this asset.</p>
      </section>
    );
  }

  return (
    <section className="slice-viewer">
      <div className="slice-viewer-toolbar">
        <div>
          <div className="kicker">Scion Slice Viewer</div>
          <h1>{title}</h1>
          <p>{sourceRelativePath}</p>
        </div>
        <div className="slice-viewer-readout">
          <span>Source z {frame.zIndex + 1} / {sourceSlices}</span>
          <span>Cached plane {frameIndex + 1} / {frames.length}</span>
          <span>{sourceShapeZyx.join(" x ")} z/y/x</span>
        </div>
      </div>

      {isSampled ? (
        <div className="slice-viewer-warning">
          Sampled cache: this viewer is showing {frames.length} representative planes from {sourceSlices} source slices.
        </div>
      ) : null}

      <div className="slice-viewer-stage-wrap">
        <div className="slice-viewer-stage">
          <div className="slice-viewer-image-frame">
            <img
              src={frame.href}
              alt={`${sourceRelativePath} z slice ${frame.zIndex + 1}`}
              width={frame.width}
              height={frame.height}
              onLoad={() => {
                if (!warmedFrames.current.has(frame.href)) {
                  warmedFrames.current.add(frame.href);
                  setWarmedFrameCount(warmedFrames.current.size);
                }
              }}
            />
          </div>
        </div>
      </div>

      <div className="slice-viewer-controls">
        <label htmlFor="slice-frame">
          Plane {frameIndex + 1} of {frames.length}
        </label>
        <input
          id="slice-frame"
          type="range"
          min="0"
          max={Math.max(frames.length - 1, 0)}
          value={frameIndex}
          onChange={(event) => setFrameIndex(Number(event.target.value))}
        />
      </div>

      <div className="slice-viewer-ledger">
        <span>Actual z-index: {frame.zIndex}</span>
        <span>Sampling: {samplingMode} from {sourceSlices} source slices</span>
        <span>
          Scale: {valueLabel(physicalVoxelSizeNm.x)} x {valueLabel(physicalVoxelSizeNm.y)} x{" "}
          {valueLabel(physicalVoxelSizeNm.z)} nm
        </span>
        <span>Contrast: {contrastMode.replaceAll("_", " ")}. {contrastNote}</span>
        <span>
          Frame cache: {warmupComplete ? "ready" : `warming ${warmedFrameCount}/${frames.length}`}
        </span>
        <span>Keyboard: ←/→ step, Home/End jump.</span>
      </div>
    </section>
  );
}
