import React from "react";

export function Logo() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="logo-svg"
      aria-hidden="true"
      style={{ shapeRendering: "geometricPrecision" }}
    >
      {/* Left Oval (Tall) */}
      <ellipse
        cx="12"
        cy="16"
        rx="8"
        ry="13"
        stroke="currentColor"
        strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
      {/* Right Oval (Tall) */}
      <ellipse
        cx="20"
        cy="16"
        rx="8"
        ry="13"
        stroke="currentColor"
        strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
      {/* Interlinking Mask Effect */}
      <path
        d="M16 4.8 A 8 13 0 0 1 16 27.2"
        stroke="var(--background)"
        strokeWidth="3"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M16 4.8 A 8 13 0 0 1 16 27.2"
        stroke="currentColor"
        strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
