"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";

type DataPoint = {
  id: string;
  title: string;
  res: number;
  ss: number;
  modality: string;
};

type TimelineData = {
  matrix: Record<number, Record<string, number>>;
  years: number[];
  modality_families: string[];
  year_totals: Record<number, number>;
  public_counts: Record<number, number>;
};

type Props = {
  data: DataPoint[];
  timeline?: TimelineData | null;
};

type ViewMode = "frontier" | "records" | "public";

export function FrontierPlot({ data, timeline }: Props) {
  const [hovered, setHovered] = useState<DataPoint | null>(null);
  const [mode, setMode] = useState<ViewMode>("frontier");
  const router = useRouter();

  const width = 800;
  const height = 400;
  const margin = { top: 20, right: 20, bottom: 50, left: 60 };
  const xMin = 0.1;
  const xMax = Math.max(...data.map(d => d.res), 400);
  const yMin = 1;
  const yMax = Math.max(...data.map(d => d.ss), 250);
  const logXMin = Math.log10(xMin);
  const logXMax = Math.log10(xMax);
  const logYMin = Math.log10(yMin);
  const logYMax = Math.log10(yMax);
  const hasTimeline = Boolean(timeline?.years.length);

  const getX = (res: number) => {
    const val = Math.log10(Math.max(res, xMin));
    return margin.left + ((val - logXMin) / (logXMax - logXMin)) * (width - margin.left - margin.right);
  };

  const getY = (ss: number) => {
    const val = Math.log10(Math.max(ss, yMin));
    return height - margin.bottom - ((val - logYMin) / (logYMax - logYMin)) * (height - margin.top - margin.bottom);
  };

  const getColor = (modality: string) => {
    switch (modality.toLowerCase()) {
      case "em": return "var(--atlas-blue)";
      case "x-ray": return "var(--atlas-green)";
      case "optical": return "var(--atlas-orange)";
      default: return "var(--accent-foreground)";
    }
  };

  const ticksX = [1, 10, 100, 400];
  const ticksY = [1, 10, 100, 250];
  const timelineWidth = width;
  const timelineHeight = height;
  const timelineMargin = margin;
  const timelinePlotWidth = timelineWidth - timelineMargin.left - timelineMargin.right;
  const timelinePlotHeight = timelineHeight - timelineMargin.top - timelineMargin.bottom;
  const timelineBottom = timelineMargin.top + timelinePlotHeight;
  const maxYearTotal = timeline
    ? Math.max(1, ...timeline.years.map((year) => timeline.year_totals[year] || 0))
    : 1;
  const yearStep = timeline?.years.length
    ? timelinePlotWidth / Math.max(1, timeline.years.length)
    : timelinePlotWidth;
  const barWidth = Math.max(6, Math.min(22, yearStep * 0.62));
  const yearLabelInterval = timeline?.years.length
    ? Math.max(1, Math.ceil(timeline.years.length / 10))
    : 1;
  const getTimelineX = (index: number) =>
    timelineMargin.left + index * yearStep + (yearStep - barWidth) / 2;
  const getTimelineY = (value: number) =>
    timelineBottom - (value / maxYearTotal) * timelinePlotHeight;
  const getShareY = (ratio: number) =>
    timelineBottom - ratio * timelinePlotHeight;
  const publicSharePoints = timeline
    ? timeline.years
        .map((year, index) => {
          const total = timeline.year_totals[year] || 0;
          const publicCount = timeline.public_counts[year] || 0;
          const ratio = total ? publicCount / total : 0;
          return `${getTimelineX(index) + barWidth / 2},${getShareY(ratio)}`;
        })
        .join(" ")
    : "";
  const viewCopy: Record<ViewMode, string> = {
    frontier: "Resolution and whole-cell count by record, fixed to log-log because the corpus spans orders of magnitude.",
    records: "Annual corpus volume by imaging family. Click a bar segment to inspect that year and modality family.",
    public: "Annual public-data share. Blue bars show public-data records; the line shows public records as a share of yearly total."
  };

  const renderFrontier = () => (
    <>
      <svg 
        viewBox={`0 0 ${width} ${height}`} 
        style={{ width: "100%", height: "auto", overflow: "visible" }}
      >
        <rect
          x={margin.left}
          y={margin.top}
          width={width - margin.left - margin.right}
          height={height - margin.top - margin.bottom}
          fill="transparent"
          stroke="rgba(23, 21, 17, 0.1)"
        />

        {ticksX.map(t => (
          <line
            key={`grid-x-${t}`}
            x1={getX(t)}
            y1={margin.top}
            x2={getX(t)}
            y2={height - margin.bottom}
            stroke="rgba(23, 21, 17, 0.055)"
            strokeWidth="1"
          />
        ))}
        {ticksY.map(t => (
          <line
            key={`grid-y-${t}`}
            x1={margin.left}
            y1={getY(t)}
            x2={width - margin.right}
            y2={getY(t)}
            stroke="rgba(23, 21, 17, 0.055)"
            strokeWidth="1"
          />
        ))}

        <line x1={margin.left} y1={height - margin.bottom} x2={width - margin.right} y2={height - margin.bottom} stroke="var(--rule-strong)" strokeWidth="1.2" />
        <line x1={margin.left} y1={margin.top} x2={margin.left} y2={height - margin.bottom} stroke="var(--rule-strong)" strokeWidth="1.2" />

        {ticksX.map(t => (
          <g key={t}>
            <line x1={getX(t)} y1={height - margin.bottom} x2={getX(t)} y2={height - margin.bottom + 5} stroke="var(--rule-strong)" />
            <text x={getX(t)} y={height - margin.bottom + 20} textAnchor="middle" fontSize="12" fill="var(--accent-foreground)" fontFamily="inherit">{t}nm</text>
          </g>
        ))}
        <text x={width / 2} y={height - 5} textAnchor="middle" fontSize="13" fontWeight="500" fill="var(--foreground)" fontFamily="var(--font-display)" letterSpacing="0.06em">Resolution (nm, Log Scale)</text>

        {ticksY.map(t => (
          <g key={t}>
            <line x1={margin.left - 5} y1={getY(t)} x2={margin.left} y2={getY(t)} stroke="var(--rule-strong)" />
            <text x={margin.left - 10} y={getY(t) + 4} textAnchor="end" fontSize="12" fill="var(--accent-foreground)" fontFamily="inherit">{t}</text>
          </g>
        ))}
        <text x={15} y={height / 2} textAnchor="middle" fontSize="13" fontWeight="500" fill="var(--foreground)" transform={`rotate(-90, 15, ${height / 2})`} fontFamily="var(--font-display)" letterSpacing="0.06em">Whole-Cell Count (Log Scale)</text>

        {data.map(d => {
          const size = hovered?.id === d.id ? 11 : 7;
          return (
            <rect
              key={d.id}
              x={getX(d.res) - size / 2}
              y={getY(d.ss) - size / 2}
              width={size}
              height={size}
              fill={getColor(d.modality)}
              opacity={hovered && hovered.id !== d.id ? 0.25 : 0.86}
              stroke={hovered?.id === d.id ? "var(--foreground)" : "var(--background)"}
              strokeWidth={hovered?.id === d.id ? "2" : "1"}
              style={{ cursor: "pointer", transition: "all 0.2s" }}
              onMouseEnter={() => setHovered(d)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => router.push(`/datasets/${d.id}`)}
            />
          );
        })}
      </svg>

      {hovered && (
        <div style={{
          position: "absolute",
          top: getY(hovered.ss) - 60,
          left: getX(hovered.res),
          transform: "translateX(-50%)",
          background: "var(--foreground)",
          color: "var(--background)",
          padding: "8px 12px",
          borderRadius: 0,
          fontSize: "0.85rem",
          pointerEvents: "none",
          zIndex: 10,
          whiteSpace: "nowrap",
          border: "1px solid var(--foreground)"
        }}>
          <strong>{hovered.title}</strong><br/>
          {hovered.res}nm · {hovered.ss} cells
        </div>
      )}
    </>
  );

  const renderRecordsOverTime = () => {
    if (!timeline) return null;

    return (
      <svg
        viewBox={`0 0 ${timelineWidth} ${timelineHeight}`}
        className="frontier-timeline-chart"
        role="img"
        aria-label="Annual corpus records by modality family"
      >
        <line x1={timelineMargin.left} y1={timelineBottom} x2={timelineWidth - timelineMargin.right} y2={timelineBottom} stroke="var(--rule-strong)" strokeWidth="1.2" />
        <line x1={timelineMargin.left} y1={timelineMargin.top} x2={timelineMargin.left} y2={timelineBottom} stroke="var(--rule-strong)" strokeWidth="1.2" />

        {[0.25, 0.5, 0.75, 1].map((tick) => {
          const value = Math.round(tick * maxYearTotal);
          const y = getTimelineY(value);

          return (
            <g key={tick}>
              <line x1={timelineMargin.left} y1={y} x2={timelineWidth - timelineMargin.right} y2={y} stroke="var(--rule-faint)" />
              <text x={timelineMargin.left - 8} y={y + 4} textAnchor="end" className="frontier-timeline-tick">{value}</text>
            </g>
          );
        })}

        {timeline.years.map((year, index) => {
          const x = getTimelineX(index);
          const showLabel = index % yearLabelInterval === 0 || index === timeline.years.length - 1;
          let yCursor = timelineBottom;

          return (
            <g key={year}>
              {timeline.modality_families.map((family) => {
                const count = timeline.matrix[year]?.[family] || 0;
                if (count === 0) return null;
                const barHeight = (count / maxYearTotal) * timelinePlotHeight;
                yCursor -= barHeight;

                return (
                  <a key={family} href={`/corpus?year=${year}&family=${encodeURIComponent(family)}`}>
                    <title>{`${year} · ${family}: ${count} records`}</title>
                    <rect
                      x={x}
                      y={yCursor}
                      width={barWidth}
                      height={Math.max(1, barHeight)}
                      fill={getColor(family)}
                      className="frontier-timeline-bar"
                    />
                  </a>
                );
              })}
              {showLabel ? (
                <text x={x + barWidth / 2} y={timelineBottom + 20} textAnchor="middle" className="frontier-timeline-tick">
                  {year}
                </text>
              ) : null}
            </g>
          );
        })}

        <text x={timelineWidth / 2} y={timelineHeight - 8} textAnchor="middle" className="frontier-timeline-axis-label">Publication Year</text>
        <text x={18} y={timelineHeight / 2} textAnchor="middle" transform={`rotate(-90, 18, ${timelineHeight / 2})`} className="frontier-timeline-axis-label">Records</text>
      </svg>
    );
  };

  const renderPublicDataShare = () => {
    if (!timeline) return null;

    return (
      <svg
        viewBox={`0 0 ${timelineWidth} ${timelineHeight}`}
        className="frontier-timeline-chart"
        role="img"
        aria-label="Annual public-data share"
      >
        <line x1={timelineMargin.left} y1={timelineBottom} x2={timelineWidth - timelineMargin.right} y2={timelineBottom} stroke="var(--rule-strong)" strokeWidth="1.2" />
        <line x1={timelineMargin.left} y1={timelineMargin.top} x2={timelineMargin.left} y2={timelineBottom} stroke="var(--rule-strong)" strokeWidth="1.2" />

        {[0.25, 0.5, 0.75, 1].map((tick) => {
          const y = getShareY(tick);

          return (
            <g key={tick}>
              <line x1={timelineMargin.left} y1={y} x2={timelineWidth - timelineMargin.right} y2={y} stroke="var(--rule-faint)" />
              <text x={timelineMargin.left - 8} y={y + 4} textAnchor="end" className="frontier-timeline-tick">{Math.round(tick * 100)}%</text>
            </g>
          );
        })}

        {timeline.years.map((year, index) => {
          const total = timeline.year_totals[year] || 0;
          const publicCount = timeline.public_counts[year] || 0;
          const publicHeight = total ? (publicCount / total) * timelinePlotHeight : 0;
          const x = getTimelineX(index);
          const showLabel = index % yearLabelInterval === 0 || index === timeline.years.length - 1;

          return (
            <g key={year}>
              <a href={`/corpus?year=${year}&public=true`}>
                <title>{`${year}: ${publicCount} public-data records out of ${total}`}</title>
                <rect
                  x={x}
                  y={timelineBottom - publicHeight}
                  width={barWidth}
                  height={Math.max(1, publicHeight)}
                  className="frontier-public-bar"
                />
              </a>
              {showLabel ? (
                <text x={x + barWidth / 2} y={timelineBottom + 20} textAnchor="middle" className="frontier-timeline-tick">
                  {year}
                </text>
              ) : null}
            </g>
          );
        })}

        <polyline points={publicSharePoints} className="frontier-public-line" />
        <text x={timelineWidth / 2} y={timelineHeight - 8} textAnchor="middle" className="frontier-timeline-axis-label">Publication Year</text>
        <text x={18} y={timelineHeight / 2} textAnchor="middle" transform={`rotate(-90, 18, ${timelineHeight / 2})`} className="frontier-timeline-axis-label">Public-Data Share</text>
      </svg>
    );
  };

  return (
    <div className="plot-shell">
      <div className="plot-control-bar">
        <div className="plot-control-group">
          <span className="muted">View:</span>
          <button className={`pill ${mode === "frontier" ? "selected" : ""}`} onClick={() => setMode("frontier")} style={{ padding: "2px 8px", fontFamily: "inherit", cursor: "pointer" }}>Frontier</button>
          {hasTimeline ? (
            <>
              <button className={`pill ${mode === "records" ? "selected" : ""}`} onClick={() => setMode("records")} style={{ padding: "2px 8px", fontFamily: "inherit", cursor: "pointer" }}>Records Over Time</button>
              <button className={`pill ${mode === "public" ? "selected" : ""}`} onClick={() => setMode("public")} style={{ padding: "2px 8px", fontFamily: "inherit", cursor: "pointer" }}>Public Data Share</button>
            </>
          ) : null}
        </div>
      </div>

      <p className="plot-mode-copy">{viewCopy[mode]}</p>

      {mode === "frontier" ? renderFrontier() : null}
      {mode === "records" && hasTimeline ? renderRecordsOverTime() : null}
      {mode === "public" && hasTimeline ? renderPublicDataShare() : null}

      <div className="plot-legend">
        <div className="plot-legend-item" style={{ color: "var(--atlas-blue)" }}>
          <div className="plot-legend-swatch" style={{ background: "var(--atlas-blue)" }} /> EM
        </div>
        <div className="plot-legend-item" style={{ color: "var(--atlas-green)" }}>
          <div className="plot-legend-swatch" style={{ background: "var(--atlas-green)" }} /> X-Ray
        </div>
        <div className="plot-legend-item" style={{ color: "var(--atlas-orange)" }}>
          <div className="plot-legend-swatch" style={{ background: "var(--atlas-orange)" }} /> Optical
        </div>
        {mode === "public" ? (
          <div className="plot-legend-item" style={{ color: "var(--atlas-blue-dark)" }}>
            <div className="plot-legend-swatch" style={{ background: "var(--atlas-blue-dark)" }} /> Share Line
          </div>
        ) : null}
      </div>
    </div>
  );
}
