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

type Props = {
  data: DataPoint[];
};

export function FrontierPlot({ data }: Props) {
  const [hovered, setHovered] = useState<DataPoint | null>(null);
  const [scaleX, setScaleX] = useState<"log" | "linear">("log");
  const [scaleY, setScaleY] = useState<"log" | "linear">("linear");
  const router = useRouter();

  // SVG dimensions
  const width = 800;
  const height = 400;
  const margin = { top: 20, right: 20, bottom: 50, left: 60 };

  // Calculate scales
  const xMin = scaleX === "log" ? 0.1 : 0;
  const xMax = Math.max(...data.map(d => d.res), 400);
  const yMin = scaleY === "log" ? 1 : 0;
  const yMax = Math.max(...data.map(d => d.ss), 250);

  const getX = (res: number) => {
    if (scaleX === "log") {
      const logMin = Math.log10(xMin);
      const logMax = Math.log10(xMax);
      const val = Math.log10(Math.max(res, xMin));
      return margin.left + ((val - logMin) / (logMax - logMin)) * (width - margin.left - margin.right);
    }
    return margin.left + ((res - xMin) / (xMax - xMin)) * (width - margin.left - margin.right);
  };

  const getY = (ss: number) => {
    if (scaleY === "log") {
      const logMin = Math.log10(yMin);
      const logMax = Math.log10(yMax);
      const val = Math.log10(Math.max(ss, yMin));
      return height - margin.bottom - ((val - logMin) / (logMax - logMin)) * (height - margin.top - margin.bottom);
    }
    return height - margin.bottom - ((ss - yMin) / (yMax - yMin)) * (height - margin.top - margin.bottom);
  };

  const getColor = (modality: string) => {
    switch (modality.toLowerCase()) {
      case "em": return "#2e7d32";
      case "x-ray": return "#1976d2";
      case "optical": return "#ed6c02";
      default: return "#666";
    }
  };

  const ticksX = scaleX === "log" ? [1, 10, 100, 400] : [0, 100, 200, 300, 400];
  const ticksY = scaleY === "log" ? [1, 10, 100, 250] : [0, 50, 100, 150, 200, 250];

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: `${width}px`, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: "16px", marginBottom: "16px", justifyContent: "flex-end" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem" }}>
          <span className="muted">X-Axis:</span>
          <button className={`pill ${scaleX === "log" ? "selected" : ""}`} onClick={() => setScaleX("log")} style={{ padding: "2px 8px", fontFamily: "inherit", cursor: "pointer" }}>Log</button>
          <button className={`pill ${scaleX === "linear" ? "selected" : ""}`} onClick={() => setScaleX("linear")} style={{ padding: "2px 8px", fontFamily: "inherit", cursor: "pointer" }}>Linear</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem" }}>
          <span className="muted">Y-Axis:</span>
          <button className={`pill ${scaleY === "log" ? "selected" : ""}`} onClick={() => setScaleY("log")} style={{ padding: "2px 8px", fontFamily: "inherit", cursor: "pointer" }}>Log</button>
          <button className={`pill ${scaleY === "linear" ? "selected" : ""}`} onClick={() => setScaleY("linear")} style={{ padding: "2px 8px", fontFamily: "inherit", cursor: "pointer" }}>Linear</button>
        </div>
      </div>
      
      <svg 
        viewBox={`0 0 ${width} ${height}`} 
        style={{ width: "100%", height: "auto", overflow: "visible" }}
      >
        {/* Axes */}
        <line x1={margin.left} y1={height - margin.bottom} x2={width - margin.right} y2={height - margin.bottom} stroke="var(--border)" strokeWidth="1" />
        <line x1={margin.left} y1={margin.top} x2={margin.left} y2={height - margin.bottom} stroke="var(--border)" strokeWidth="1" />

        {/* X Ticks */}
        {ticksX.map(t => (
          <g key={t}>
            <line x1={getX(t)} y1={height - margin.bottom} x2={getX(t)} y2={height - margin.bottom + 5} stroke="var(--border)" />
            <text x={getX(t)} y={height - margin.bottom + 20} textAnchor="middle" fontSize="12" fill="var(--accent-foreground)" fontFamily="inherit">{t}nm</text>
          </g>
        ))}
        <text x={width / 2} y={height - 5} textAnchor="middle" fontSize="14" fontWeight="500" fill="var(--foreground)" fontFamily="inherit">Resolution (nm, {scaleX === "log" ? "Log" : "Linear"} Scale)</text>

        {/* Y Ticks */}
        {ticksY.map(t => (
          <g key={t}>
            <line x1={margin.left - 5} y1={getY(t)} x2={margin.left} y2={getY(t)} stroke="var(--border)" />
            <text x={margin.left - 10} y={getY(t) + 4} textAnchor="end" fontSize="12" fill="var(--accent-foreground)" fontFamily="inherit">{t}</text>
          </g>
        ))}
        <text x={15} y={height / 2} textAnchor="middle" fontSize="14" fontWeight="500" fill="var(--foreground)" transform={`rotate(-90, 15, ${height / 2})`} fontFamily="inherit">Sample Size ({scaleY === "log" ? "Log" : "Linear"} Scale)</text>

        {/* Data Points */}
        {data.map(d => {
          const size = hovered?.id === d.id ? 12 : 8;
          return (
            <rect
              key={d.id}
              x={getX(d.res) - size / 2}
              y={getY(d.ss) - size / 2}
              width={size}
              height={size}
              fill={getColor(d.modality)}
              opacity={hovered && hovered.id !== d.id ? 0.3 : 0.7}
              stroke={hovered?.id === d.id ? "var(--foreground)" : "none"}
              strokeWidth="2"
              style={{ cursor: "pointer", transition: "all 0.2s" }}
              onMouseEnter={() => setHovered(d)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => router.push(`/datasets/${d.id}`)}
            />
          );
        })}
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", gap: "20px", justifyContent: "center", marginTop: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.9rem" }}>
          <div style={{ width: "12px", height: "12px", borderRadius: 0, background: "#2e7d32" }} /> EM
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.9rem" }}>
          <div style={{ width: "12px", height: "12px", borderRadius: 0, background: "#1976d2" }} /> X-Ray
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.9rem" }}>
          <div style={{ width: "12px", height: "12px", borderRadius: 0, background: "#ed6c02" }} /> Optical
        </div>
      </div>

      {/* Tooltip */}
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
          boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
        }}>
          <strong>{hovered.title}</strong><br/>
          {hovered.res}nm · {hovered.ss} cells
        </div>
      )}
    </div>
  );
}
