import Link from "next/link";
import { notFound } from "next/navigation";
import {
  bytesToGiB,
  getSliceCacheManifest,
  pilotAssetHref,
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
  const manifest = await getSliceCacheManifest(slug);

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
            This is a local inspection viewer built from generated PNG planes. It is not a canonical
            analysis export and does not replace OME-Zarr for power-user navigation.
          </p>
        </section>
      </section>
    </main>
  );
}
