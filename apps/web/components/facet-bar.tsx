import Link from "next/link";

type FacetItem = {
  label: string;
  href?: string;
};

type Props = {
  title: string;
  items: (string | FacetItem)[];
  description?: string;
};

export function FacetBar({ title, items, description }: Props) {
  return (
    <section className="panel">
      <h2 className="section-title">{title}</h2>
      {description ? (
        <p className="muted" style={{ margin: "0 0 12px", lineHeight: 1.5 }}>
          {description}
        </p>
      ) : null}
      <div className="pill-row">
        {items.map((item, idx) => {
          const label = typeof item === "string" ? item : item.label;
          const href = typeof item === "string" ? undefined : item.href;

          if (href) {
            return (
              <Link key={idx} href={href} className="pill pill-link">
                {label}
              </Link>
            );
          }

          return (
            <span key={idx} className="pill">
              {label}
            </span>
          );
        })}
      </div>
    </section>
  );
}
