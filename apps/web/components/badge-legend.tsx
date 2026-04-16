const badgeItems = [
  {
    label: "Res",
    description: "Resolution values are reported."
  },
  {
    label: "SS",
    description: "Sample size is reported."
  },
  {
    label: "Boundary",
    description: "Whole-cell boundary status is reported."
  },
  {
    label: "Public Data",
    description: "Reusable public data is known to exist."
  },
  {
    label: "Borderline",
    description: "Record has a caveat relative to the main corpus criteria."
  }
];

export function BadgeLegend({
  title = "Tag Legend",
  compact = false
}: {
  title?: string;
  compact?: boolean;
}) {
  return (
    <section className={`panel badge-legend ${compact ? "compact" : ""}`}>
      <h2 className="section-title">{title}</h2>
      <div className="badge-legend-grid">
        {badgeItems.map((item) => (
          <div key={item.label} className="badge-legend-item">
            <span
              className={`pill ${
                item.label === "Borderline"
                  ? "badge-borderline"
                  : item.label === "Public Data"
                    ? "badge-public"
                    : "badge-verify"
              }`}
            >
              {item.label}
            </span>
            <span className="muted">{item.description}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
