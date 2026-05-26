export function WorkbenchLogo({ width = 34, height = 24 }: { width?: number; height?: number }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="250 198 700 504"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ shapeRendering: "geometricPrecision", color: "var(--foreground)", flexShrink: 0 }}
    >
      <defs>
        <mask id="desktop-cell-anatomy-logo-cutouts">
          <rect x="250" y="198" width="700" height="504" fill="white" />
          <rect x="570" y="198" width="60" height="504" fill="black" />
          <rect x="400" y="285" width="400" height="330" rx="20" ry="20" fill="black" />
        </mask>
      </defs>
      <rect
        x="250"
        y="200"
        width="700"
        height="500"
        rx="28"
        ry="28"
        fill="currentColor"
        mask="url(#desktop-cell-anatomy-logo-cutouts)"
      />
    </svg>
  );
}
