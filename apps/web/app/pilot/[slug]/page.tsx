import Link from "next/link";
import { notFound } from "next/navigation";
import {
  bytesToGiB,
  getConversionReadiness,
  getDerivativeManifest,
  getPilotIndex,
  getPreviewRecords,
  getSliceCacheManifest,
  pilotAssetHref,
} from "../../../lib/public-pilot";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === "") return "unknown";
  return String(value);
}

function fileLabel(relativePath: string): string {
  return relativePath.split("/").pop() || relativePath;
}

function bytesToDisplay(bytes: number | string): string {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 1024 ** 3) return bytesToGiB(value);
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function dimensionLabel(dimensions: Record<string, string | number> | undefined): string {
  if (!dimensions) return "unknown";
  return `${valueLabel(dimensions.x)} x ${valueLabel(dimensions.y)} x ${valueLabel(dimensions.z)}`;
}

export default async function PilotDatasetPage({ params }: PageProps) {
  const { slug } = await params;
  const [index, readiness, previews, derivatives, sliceManifest] = await Promise.all([
    getPilotIndex(),
    getConversionReadiness(slug),
    getPreviewRecords(slug),
    getDerivativeManifest(slug),
    getSliceCacheManifest(slug),
  ]);

  if (!readiness) {
    notFound();
  }

  const record = index?.datasets.find((item) => item.slug === slug);
  const previewsByFilename = new Map(previews.map((preview) => [preview.filename, preview]));
  const volumePreviewRecords = previews.filter((preview) => preview.preview);
  const previewAssetHrefs = new Map(
    volumePreviewRecords.map((preview) => [preview.filename, pilotAssetHref(preview.preview)])
  );
  const derivativeBySource = new Map(
    (derivatives?.derivatives ?? []).map((derivative) => [derivative.source_relative_path, derivative])
  );
  const sliceCacheBySource = new Map(
    (sliceManifest?.caches ?? []).map((cache) => [cache.source_relative_path, cache])
  );
  const readyAssetBySource = new Map(readiness.ready_assets.map((asset) => [asset.relative_path, asset]));
  const sliceCaches = sliceManifest?.caches ?? [];
  const fullSliceCaches = sliceCaches.filter(
    (cache) =>
      cache.sampling.mode === "all" ||
      cache.sampling.cached_slices === cache.sampling.source_slices
  ).length;
  const sampledSliceCaches = sliceCaches.length - fullSliceCaches;

  return (
    <main>
      <div style={{ marginBottom: 24 }}>
        <Link href="/pilot" className="muted" style={{ textDecoration: "underline" }}>
          ← Back to pilot lineup
        </Link>
      </div>

      <section className="hero">
        <div className="kicker">
          {readiness.dataset.source} {readiness.dataset.entry_id}
        </div>
        <h1>{readiness.dataset.title || slug}</h1>
        <p>
          {readiness.summary.ready_assets} ready volumes, {readiness.summary.blocked_assets} blocked
          volumes, and {readiness.summary.sidecar_assets} sidecars.
        </p>
      </section>

      <section className="panel-grid two" style={{ marginTop: 32 }}>
        <section className="panel">
          <h2 className="section-title">Conversion Gate</h2>
          <div className="pill-row">
            <span className="pill">{readiness.summary.ready_gib} GiB ready</span>
            <span className="pill">{readiness.summary.blocked_gib} GiB blocked</span>
            <span className="pill">{readiness.summary.target_format}</span>
          </div>
          {record ? (
            <p className="muted" style={{ lineHeight: 1.6 }}>
              Validation warnings: {record.report.warnings?.length ?? 0}. Asset states:
              {" "}
              {Object.entries(record.asset_states).map(([key, value]) => `${key}: ${value}`).join(", ")}.
            </p>
          ) : null}
        </section>

        <section className="panel">
          <h2 className="section-title">Blocked Assets</h2>
          {readiness.blocked_assets.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No blocked volumes in this pilot.</p>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {readiness.blocked_assets.map((asset) => {
                const preview = previewsByFilename.get(asset.relative_path);
                return (
                  <section key={asset.relative_path} className="panel" style={{ background: "var(--background)" }}>
                    <strong>{asset.relative_path}</strong>
                    <p className="muted" style={{ margin: "8px 0" }}>
                      {bytesToGiB(asset.size_bytes)} · {asset.blockers.join("; ")}
                    </p>
                    <p className="muted" style={{ margin: 0 }}>
                      {asset.recommended_actions.join(" ")}
                    </p>
                    {preview?.preview ? (
                      <Link
                        href={`#${encodeURIComponent(asset.relative_path)}`}
                        className="muted"
                        style={{ textDecoration: "underline", display: "inline-block", marginTop: 8 }}
                      >
                        Jump to preview
                      </Link>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </section>
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <div className="figure-plate-header" style={{ marginBottom: 18 }}>
          <div>
            <h2 className="section-title">Viewer Readiness</h2>
            <p className="muted">
              Slice caches are browser-sized PNG planes for fast inspection. They are not canonical
              scientific derivatives; OME-Zarr remains the production target.
            </p>
          </div>
          <div className="figure-number">Local Pilot</div>
        </div>
        <div className="pilot-readiness-stats">
          <span className="pill">{sliceCaches.length} viewable volumes</span>
          <span className="pill">{fullSliceCaches} full caches</span>
          <span className="pill">{sampledSliceCaches} sampled caches</span>
          <span className="pill">{derivatives?.derivatives.length ?? 0} OME-Zarr derivatives</span>
          <span className="pill">{readiness.blocked_assets.length} blocked volumes</span>
        </div>
        {sliceCaches.length > 0 ? (
          <div className="pilot-readiness-table-wrap">
            <table className="pilot-readiness-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Volume</th>
                  <th>Viewer Cache</th>
                  <th>OME-Zarr</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {sliceCaches.map((cache) => {
                  const readyAsset = readyAssetBySource.get(cache.source_relative_path);
                  const derivative = derivativeBySource.get(cache.source_relative_path);
                  const cacheLabel =
                    cache.sampling.mode === "all" ||
                    cache.sampling.cached_slices === cache.sampling.source_slices
                      ? `Full ${cache.sampling.cached_slices}/${cache.sampling.source_slices}`
                      : `Sampled ${cache.sampling.cached_slices}/${cache.sampling.source_slices}`;
                  return (
                    <tr key={cache.source_relative_path}>
                      <td>
                        <strong>{fileLabel(cache.source_relative_path)}</strong>
                        <div className="muted">{cache.source_relative_path}</div>
                      </td>
                      <td>
                        {cache.source_format} · {dimensionLabel(readyAsset?.dimensions)}
                        <div className="muted">Scale: {dimensionLabel(cache.physical_voxel_size_nm)} nm</div>
                      </td>
                      <td>
                        {cacheLabel}
                        <div className="muted">{bytesToDisplay(cache.byte_size)}</div>
                      </td>
                      <td>{derivative ? `${derivative.validation.status} · ${bytesToDisplay(derivative.byte_size)}` : "Not yet"}</td>
                      <td className="pilot-readiness-open-cell">
                        <Link
                          href={`/pilot/viewer/${encodeURIComponent(slug)}?asset=${encodeURIComponent(cache.source_relative_path)}`}
                          className="button pilot-readiness-button"
                          style={{ textDecoration: "none" }}
                        >
                          Open Viewer
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ margin: "16px 0 0" }}>
            No slice viewer cache has been generated for this dataset yet.
          </p>
        )}
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 className="section-title">OME-Zarr Derivatives</h2>
        {derivatives && derivatives.derivatives.length > 0 ? (
          <div style={{ display: "grid", gap: 12 }}>
            {derivatives.derivatives.map((derivative) => (
              <section key={derivative.source_relative_path} className="panel" style={{ background: "var(--background)" }}>
                <strong>{derivative.source_relative_path}</strong>
                <p className="muted" style={{ margin: "8px 0", lineHeight: 1.5 }}>
                  {derivative.format} · {derivative.dtype} · shape z/y/x{" "}
                  {derivative.shape_zyx.join(" x ")} · chunks {derivative.chunks_zyx.join(" x ")}
                </p>
                <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
                  Validation: {derivative.validation.status} · derivative size{" "}
                  {bytesToGiB(derivative.byte_size)}
                </p>
                {sliceCacheBySource.has(derivative.source_relative_path) ? (
                  <Link
                    href={`/pilot/viewer/${encodeURIComponent(slug)}?asset=${encodeURIComponent(derivative.source_relative_path)}`}
                    className="button"
                    style={{ display: "inline-block", marginTop: 12, textDecoration: "none" }}
                  >
                    Open Slice Viewer
                  </Link>
                ) : null}
              </section>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No OME-Zarr derivative has been generated for this pilot dataset yet.
          </p>
        )}
      </section>

      <section className="figure-plate" style={{ marginTop: 32 }}>
        <div className="figure-plate-header">
          <div>
            <h2 className="section-title">Middle-Slice Figures</h2>
            <p className="muted">
              Dependency-light PNG previews generated from local TIFF/MRC volumes.
            </p>
          </div>
          <div className="figure-number">Pilot</div>
        </div>

        <div className="pilot-preview-grid">
          {volumePreviewRecords.map((preview) => {
            const href = previewAssetHrefs.get(preview.filename);
            const readyAsset = readiness.ready_assets.find((asset) => asset.relative_path === preview.filename);
            const blockedAsset = readiness.blocked_assets.find((asset) => asset.relative_path === preview.filename);
            const derivative = derivativeBySource.get(preview.filename);
            const sliceCache = sliceCacheBySource.get(preview.filename);
            return (
              <article
                key={preview.filename}
                id={encodeURIComponent(preview.filename)}
                className="panel pilot-preview-card"
              >
                {href ? (
                  <img
                    src={href}
                    alt={`${preview.filename} middle slice`}
                    style={{ width: "100%", background: "#050505", display: "block" }}
                  />
                ) : null}
                <h3 className="screen-card-title" style={{ marginTop: 14 }}>
                  {preview.filename}
                </h3>
                <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
                  {preview.kind} · {preview.width} x {preview.height} x {preview.slices} · middle z{" "}
                  {preview.middle_z}
                </p>
                {readyAsset ? (
                  <p className="muted" style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
                    Scale: {valueLabel(readyAsset.physical_voxel_size_nm.x)} x{" "}
                    {valueLabel(readyAsset.physical_voxel_size_nm.y)} x{" "}
                    {valueLabel(readyAsset.physical_voxel_size_nm.z)} nm ·{" "}
                    {valueLabel(readyAsset.physical_voxel_size_nm.source)}
                  </p>
                ) : null}
                {blockedAsset ? (
                  <p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
                    <strong>Blocked:</strong> {blockedAsset.blockers.join("; ")}
                  </p>
                ) : null}
                {derivative ? (
                  <p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
                    <strong>OME-Zarr:</strong> {derivative.validation.status} ·{" "}
                    {bytesToGiB(derivative.byte_size)}
                  </p>
                ) : null}
                {sliceCache ? (
                  <Link
                    href={`/pilot/viewer/${encodeURIComponent(slug)}?asset=${encodeURIComponent(preview.filename)}`}
                    className="button pilot-preview-button"
                    style={{ textDecoration: "none" }}
                  >
                    Open Slice Viewer
                  </Link>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
