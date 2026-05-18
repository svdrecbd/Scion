import Link from "next/link";
import { notFound } from "next/navigation";
import {
  bytesToGiB,
  getAdvisoryManifest,
  getSliceCacheManifest,
  pilotAssetHref,
  publicAdvisoryFindings,
  safePilotPath,
} from "../../../../lib/public-pilot";
import { PilotSliceViewer } from "../../../../components/pilot-slice-viewer";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ asset?: string }>;
};

export default async function PilotViewerPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { asset } = await searchParams;
  const [manifest, advisory] = await Promise.all([
    getSliceCacheManifest(slug),
    getAdvisoryManifest(slug),
  ]);

  if (!manifest || manifest.caches.length === 0) {
    notFound();
  }

  const cache = asset
    ? manifest.caches.find((item) => item.source_relative_path === asset)
    : manifest.caches[0];

  if (!cache) {
    notFound();
  }

  const frames = cache.frames.map((frame) => ({
    sequenceIndex: frame.sequence_index,
    zIndex: frame.z_index,
    href: pilotAssetHref(safePilotPath(`${slug}/${frame.relative_path}`)),
    width: frame.width,
    height: frame.height,
  }));
  const advisoryFindings = publicAdvisoryFindings(advisory).filter(
    (finding) => finding.asset_relative_path === cache.source_relative_path
  );

  return (
    <main>
      <div style={{ marginBottom: 24 }}>
        <Link href={`/pilot/${encodeURIComponent(slug)}`} className="muted" style={{ textDecoration: "underline" }}>
          ← Back to pilot dataset
        </Link>
      </div>

      <PilotSliceViewer
        title={manifest.dataset.title || slug}
        sourceRelativePath={cache.source_relative_path}
        sourceShapeZyx={cache.source_shape_zyx}
        physicalVoxelSizeNm={cache.physical_voxel_size_nm}
        samplingMode={cache.sampling.mode}
        sourceSlices={cache.sampling.source_slices}
        contrastMode={cache.contrast.mode}
        contrastNote={cache.contrast.note}
        frames={frames}
      />

      {advisoryFindings.length > 0 ? (
        <section className="panel" style={{ marginTop: 24 }}>
          <h2 className="section-title">Data Reuse Note</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {advisoryFindings.map((finding) => (
              <div key={finding.finding_id}>
                <div className="kicker">{finding.severity} · {finding.category}</div>
                <p className="muted" style={{ margin: "4px 0", lineHeight: 1.6 }}>
                  {finding.summary}
                </p>
                <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                  {finding.impact}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel-grid two" style={{ marginTop: 24 }}>
        <section className="panel">
          <h2 className="section-title">Viewer Cache</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            {cache.sampling.cached_slices} cached planes from {cache.sampling.source_slices} source
            slices. Cache size: {bytesToGiB(cache.byte_size)}. Source dtype: {cache.source_dtype}.
          </p>
        </section>
        <section className="panel">
          <h2 className="section-title">Boundary</h2>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            This inspection viewer is built from generated PNG planes. It is not a canonical
            analysis export and does not replace OME-Zarr for advanced navigation.
          </p>
        </section>
      </section>
    </main>
  );
}
