# Ingestion scaffold

This directory is where source-specific ingestion code should live.

For the MVP, the goal is not full automation. The goal is a repeatable path from raw source metadata to a validated Cell Anatomy dataset record.

## Responsibilities

- accept source metadata or exported tables
- normalize field names
- map values to controlled vocabularies
- emit canonical dataset records
- flag missing required fields
- attach provenance

## Suggested first adapters

1. curated CSV / spreadsheet export
2. repository metadata JSON
3. paper-level extraction pipeline

## Public Data Pilot

Use `public_data_pilot.py` for dependency-light EMPIAR and Figshare ingest tests before any cloud or OME-Zarr work.

It writes local outputs outside git by default under `~/Downloads/scion-public-data/<slug>`:

- `metadata/download-manifest.tsv`
- `metadata/local-file-inventory.tsv`
- `metadata/normalized-manifest.json`
- `metadata/asset-state-manifest.json`
- `metadata/conversion-readiness-manifest.json`
- `metadata/curation-review-queue.tsv`
- `metadata/validation-report.json`
- `metadata/advisory-findings.json`
- `metadata/advisory-review-queue.tsv`
- `metadata/preview-inventory.tsv`
- `metadata/slice-manifest.json`
- `derived/preview-index.html`
- `derived/middle-slices/*.png`
- `derived/slice-cache/<asset>/*.png`

Example:

```bash
python3 workers/ingestion/public_data_pilot.py empiar 10392 \
  --slug rudlaff-2020-empiar-10392 \
  --root ~/Downloads/scion-public-data \
  --download \
  --previews
```

For a repeat run against already-downloaded files:

```bash
python3 workers/ingestion/public_data_pilot.py empiar 10392 \
  --slug rudlaff-2020-empiar-10392 \
  --root ~/Downloads/scion-public-data \
  --previews \
  --require-existing-data
```

For a fully offline repeat run using cached EMPIAR metadata and cached `download-manifest.tsv`:

```bash
python3 workers/ingestion/public_data_pilot.py empiar 10392 \
  --slug rudlaff-2020-empiar-10392 \
  --root ~/Downloads/scion-public-data \
  --previews \
  --require-existing-data \
  --offline
```

Figshare article example:

```bash
python3 workers/ingestion/public_data_pilot.py figshare 7346750 \
  --slug laundon-2019-figshare-7346750 \
  --root ~/Downloads/scion-public-data \
  --download \
  --previews
```

For a fully offline Figshare repeat run:

```bash
python3 workers/ingestion/public_data_pilot.py figshare 7346750 \
  --slug laundon-2019-figshare-7346750 \
  --root ~/Downloads/scion-public-data \
  --previews \
  --require-existing-data \
  --offline
```

The pilot intentionally avoids imaging-library dependencies. It currently parses EMPIAR directory indexes and Figshare article file manifests, resumably downloads files, verifies final byte counts, hashes local assets, verifies Figshare MD5 checksums when available, reads MRC and classic TIFF headers, extracts ImageJ TIFF scale metadata when available, pairs Figshare TIFF files with TrakEM2 XML calibration sidecars, emits an audit-first asset lifecycle manifest, gates validated volumes into a conversion-readiness manifest, and generates middle-slice PNG previews.

Known validation behavior:

- MRC physical scale from headers is flagged when it looks like a default header value rather than source-authoritative calibration.
- Figshare TrakEM2 z-spacing is marked for review when the parsed spacing is outside a conservative serial-section range.
- Non-volume sidecars such as TrakEM2 XML gzips are inventoried and checksummed but marked `not_applicable` for `validated_volume`.
- User-impacting repository or asset inconsistencies are promoted into neutral advisory findings. These are evidence-backed review candidates, not blame language or public accusations.
- Generated advisory findings default to `review_status=needs_human_review`. The web UI only displays findings marked `review_status=approved_public` and `public_notice_candidate=true` as Data Reuse Notes.

Run non-network unit tests:

```bash
make test-ingestion
```

Build or refresh the local pilot lineup across existing dataset outputs:

```bash
make pilot-index
```

That writes:

- `~/Downloads/scion-public-data/pilot-index.html`
- `~/Downloads/scion-public-data/pilot-index.json`

