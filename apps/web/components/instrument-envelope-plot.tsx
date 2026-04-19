type BenchmarkStats = {
  min: number;
  max: number;
  median: number;
  avg: number;
};

type InstrumentBenchmark = {
  modality_family: string;
  count: number;
  resolution_stats: BenchmarkStats | null;
  sample_size_stats: BenchmarkStats | null;
};

type InstrumentEnvelopePlotProps = {
  benchmarks: InstrumentBenchmark[];
};

function modalityColor(family: string) {
  if (family === "EM") return "var(--atlas-blue)";
  if (family === "X-ray") return "var(--atlas-green)";
  if (family === "optical") return "var(--atlas-orange)";
  return "var(--accent-foreground)";
}

function formatModalityFamily(family: string) {
  return family === "optical" ? "Optical" : family;
}

function corpusHref(family: string) {
  return `/corpus?family=${encodeURIComponent(family)}`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function InstrumentEnvelopePlot({ benchmarks }: InstrumentEnvelopePlotProps) {
  const plottable = benchmarks.filter(
    (benchmark) => benchmark.resolution_stats && benchmark.sample_size_stats
  );

  if (plottable.length === 0) {
    return (
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          No benchmark records have both resolution and sample-size statistics.
        </p>
      </div>
    );
  }

  const width = 920;
  const height = 430;
  const margin = { top: 26, right: 34, bottom: 72, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const plotBottom = margin.top + plotHeight;
  const xMin = Math.min(0.5, ...plottable.map((benchmark) => benchmark.resolution_stats!.min));
  const xMax = Math.max(400, ...plottable.map((benchmark) => benchmark.resolution_stats!.max));
  const yMin = Math.min(1, ...plottable.map((benchmark) => benchmark.sample_size_stats!.min));
  const yMax = Math.max(250, ...plottable.map((benchmark) => benchmark.sample_size_stats!.max));
  const xTicks = [0.5, 1, 10, 100, 400].filter((tick) => tick >= xMin && tick <= xMax);
  const yTicks = [1, 3, 10, 30, 100, 250].filter((tick) => tick >= yMin && tick <= yMax);
  const logXMin = Math.log10(xMin);
  const logXMax = Math.log10(xMax);
  const logYMin = Math.log10(yMin);
  const logYMax = Math.log10(yMax);
  const getX = (value: number) =>
    margin.left + ((Math.log10(Math.max(value, xMin)) - logXMin) / (logXMax - logXMin)) * plotWidth;
  const getY = (value: number) =>
    plotBottom - ((Math.log10(Math.max(value, yMin)) - logYMin) / (logYMax - logYMin)) * plotHeight;

  return (
    <div className="instrument-envelope">
      <div className="instrument-envelope-chart-wrap">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="instrument-envelope-chart"
          role="img"
          aria-label="Instrument operating envelopes by imaging family"
        >
          <rect
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={plotHeight}
            className="instrument-envelope-frame"
          />

          {xTicks.map((tick) => (
            <g key={`x-${tick}`}>
              <line x1={getX(tick)} y1={margin.top} x2={getX(tick)} y2={plotBottom} className="instrument-envelope-grid" />
              <line x1={getX(tick)} y1={plotBottom} x2={getX(tick)} y2={plotBottom + 5} className="instrument-envelope-axis" />
              <text x={getX(tick)} y={plotBottom + 23} textAnchor="middle" className="instrument-envelope-tick">
                {formatNumber(tick)}nm
              </text>
            </g>
          ))}

          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line x1={margin.left} y1={getY(tick)} x2={width - margin.right} y2={getY(tick)} className="instrument-envelope-grid" />
              <line x1={margin.left - 5} y1={getY(tick)} x2={margin.left} y2={getY(tick)} className="instrument-envelope-axis" />
              <text x={margin.left - 10} y={getY(tick) + 4} textAnchor="end" className="instrument-envelope-tick">
                {tick}
              </text>
            </g>
          ))}

          <line x1={margin.left} y1={plotBottom} x2={width - margin.right} y2={plotBottom} className="instrument-envelope-axis-strong" />
          <line x1={margin.left} y1={margin.top} x2={margin.left} y2={plotBottom} className="instrument-envelope-axis-strong" />

          {plottable.map((benchmark) => {
            const resolution = benchmark.resolution_stats!;
            const sampleSize = benchmark.sample_size_stats!;
            const color = modalityColor(benchmark.modality_family);
            const x1 = getX(resolution.min);
            const x2 = getX(resolution.max);
            const y1 = getY(sampleSize.max);
            const y2 = getY(sampleSize.min);
            const medianX = getX(resolution.median);
            const medianY = getY(sampleSize.median);

            return (
              <a key={benchmark.modality_family} href={corpusHref(benchmark.modality_family)}>
                <title>
                  {`${formatModalityFamily(benchmark.modality_family)}: ${benchmark.count} records; ${formatNumber(resolution.min)}-${formatNumber(resolution.max)}nm; ${sampleSize.min}-${sampleSize.max} cells`}
                </title>
                <rect
                  x={Math.min(x1, x2)}
                  y={Math.min(y1, y2)}
                  width={Math.max(3, Math.abs(x2 - x1))}
                  height={Math.max(3, Math.abs(y2 - y1))}
                  className="instrument-envelope-range"
                  style={{ fill: color, stroke: color }}
                />
                <line
                  x1={medianX}
                  y1={Math.min(y1, y2)}
                  x2={medianX}
                  y2={Math.max(y1, y2)}
                  className="instrument-envelope-median-rule"
                  style={{ stroke: color }}
                />
                <line
                  x1={Math.min(x1, x2)}
                  y1={medianY}
                  x2={Math.max(x1, x2)}
                  y2={medianY}
                  className="instrument-envelope-median-rule"
                  style={{ stroke: color }}
                />
                <rect
                  x={medianX - 4}
                  y={medianY - 4}
                  width="8"
                  height="8"
                  className="instrument-envelope-median"
                  style={{ fill: color }}
                />
                <text x={Math.min(x1, x2) + 8} y={Math.min(y1, y2) + 18} className="instrument-envelope-label">
                  {formatModalityFamily(benchmark.modality_family)}
                </text>
              </a>
            );
          })}

          <text x={width / 2} y={height - 18} textAnchor="middle" className="instrument-envelope-axis-label">
            Resolution (nm, log scale)
          </text>
          <text
            x="18"
            y={height / 2}
            textAnchor="middle"
            transform={`rotate(-90, 18, ${height / 2})`}
            className="instrument-envelope-axis-label"
          >
            Whole-Cell Count (log scale)
          </text>
        </svg>
      </div>

      <div className="instrument-envelope-ledger">
        {plottable.map((benchmark) => {
          const resolution = benchmark.resolution_stats!;
          const sampleSize = benchmark.sample_size_stats!;

          return (
            <a
              key={benchmark.modality_family}
              href={corpusHref(benchmark.modality_family)}
              className="instrument-envelope-ledger-row"
            >
              <span className="plot-legend-swatch" style={{ color: modalityColor(benchmark.modality_family), background: modalityColor(benchmark.modality_family) }} />
              <strong>{formatModalityFamily(benchmark.modality_family)}</strong>
              <span>{benchmark.count} records</span>
              <span>{formatNumber(resolution.min)}-{formatNumber(resolution.max)}nm</span>
              <span>{sampleSize.min}-{sampleSize.max} cells</span>
              <span className="muted">median {formatNumber(resolution.median)}nm / {sampleSize.median} cells</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
