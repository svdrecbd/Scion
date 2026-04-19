type SearchParamMap = Record<string, string | undefined>;

type CoverageAtlas = {
  matrix: Record<string, Record<string, number>>;
  cell_types: string[];
  organelles: string[];
  cell_type_totals: Record<string, number>;
  organelle_totals: Record<string, number>;
  cell_type_organelle_counts: Record<string, number>;
  cell_type_species: Record<string, string[]>;
};

type CoverageTerrainProps = {
  coverage: CoverageAtlas;
  activeParams: SearchParamMap;
};

const FILTER_KEYS = [
  "query",
  "year",
  "cell_type",
  "organelle",
  "pair",
  "modality",
  "family",
  "metric",
  "comparator_class",
  "status",
  "public",
  "borderline"
];

function corpusHref(activeParams: SearchParamMap, extra: Record<string, string | null>) {
  const params = new URLSearchParams();
  FILTER_KEYS.forEach((key) => {
    const value = activeParams[key];
    if (value) params.set(key, value);
  });
  Object.entries(extra).forEach(([key, value]) => {
    if (value === null) params.delete(key);
    else params.set(key, value);
  });
  const query = params.toString();
  return query ? `/corpus?${query}` : "/corpus";
}

function coverageColor(count: number, maxCount: number) {
  if (count === 0) return "transparent";
  const opacity = Math.min(0.16 + (count / maxCount) * 0.76, 0.92);
  return `rgba(85, 184, 211, ${opacity})`;
}

export function CoverageTerrain({ coverage, activeParams }: CoverageTerrainProps) {
  const cellTypes = coverage.cell_types.slice(0, 8);
  const organelles = coverage.organelles.slice(0, 10);
  const intersections = organelles.flatMap((organelle) =>
    cellTypes.map((cellType) => ({
      cellType,
      organelle,
      count: coverage.matrix[cellType]?.[organelle] || 0
    }))
  );
  const maxCount = Math.max(1, ...intersections.map((intersection) => intersection.count));

  return (
    <article className="coverage-atlas">
      <div className="coverage-atlas-header">
        <div>
          <h3>Topographic Coverage Grid</h3>
          <p>
            Organelle rows cross cell-type columns. Square color encodes record count, so dense
            zones and empty terrain stay readable without a second decoding layer.
          </p>
        </div>
      </div>

      <div className="coverage-topographic-wrap">
        <table className="coverage-topographic-grid">
          <thead>
            <tr>
              <th>Organelle</th>
              {cellTypes.map((cellType) => (
                <th key={cellType}>
                  <a href={corpusHref(activeParams, { cell_type: cellType })}>
                    {cellType}
                  </a>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {organelles.map((organelle) => (
              <tr key={organelle}>
                <th>
                  <a href={corpusHref(activeParams, { organelle })}>{organelle}</a>
                </th>
                {cellTypes.map((cellType) => {
                  const count = coverage.matrix[cellType]?.[organelle] || 0;
                  return (
                    <td key={cellType}>
                      {count > 0 ? (
                        <a
                          href={corpusHref(activeParams, { cell_type: cellType, organelle })}
                          className="coverage-topographic-cell"
                          style={{ background: coverageColor(count, maxCount) }}
                          title={`${cellType} / ${organelle}: ${count} records`}
                        >
                          {count}
                        </a>
                      ) : (
                        <span className="coverage-topographic-empty" aria-label="No records" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="coverage-topographic-legend">
        <span>0</span>
        <span className="coverage-legend-ramp" aria-hidden="true" />
        <span>{maxCount}</span>
        <span className="muted">records per intersection</span>
      </div>
    </article>
  );
}