Refresh neutral data-integrity advisories across existing outputs:

```bash
python3 workers/ingestion/public_data_pilot.py advisory --all \
  --root ~/Downloads/scion-public-data
```

That writes per dataset:

- `metadata/advisory-findings.json`
- `metadata/advisory-review-queue.tsv`

Use the local-only review suite to inspect and approve flags:

```bash
cd apps/web
SCION_ENABLE_PUBLIC_DATA_PILOT=true \
SCION_ENABLE_LOCAL_REVIEW_SUITE=true \
npm run start -- --hostname 127.0.0.1 --port 3104
```

Then open `/pilot/review`. The suite can mark findings as `approved_public`, `internal_only`, `dismissed`, or back to `needs_human_review`. Only `approved_public` findings with `public_notice_candidate=true` appear on public Data pages as Data Reuse Notes.

Convert one validated TIFF volume into a local OME-Zarr derivative:

```bash
python3 workers/ingestion/public_data_pilot.py convert \
  uwizeye-2021b-empiar-10672 \
  --root ~/Downloads/scion-public-data \
  --asset 'Electron-microscopy-data/Symbiotic_cells/Symbiotic-cell&40plastids.tif'
```

Or use the Make target:

```bash
make pilot-convert \
  PILOT_SLUG=uwizeye-2021b-empiar-10672 \
  PILOT_ASSET='Electron-microscopy-data/Symbiotic_cells/Symbiotic-cell&40plastids.tif'
```

The converter currently writes a dependency-light Zarr v2 / OME-NGFF single-scale store under `derived/ome-zarr/`, updates `metadata/derivative-manifest.json`, and marks the source asset's `streamable_derivative` state in `metadata/asset-state-manifest.json`. This is a conversion-readiness spike, not the final serving architecture.

Generate a Cell Anatomy browser slice cache for one validated TIFF volume:

```bash
python3 workers/ingestion/public_data_pilot.py slices \
  uwizeye-2021b-empiar-10672 \
  --root ~/Downloads/scion-public-data \
  --asset 'Electron-microscopy-data/Symbiotic_cells/Symbiotic-cell&40plastids.tif' \
  --max-slices 96
```

Or use the Make target:

```bash
make pilot-slices \
  PILOT_SLUG=uwizeye-2021b-empiar-10672 \
  PILOT_ASSET='Electron-microscopy-data/Symbiotic_cells/Symbiotic-cell&40plastids.tif' \
  PILOT_MAX_SLICES=96
```

For a complete local cache of every source plane:

```bash
make pilot-slices \
  PILOT_SLUG=uwizeye-2021b-empiar-10672 \
  PILOT_ASSET='Electron-microscopy-data/Symbiotic_cells/Symbiotic-cell&40plastids.tif' \
  PILOT_ALL_SLICES=1
```

The slice cache writes sampled or complete PNG planes under `derived/slice-cache/` and records them in `metadata/slice-manifest.json`. This is the low-bloat path for the native Cell Anatomy Slice Viewer. It is not a canonical analysis derivative; OME-Zarr remains the streamable power-user target. The viewer supports keyboard navigation with left/right arrows and Home/End, preloads adjacent frames, draws a scale bar from physical voxel metadata, and reports whether the cache is sampled or complete. Contrast metadata is explicit: 8-bit sources are written directly, while 16-bit sources are currently normalized per slice for inspection.

To browse pilot figures inside the local Cell Anatomy web app, run the web server with the pilot browser enabled:

```bash
cd apps/web
SCION_ENABLE_PUBLIC_DATA_PILOT=true \
SCION_PUBLIC_DATA_ROOT=~/Downloads/scion-public-data \
npm run start -- --hostname 127.0.0.1 --port 3000
```

Then open:

- `http://127.0.0.1:3000/pilot`
- `http://127.0.0.1:3000/pilot/laundon-2019-figshare-7346750`
- `http://127.0.0.1:3000/pilot/viewer/uwizeye-2021b-empiar-10672`

The app route streams preview PNGs from the configured local pilot root. It is hidden from the main navigation and disabled by default in production unless explicitly enabled.

## Output contract

Each adapter should emit canonical records that match the API schema in `apps/api/app/schemas.py`.
