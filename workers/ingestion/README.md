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

## Archive Scanner

Use `archive_scanner.py` for the first read-only pass over lab-local archives before upload, conversion, or analysis. It is dependency-light and writes scanner artifacts outside the source tree.

For a real archive run, follow `docs/archive-beachhead-runbook.md`. Preflight validates source/output separation, free space, the exclusive output lock, and checksum-resume identity without walking the archive:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead \
  --preflight-only
```

Example fast inventory:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead
```

Example inventory with SHA-256 fixity:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead \
  --checksum sha256
```

Resume a checksum pass against the same output directory:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead \
  --checksum sha256 \
  --resume-checksums
```

For long archive runs, tune progress checkpoints so another shell or process can inspect the current state without waiting for completion:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead \
  --checksum sha256 \
  --resume-checksums \
  --progress-interval-files 1000 \
  --progress-interval-seconds 30
```

It writes:

- `file-manifest.jsonl`
- `inventory-summary.json`
- `metadata-extraction.jsonl`
- `metadata-gaps.csv`
- `volume-candidates.csv`
- `asset-status-ledger.jsonl`
- `extension-summary.csv`
- `largest-files.csv`
- `scan-errors.csv`
- `scan-progress.jsonl`
- `scan-checkpoint.json`
- `scan-state.sqlite`
- `scan.lock`
- `checksums.jsonl` when `--checksum sha256` is enabled
- `fixity-run.json` when `--checksum sha256` is enabled

The checksum resume mode uses `scan-state.sqlite` rather than an archive-sized Python dictionary. It reuses an existing digest only when relative path, algorithm, file size, modified timestamp, device, and inode match, and it rejects resume attempts when the archive id or source root changed. Duplicate tracking is also disk-backed. Primary JSONL/CSV results are staged as `.inprogress` files and replace the last completed artifacts only after a successful scan. `scan-progress.jsonl` is append-only across attempts, each attempt has a `run_id`, and `scan-checkpoint.json` is the latest machine-readable status for dashboards, tailing, or recovery after interruption. A restarted job re-enumerates the tree to reconcile additions and removals, but unchanged file bytes are not rehashed.

After copying or mirroring an archive, compare the source and target scanner outputs:

```bash
python3 workers/ingestion/archive_scanner.py compare-scans \
  ~/Downloads/cell-anatomy-archive-scan-source \
  ~/Downloads/cell-anatomy-archive-scan-target \
  --output-dir ~/Downloads/cell-anatomy-copy-verification \
  --require-checksums
```

It writes:

- `copy-verification-report.json`
- `copy-verification-mismatches.csv`

The comparison reconciles relative paths, path types, sizes, and checksum digests when present. It uses a disposable SQLite join index instead of holding both manifests in RAM. Use `--require-checksums` for backup or mirror verification where inventory-only comparison is not enough.

The first extractor pass recognizes classic TIFF / OME-TIFF headers, MRC headers, Zarr `.zarray` metadata, and HDF5 signatures. Proprietary microscope formats are inventoried and classified as candidates, but still need follow-up extractors. `metadata-gaps.csv` is the review queue for missing dimensions, dtype, z depth, voxel size, unsupported extractors, and deferred HDF5 internals. `asset-status-ledger.jsonl` seeds every discovered file with conservative unknown rights/publication/triage status and disables cloud, conversion, sharing, and publication operations until a human or registry process upgrades the asset.

## Private Archive Registry

Use `archive_registry.py` after a scanner run to turn scanner artifacts into a CAOS-readable private registry. This is still local file output; it does not upload, sync, or make anything public.

```bash
python3 workers/ingestion/archive_registry.py import-scan \
  ~/Downloads/cell-anatomy-archive-scan \
  --output-dir ~/Downloads/cell-anatomy-private-registry \
  --registry-id lbnl-beachhead-registry
```

It writes:

- `private-registry.json`
- `private-registry-assets.jsonl`
- `private-registry-search-index.jsonl`
- `private-registry-review-queue.csv`
- `private-registry-volume-candidates.csv`

The importer joins file manifest rows, checksums, metadata extraction, metadata gaps, volume candidates, and asset status rows through a disposable SQLite build index, streams final JSONL/CSV outputs, and replaces each final artifact only after the build completes. Directory-backed volume candidates such as Zarr stores are represented as logical `directory_volume` assets even when the scanner only saw component files. Imported assets remain blocked for CAOS viewing, conversion, cloud backup, sharing, and publication until their rights and triage status are curated.

The native Workbench opens `private-registry.json` and builds a disposable `private-registry-index.sqlite` cache from `private-registry-assets.jsonl`. React receives only the visible project-ready, conversion-queue, and review pages; it does not need to parse every registry asset row for desktop use.

Apply a curated status overlay after review decisions are available:

```bash
python3 workers/ingestion/archive_registry.py apply-status-overlay \
  ~/Downloads/cell-anatomy-private-registry \
  --overlay ~/Downloads/lbnl-status-overlay.csv \
  --output-dir ~/Downloads/cell-anatomy-private-registry-curated \
  --registry-id lbnl-beachhead-registry-curated
```

The overlay can be CSV or JSONL. Rows match by `asset_id` or `relative_path` and may update `publication_status`, `triage_status`, `rights_status`, `classification_status`, `review_required`, `review_notes`, `blocked_states`, and allowed-operation columns such as `can_view_in_caos`, `can_convert`, and `can_backup_to_cloud`. It writes a full rebuilt registry plus `status-overlay-unmatched.csv`; the original registry remains unchanged.

Promote a bounded workset from selected registry assets before treating archive-estate records as Dataset / Repo Mode inputs:

```bash
python3 workers/ingestion/archive_registry.py promote-workset \
  ~/Downloads/cell-anatomy-private-registry-curated \
  --output-dir ~/Downloads/cell-anatomy-worksets/pilot-candidate \
  --workset-id pilot-candidate \
  --path-prefix raw/candidate-folder/ \
  --volume-candidates-only \
  --intended-operation review \
  --intended-operation convert
```

It writes:

- `workset.json`
- `workset-assets.jsonl`
- `workset-assets.csv`
- `workset-review-queue.csv`

The workset records source registry provenance, selected asset ids and paths, rights/triage/publication status, fixity coverage, metadata readiness, intended operations, blocked operations, and the destination workset directory. It does not copy raw bytes.

Workset selection is hard-capped at 10,000 assets. Use `--limit` for intentionally smaller selections; selections that cross the cap fail and must be partitioned by path or another selector. Query selection scans the asset JSONL directly and does not construct a full-registry in-memory search map.

For the local public-data pilot bundle, import `pilot-index.json` plus each dataset's readiness, derivative, validation, and asset-state manifests directly:

```bash
python3 workers/ingestion/archive_registry.py import-public-data \
  ~/Downloads/scion-public-data \
  --output-dir ~/Downloads/scion-public-data-registry \
  --registry-id scion-public-data-local-registry
```

This writes the same registry artifact set as `import-scan`, but treats the public-data manifests as the authoritative status overlay. Mirrored source files keep their source SHA-256 and validated conversion metadata, while converted OME-Zarr stores are imported as logical `directory_volume` assets with a deterministic `sha256-tree-v1` composite checksum. Converted derivatives whose validation passed are marked `project_ready` and `can_view_in_caos`; raw source files remain conversion candidates, not directly project-ready assets.

## Pilot Reports

Use `archive_pilot_report.py` to generate a local report for one selected pilot subset after the private registry exists. A pilot report is read-only and can be regenerated many times with different selectors.

Candidate subset example:

```bash
python3 workers/ingestion/archive_pilot_report.py report \
  ~/Downloads/cell-anatomy-private-registry \
  --output-dir ~/Downloads/cell-anatomy-pilots/pilot-candidate \
  --pilot-id pilot-candidate \
  --title "Unmined Candidate Pilot" \
  --kind candidate \
  --path-prefix raw/candidate-folder/ \
  --volume-candidates-only
```

Other selectors:

- `--asset-id <asset-id>` for exact registry assets
- `--query <term>` for search-index-backed matching
- `--all` for a whole-registry report
- `--limit <n>` for a bounded first review pass

Project-ready public OME-Zarr report example:

```bash
python3 workers/ingestion/archive_pilot_report.py report \
  ~/Downloads/scion-public-data-registry \
  --output-dir ~/Downloads/cell-anatomy-pilots/scion-public-ome-zarr \
  --pilot-id scion-public-data-ome-zarr-ready \
  --title "SCION Public Data OME-Zarr Ready Volumes" \
  --kind candidate \
  --query ome.zarr
```

It writes:

- `pilot-report.json`
- `pilot-report.md`
- `pilot-assets.csv`
- `pilot-review-queue.csv`

The report summarizes selected bytes, formats, volume candidates, checksum coverage, metadata readiness, project readiness, blockers, metadata gaps, findings, and next steps. It is intended for local review with the lead before any cloud upload, conversion, or scientific mining claims.

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

For EMPIAR entries that publish a single volume as numbered one-plane TIFF files, generate one logical TIFF-series viewer cache:

```bash
python3 workers/ingestion/public_data_pilot.py slices \
  mocaer-2023-empiar-11399 \
  --root ~/Downloads/scion-public-data \
  --tiff-series \
  --max-slices 96
```

The TIFF-series mode groups numbered single-plane TIFF files with matching dimensions, sorts them by their numeric suffix, samples across the full run, and records one logical cache in `metadata/slice-manifest.json`.

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
