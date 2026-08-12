# LBNL Data Beachhead

This document is the working plan for using a roughly 90 TB raw whole-cell imaging archive from Lawrence Berkeley National Laboratory as the forcing function for CAOS. The goal is not merely to back up the data or make a nicer viewer. The goal is to turn a real, messy, scientifically valuable archive into a governed, queryable, inspectable, analysis-ready data estate that CAOS can operate on from idea through publication support.

The current CAOS direction is local-first: the public Atlas provides discovery, literature context, accounts, and eventual project continuity; the desktop Workbench provides local volume inspection, measurement, annotation, jobs, exports, and project state. This archive should be treated as the first serious test of whether that product shape can support real scientific work.

## Core Premise

The archive is potentially valuable because it contains raw data produced over roughly five years, much of which may already be associated with publications or internal triage decisions. That creates three opportunities:

1. Preserve the archive with enough provenance and integrity that it is not just "some files on a drive."
2. Reconstruct what each dataset is, where it came from, whether it was published, and whether it can be reused.
3. Use CAOS to inspect, organize, derive, compare, mine, and package evidence from the archive.

The first success condition is boring but essential: no data loss, no accidental mutation of raw files, no ambiguous provenance, and no upload or sharing before rights are clear.

The second success condition is product-facing: CAOS should gain the missing infrastructure required to move from "volume workbench" to "idea-to-publication engine."

## Product Outcome

If this works, a user should be able to:

1. Start with a biological question, structure, modality, organism, sample, or publication.
2. Search the Atlas/private registry for relevant public and private volume assets.
3. Open a validated asset in CAOS without guessing which raw file or derivative is correct.
4. Inspect the volume with calibrated voxel metadata and visible caveats.
5. Define measurements, ROIs, notes, and view states tied to exact source data and coordinates.
6. Run local or cloud-backed jobs for conversion, previewing, quality checks, summaries, segmentation-adjacent work, and figure generation.
7. Compare related volumes, published examples, or internal candidate datasets.
8. Export a reproducibility bundle containing figures, methods metadata, measurements, ROIs, source citations, checksums, and project state.

That is what "idea to publication" should mean in practical terms. It should produce reusable evidence, not just screenshots.

## Non-Goals

- Do not upload the archive before ownership, permission, retention, and access rules are explicit.
- Do not transform raw data in place.
- Do not treat "copied once" as "backed up."
- Do not treat "viewable" as "analysis-ready."
- Do not expose account-backed sync or cloud jobs until the account and storage boundary is production-grade.
- Do not claim new biological findings until the archive has provenance, calibration, and review context.

## Operating Principles

1. **Raw data is immutable.** Every transformation creates a derivative with its own identifier and provenance.
2. **Manifests precede movement.** Inventory and checksum before cloud upload, conversion, or analysis.
3. **Provenance beats polish.** A plain manifest with strong checksums is more valuable than a beautiful UI over unknown files.
4. **Local-first, cloud-aware.** CAOS should work locally first, then use cloud storage and compute where they add real value.
5. **Status is explicit.** Published, unpublished, irrelevant, restricted, unknown, and candidate data should not be blurred together.
6. **No fake continuity.** Account, cloud, and sync features must represent real durable state or remain dormant.
7. **Bounded working sets.** A user should never need to load an archive into memory. CAOS should move manifests, search pages, chunks, previews, sampled summaries, and job checkpoints through the UI while raw data stays in immutable external storage.

## Scale Position

The LBNL archive is now expected to be closer to 90 TB than 4 TB. That changes the operational posture substantially. CAOS should not treat the whole archive as one large dataset to load, convert, or mine directly. It should treat the archive as an estate: a governed raw store plus compact manifests, indexes, status ledgers, conversion selections, and project worksets.

A future intern with an 8 GB MacBook Air and a 30-90 TB lab archive can still be productive if CAOS keeps three boundaries intact:

- Inventory and fixity are streaming jobs that write append-only or resumable artifacts.
- Search and triage operate on compact indexes, not directory walks or raw image reads at interaction time.
- Viewing and analysis are lazy: OME-Zarr chunks, slice caches, thumbnails, sampled histograms, and explicit job outputs are loaded on demand.

That does not mean every workflow will run well on the laptop. Full-archive conversion, segmentation, and high-throughput mining still need external drives, a workstation, or cloud/HPC compute. The feasible local promise is narrower and still valuable: inspect the archive, search it, pick subsets, validate metadata, launch resumable jobs, review results, and build publication evidence without needing the full library in RAM.

The 90 TB revision makes copy/fixity/reporting infrastructure mandatory rather than optional. A full checksum or copy-verify pass may take days depending on sustained drive throughput, so every long operation must be resumable, externally inspectable, and safe to stop.

## Operating Modes

CAOS should support two connected modes instead of forcing one workflow onto every data scale.

### Dataset / Repo Mode

Use this mode for bounded, coherent datasets: a public-data repo, a known experiment folder, a validated OME-Zarr set, or a single local package that is small enough to work with directly.

Suggested threshold:

- usually under 1 TB
- coherent source ownership and purpose
- known modality or experiment structure
- manageable file count
- enough free local storage for derivatives or caches

Workflow:

1. Scan the dataset or repo.
2. Checksum if practical or required.
3. Import into the private registry.
4. Convert selected assets.
5. Generate slice caches or previews.
6. Inspect in the Workbench.
7. Measure, annotate, compare, and export publication evidence.

This is the current CAOS inner loop. It remains valid and should stay fast.

### Archive Estate Mode

Use this mode for massive, mixed, long-lived lab archives: tens of TB, many unrelated projects, unclear provenance, mixed publication status, or unclear rights.

Workflow:

1. Record authority and access constraints.
2. Run read-only inventory.
3. Stage checksums and progress logs.
4. Verify any backup or copy target.
5. Import manifests into a private registry.
6. Search, filter, and triage compact indexes.
7. Promote selected assets into bounded worksets.
8. Convert and inspect only those worksets.
9. Export evidence packages from worksets, not from the whole archive.

This is the CAOS outer loop. It controls the archive without pretending the archive is locally interactive.

### Promotion Rule

An archive asset becomes eligible for Dataset / Repo Mode only after a promotion decision records:

- source archive and registry id
- selected asset ids and paths
- known rights/triage status
- checksum or fixity status
- metadata readiness
- intended operation: inspect, convert, measure, publish, or review
- destination workset directory or project id

Promotion is the bridge between the 90 TB estate and the publication-focused Workbench loop.

Current implementation status: `archive_registry.py apply-status-overlay` can rebuild a registry with curated rights, triage, publication, review, blocked-state, and allowed-operation decisions. `archive_registry.py promote-workset` then writes a bounded `workset.json` plus selected-asset JSONL/CSV sidecars. The promotion record captures registry provenance, selected asset ids and paths, rights/triage/publication status counts, checksum coverage, metadata readiness, intended operations, blocked operations, and the destination workset directory. The native Workbench can open `workset.json`, read `workset-assets.jsonl`, show the promoted subset in the existing search, review, and conversion panels, and register that bounded workset with the volume-engine queue. `private_workset_derivative.py` can then turn authorized classic TIFF or supported integer MRC assets into immutable validated OME-Zarr derivatives while leaving raw bytes untouched.

## Current Repo Support

The first beachhead scanner now exists at `workers/ingestion/archive_scanner.py`. It is a read-only, dependency-light CLI for mapping an arbitrary local archive root before any upload, cleanup, conversion, or analysis.

The operator sequence, stop conditions, interruption procedure, fixity acceptance checks, and restore boundary are recorded in `docs/archive-beachhead-runbook.md`. A real LBNL run should follow that runbook rather than invoking the examples below ad hoc.

Fast inventory:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead
```

Inventory plus SHA-256 fixity:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead \
  --checksum sha256
```

Resumable SHA-256 fixity against the same output directory:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead \
  --checksum sha256 \
  --resume-checksums
```

Long-run checkpointed scan:

```bash
python3 workers/ingestion/archive_scanner.py scan /path/to/archive \
  --output-dir ~/Downloads/cell-anatomy-archive-scan \
  --archive-id lbnl-beachhead \
  --checksum sha256 \
  --resume-checksums \
  --progress-interval-files 1000 \
  --progress-interval-seconds 30
```

Current scanner artifacts:

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
- `checksums.jsonl` when `--checksum sha256` is enabled
- `fixity-run.json` when `--checksum sha256` is enabled

Copy or mirror verification:

```bash
python3 workers/ingestion/archive_scanner.py compare-scans \
  ~/Downloads/cell-anatomy-archive-scan-source \
  ~/Downloads/cell-anatomy-archive-scan-target \
  --output-dir ~/Downloads/cell-anatomy-copy-verification \
  --require-checksums
```

Current copy verification artifacts:

- `copy-verification-report.json`
- `copy-verification-mismatches.csv`

Private registry import:

```bash
python3 workers/ingestion/archive_registry.py import-scan \
  ~/Downloads/cell-anatomy-archive-scan \
  --output-dir ~/Downloads/cell-anatomy-private-registry \
  --registry-id lbnl-beachhead-registry
```

Current registry artifacts:

- `private-registry.json`
- `private-registry-assets.jsonl`
- `private-registry-search-index.jsonl`
- `private-registry-review-queue.csv`
- `private-registry-volume-candidates.csv`

Curated status overlay:

```bash
python3 workers/ingestion/archive_registry.py apply-status-overlay \
  ~/Downloads/cell-anatomy-private-registry \
  --overlay ~/Downloads/lbnl-status-overlay.csv \
  --output-dir ~/Downloads/cell-anatomy-private-registry-curated \
  --registry-id lbnl-beachhead-registry-curated
```

Overlay rows can update publication, triage, rights, classification, review, blocked-state, and allowed-operation fields without rescanning raw data. The original registry remains unchanged.

Bounded workset promotion:

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

Current workset artifacts:

- `workset.json`
- `workset-assets.jsonl`
- `workset-assets.csv`
- `workset-review-queue.csv`

Pilot report generation:

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

Current pilot report artifacts:

- `pilot-report.json`
- `pilot-report.md`
- `pilot-assets.csv`
- `pilot-review-queue.csv`

Current lightweight extractors:

- classic TIFF / OME-TIFF header dimensions and dtype
- MRC dimensions, dtype, and header voxel size when present
- Zarr `.zarray` shape, chunks, dtype, compressor, filters, and order
- HDF5 signature detection, with dimensions deferred to a future extractor

Current tests:

- synthetic archive scanner coverage lives in `workers/ingestion/tests/test_archive_scanner.py`
- scanner-to-registry import coverage lives in `workers/ingestion/tests/test_archive_registry.py`
- registry-to-pilot report coverage lives in `workers/ingestion/tests/test_archive_pilot_report.py`
- `make test-ingestion` covers both the public-data pilot and archive scanner
- `make check` now also includes the CAOS project-file tests through `desktop-test-caos`

Important limitation: the scanner and registry importer are not yet a Workbench UI or a cloud sync tool. They produce the first map, live progress checkpoints, review queues, conservative asset status rows, optional reusable fixity records, and copy verification reports so the next layer can be built from evidence.

## Data Readiness Before Analysis

Before meaningful mining or publication work, the archive needs a structured readiness pass.

### 1. Access And Authority

Record:

- who currently has the data
- where the physical data lives
- who owns or controls reuse decisions
- whether LBNL, collaborators, funders, journals, or grants impose restrictions
- whether the archive includes unpublished, sensitive, embargoed, or personally identifying material
- whether external cloud upload is permitted
- whether derived data may be shared, published, or deposited
- who can approve destructive cleanup, if cleanup is ever considered

Minimum artifact:

- `authority-record.json`
- human-readable `AUTHORITY.md`

No cloud upload should occur until this exists.

### 2. Physical And Logical Inventory

The first technical pass should be read-only.

Capture:

- root path
- filesystem type
- total bytes
- file count
- directory count
- extension distribution
- largest files
- duplicate-looking paths
- modified timestamp range
- hidden/system files
- symlinks
- unreadable files
- likely instrument export folders
- likely analysis output folders
- likely publication figure folders
- likely temporary/cache folders

Minimum artifacts:

- `inventory-summary.json`
- `file-manifest.jsonl`
- `extension-summary.csv`
- `largest-files.csv`
- `scan-errors.csv`

Current implementation status:

- `archive_scanner.py scan` emits all five artifacts above.
- The scanner also emits `metadata-extraction.jsonl` and `volume-candidates.csv` during the same pass.
- Symlinks are inventoried without following them.
- Unsupported and proprietary formats are still recorded, but not deeply parsed.

### 3. Checksums And Fixity

Every raw file needs a stable identity. For 90 TB, checksumming is feasible only as a staged, resumable, externally inspectable operation. It should be possible to run fixity in windows, pause it, resume it, audit progress, and compare source and destination manifests without rereading the entire archive unnecessarily.

Capture:

- SHA-256 for all files, or BLAKE3 plus SHA-256 for final archive records
- file size
- modified time
- path
- device/inode where available
- checksum timestamp
- scanner version

Required behavior:

- resumable checksum jobs
- progress log and periodic checkpoint report
- skip unchanged files safely
- recheck sample after copy
- compare manifests between local and cloud copies

Minimum artifacts:

- `checksums.jsonl`
- `fixity-run.json`
- `scan-progress.jsonl`
- `scan-checkpoint.json`
- `copy-verification-report.json`
- `copy-verification-mismatches.csv`

Current implementation status:

- `archive_scanner.py scan --checksum sha256` emits `checksums.jsonl` and `fixity-run.json`.
- `--resume-checksums` uses disk-backed `scan-state.sqlite` and reuses existing checksum rows only when relative path, algorithm, size, modified timestamp, device, and inode still match. Resume is rejected when the archive id or source root changes.
- Duplicate files are detected by matching SHA-256 digests through the same disk-backed index rather than an archive-sized in-memory map.
- Primary manifest/CSV artifacts are staged as `.inprogress` files and replace the last complete artifacts only after a successful traversal. An interrupted run therefore leaves the prior completed artifact set intact.
- Every scanner attempt appends `run_id`-scoped events to `scan-progress.jsonl` and updates `scan-checkpoint.json`; the checkpoint cadence is configurable by file count and seconds.
- `archive_scanner.py scan --preflight-only` validates source/output separation, free space, exclusive locking, and resume identity before a run.
- `archive_scanner.py compare-scans` reconciles two scanner outputs through a disposable SQLite join index and writes `copy-verification-report.json` plus `copy-verification-mismatches.csv` without loading both manifests into RAM.
- Cloud-provider-native checksum verification is still pending; current copy verification compares CAOS scanner artifacts after both sides have been scanned.

### 4. Metadata Extraction

CAOS cannot mine what it cannot understand. The archive needs format detection and metadata extraction independent of whether a file is immediately viewable.

Extract where possible:

- image/volume format
- dimensions
- axis order
- channel count
- timepoints
- dtype
- voxel size and units
- acquisition date
- instrument name
- microscope/modality
- sample name
- experiment/project identifiers
- operator/creator fields if present
- embedded notes
- software provenance
- compression
- chunking/tiling
- readable/unreadable status

Common categories likely to matter:

- TIFF / OME-TIFF
- MRC
- HDF5
- Zarr / OME-Zarr
- proprietary microscope exports
- segmentation masks
- meshes
- spreadsheets or CSV measurements
- notebook/code analysis outputs
- publication figures

Minimum artifacts:

- `metadata-extraction.jsonl`
- `format-summary.csv`
- `volume-candidates.csv`
- `metadata-gaps.csv`

Current implementation status:

- `archive_scanner.py` emits `metadata-extraction.jsonl`, `volume-candidates.csv`, and `metadata-gaps.csv`.
- `extension-summary.csv` currently acts as the first format summary.
- Missing dimensions, dtype, z depth, voxel size, unsupported extractors, and deferred HDF5 internals are promoted into the metadata gap queue.
- Proprietary microscope formats and full HDF5 internals still need follow-up extractors.

### 5. Publication And Triage Linkage

Because much of the archive may already have been used or rejected, every asset should be linked to known scientific status.

Suggested status vocabulary:

- `published_primary`: used directly in a publication
- `published_supplemental`: appeared in supplement or repository
- `publication_candidate`: likely useful for a paper but not yet published
- `internal_reference`: useful internally, not intended for publication
- `triaged_irrelevant`: reviewed and judged not useful
- `triaged_low_quality`: rejected for quality reasons
- `duplicate_or_derived`: not raw primary data
- `restricted`: cannot be shared or processed broadly
- `unknown`: status has not been established

Capture:

- publication title
- DOI / PMID / preprint URL where available
- figure or supplement association
- notebook or analysis folder association
- internal project name
- triage reason
- reviewer
- review timestamp

Minimum artifacts:

- `publication-linkage.csv`
- `triage-status.csv`
- `asset-status-ledger.jsonl`

Current implementation status:

- `archive_scanner.py` seeds `asset-status-ledger.jsonl` for every discovered file.
- Seeded rows keep publication, triage, rights, and classification status as `unknown` / `unreviewed`.
- Cloud backup, conversion, sharing, derivative publication, and public release are disabled by default until a human or registry import upgrades the asset.

### 6. Data Classification

Before backup and cloud processing, classify data by sensitivity and allowed operation.

Suggested fields:

- `can_store_locally`
- `can_backup_to_cloud`
- `can_convert`
- `can_view_in_caos`
- `can_share_with_collaborators`
- `can_publish_derivatives`
- `can_release_publicly`
- `requires_embargo`
- `requires_access_log`
- `license_or_data_use_note`

Minimum artifact:

- `data-use-policy-ledger.csv`

### 7. Backup And Storage Plan

The archive needs separate treatment for raw data and derivatives.

Recommended storage tiers:

- **Raw vault:** immutable or retention-protected copy of original files.
- **Working mirror:** local or cloud copy used for conversion and metadata extraction.
- **Derivative store:** OME-Zarr, previews, masks, feature tables, and CAOS project artifacts.
- **Index database:** searchable metadata, asset states, project links, and analysis results.

Raw data should be write-once from CAOS's perspective. Derivatives may be regenerated, so they should carry pipeline versions and source checksums.

Cloud candidates should be evaluated on:

- institutional approval
- cost for 4+ TB
- retrieval fees
- egress fees
- lifecycle rules
- object versioning or retention lock
- access logging
- IAM/service account model
- transfer tooling
- restore drill support
- compatibility with future compute jobs

The current repo has prior notes favoring GCS, so GCS should be evaluated first, but the architecture should stay object-storage-neutral.

Minimum artifacts:

- `storage-decision.md`
- `bucket-layout.md`
- `restore-drill-report.md`

### 8. Conversion Readiness

Only selected assets should be converted at first. Conversion should be driven by priority, not bulk enthusiasm.

Readiness gates:

- source file readable
- checksum recorded
- dimensions known
- dtype known
- voxel size known or explicitly missing
- axis order known or reviewable
- rights/status allow conversion
- expected derivative size estimated
- output path chosen
- conversion pipeline version recorded

Derivative targets:

- OME-Zarr or another cloud-streamable format for long-term use
- PNG/JPEG preview contact sheets for quick triage
- slice caches where lightweight browser inspection is enough
- downsampled scout volumes for fast navigation

Minimum artifacts:

- `conversion-readiness.csv`
- `derivative-manifest.json`
- `conversion-report.json`
- `preview-index.html`

## Asset Lifecycle Model

CAOS should distinguish the state of a data asset from the state of its derivatives.

Suggested lifecycle:

1. `discovered`: path exists in inventory
2. `checksummed`: fixity recorded
3. `classified`: data-use status assigned
4. `metadata_extracted`: dimensions/format/provenance parsed where possible
5. `linked`: publication or triage status connected
6. `validated`: readable and scientifically interpretable enough for workbench use
7. `mirrored`: verified copy exists in approved storage
8. `streamable`: derivative exists for CAOS viewing
9. `project_ready`: asset can be included in a CAOS project
10. `publication_ready`: asset has enough provenance, measurements, figures, and review for external use

Blocked states should be explicit:

- `blocked_permission`
- `blocked_unreadable`
- `blocked_missing_metadata`
- `blocked_unknown_voxel_size`
- `blocked_format`
- `blocked_quality`
- `blocked_duplicate`
- `blocked_triaged_irrelevant`

## Proposed Cloud Layout

The final layout will depend on storage provider, but CAOS should expect a logical structure like:

```text
cell-anatomy-lbnl/
  raw-vault/
    <asset-id>/
      original-files...
  manifests/
    inventory/
    checksums/
    metadata/
    policy/
  derivatives/
    ome-zarr/
    previews/
    slice-cache/
    downsampled/
  projects/
    caos/
    bundles/
  jobs/
    logs/
    reports/
  exports/
    figures/
    methods/
    measurement-tables/
```

Raw paths should preserve original context, but CAOS should use stable asset IDs rather than relying on fragile folder names.

## CAOS Functionality Needed

The current Workbench already supports local volume opening, slice viewing, measurements, ROIs, local jobs, account pairing groundwork, saved views, and CAOS project import/export. This archive requires a broader layer around those pieces.

### 1. Vault Registry

CAOS needs an asset registry that can hold raw and derivative records.

Required fields:

- asset id
- source archive id
- original path
- normalized title
- file count
- size bytes
- checksum
- format
- dimensions
- dtype
- voxel size
- acquisition metadata
- publication/triage status
- rights/status label
- raw storage location
- derivative locations
- validation status
- pipeline version
- created/updated timestamps

Implementation options:

- start with JSONL/CSV manifests
- promote into Postgres when schema stabilizes
- keep CAOS project files portable and independent

Current implementation status:

- `archive_registry.py import-scan` imports scanner artifacts into a local private registry.
- `archive_registry.py import-public-data` imports the local public-data pilot bundle from `pilot-index.json`, readiness manifests, derivative manifests, and validation records into the same registry artifact shape.
- It emits asset JSONL, a registry summary, a search index, a review queue, and a volume-candidate table.
- Directory-backed candidates such as Zarr stores are represented as logical `directory_volume` assets.
- Public-data OME-Zarr derivatives receive deterministic `sha256-tree-v1` composite checksums and can be marked `project_ready` when validation passed and local metadata is complete.
- The desktop Workbench can open `private-registry.json`, validate the sibling asset/search artifacts, and show registry counts, searchable/filterable project-ready volumes, conversion-queue source assets, and review pressure in the Jobs tab.
- The native desktop Workbench builds a disposable `private-registry-index.sqlite` cache from `private-registry-assets.jsonl`, uses SQLite/FTS for registry search/filter paging, and returns only visible pages to React.
- Conversion-queue registry rows can match the local sidecar index queue by dataset slug and relative path, then start the existing local conversion job when a conversion command is available.
- Selected matched conversion-queue registry rows can now build the same bounded batch-plan shape as public pilot index plans, then start persisted batch runs with checkpoint/resume through the existing volume-engine runner.
- The volume engine can build a dry-run batch conversion plan with total and per-dataset caps, active/completed job skipping, optional failed-job retry inclusion, and an exportable checkpoint payload.
- The volume engine can start a persisted batch conversion run from that plan, keep concurrency bounded, checkpoint the run under the local Workbench state directory, cancel active children, and resume paused/failed runs. The Workbench exposes plan, start, concurrency, cancel, resume, checkpoint path, and recent-run status controls.
- Promoted private worksets register directly with the volume engine; registrations persist across sidecar restarts, TIFF/MRC conversions run through the same job controls, and validated outputs join `workbench-data` for slice and 3D viewing.
- `private_workset_derivative.py` verifies source SHA-256, emits recipe-addressed uncompressed OME-Zarr v2 / OME-NGFF 0.4, checkpoints chunk digests for restart/corruption recovery, records reversible signed-MRC transforms, validates every chunk, and publishes a deterministic output tree checksum.
- The golden archive test covers scanner, SHA-256, registry import, curated status, bounded promotion, conversion, derivative validation, and queue indexing in one synthetic path.
- The public/private Atlas UI is not wired to the registry yet.

### 2. Read-Only Archive Scanner

The scanner should run before any CAOS viewing.

Capabilities:

- walk source folders
- detect common imaging formats
- produce resumable manifests
- compute checksums
- classify by extension and likely role
- identify duplicate checksums
- identify derivative-looking folders
- emit scan errors without failing the whole run
- run locally without cloud credentials

This can start as a CLI under `workers/ingestion/`.

### 3. Metadata Extractors

CAOS needs format-specific metadata extractors. They should be dependency-light where possible but not so minimal that important metadata is lost.

Needed extractors:

- TIFF / OME-TIFF
- MRC
- Zarr / OME-Zarr
- HDF5 where relevant
- common microscope sidecars
- CSV/spreadsheet measurement tables
- simple image previews

Extraction should record confidence and source:

- `embedded_authoritative`
- `sidecar_authoritative`
- `inferred_from_filename`
- `manual_curated`
- `missing`
- `conflicting`

### 4. Conversion Pipeline

CAOS needs a durable derivative factory.

Features:

- source-to-OME-Zarr conversion
- chunk and downsample policy
- preview generation
- validation after conversion
- source checksum embedded in derivative manifest
- pipeline version recorded
- retryable jobs
- cancellation
- logs and failure reasons
- no overwrite without explicit version bump

The current volume engine reads strict raw uncompressed 3D Zarr v2 arrays. For this project, CAOS should keep that reader strict while adding a stronger conversion path that produces known-compatible derivatives.

The first private derivative factory now implements the strict compatible subset: classic uncompressed 8/16-bit TIFF / OME-TIFF and MRC modes 0, 1, and 6 become single-scale uncompressed OME-Zarr. It gates on promoted permissions, metadata readiness, and source SHA-256; records immutable recipes and provenance; resumes only digest-valid chunks; rejects output drift and recipe collisions; and exposes results through the volume engine. The remaining pipeline work is multiscale/compression policy, previews, explicit recipe supersession, float readers, and real-fixture HDF5/BigTIFF/proprietary adapters.

### 5. Private Atlas / Archive Search

The public Atlas is about literature. This project needs a private registry view for the LBNL archive.

Search facets:

- project
- publication status
- organism / cell type / structure if known
- modality
- format
- voxel size
- dimensions
- date range
- owner / lab
- quality status
- conversion status
- rights status
- derivative availability

The private Atlas should not imply public release. It is an internal map of the archive.

### 6. Project Schema Expansion

The current `cell-anatomy-caos-project` schema is a good start. It should be extended carefully.

Needed additions:

- stricter measurement schema
- stricter ROI schema
- source asset IDs
- derivative IDs
- account-compatible project IDs
- project-level status
- multi-volume support
- publication links
- review state
- analysis job references
- export records
- figure records
- provenance bundle metadata

The v1 single-active-volume meaning should remain stable. Multi-volume projects should be additive.

### 7. Measurements And ROIs

Measurements and ROIs should become first-class scientific objects, not just UI annotations.

Needed:

- explicit units
- voxel coordinate and physical coordinate
- linked view state
- source volume fingerprint
- reviewer/creator
- confidence or caveat fields
- category labels
- optional structure ontology field
- export schema
- validation before project export

### 8. Job System

The current local job surface can grow into a real CAOS job model.

Near-term jobs:

- project audit
- ROI inventory
- histogram summary
- preview generation
- OME-Zarr conversion
- metadata extraction
- checksum verification
- quality report
- figure export

Medium-term jobs:

- mask import/export
- segmentation helper
- feature extraction
- image similarity / embedding generation
- cross-volume registration exploration
- batch measurement summaries
- publication package generation

Every job should record:

- input asset IDs
- input checksums
- parameters
- code/pipeline version
- output paths
- logs
- status
- failure reason
- runtime environment

### 9. Cloud Storage Adapter

CAOS should not hardcode one cloud provider into product semantics. It should have a storage adapter layer.

Needed operations:

- list approved bucket/prefix
- upload manifest
- upload raw copy only from approved flow
- upload derivative
- verify remote checksum
- fetch signed/read URL for derivative
- compare local and remote manifest
- mark asset as mirrored
- mark derivative as streamable

Provider-specific config should live outside project files.

### 10. Access And Account Boundary

Account-backed project storage is useful later, but dangerous if rushed.

Needed before enabling:

- reliable transactional email
- device pairing confidence
- clear data retention policy
- project delete/export behavior
- privacy/security contact
- audit log for cloud-backed actions
- permission model for private archive data

Until then:

- CAOS project files stay local/exported JSON
- local data stays local
- device pairing may identify a Workbench, but not imply raw data sync

### 11. Publication Package Generator

This is the feature that makes CAOS more than a viewer.

A package should include:

- project file
- source asset list
- source checksums
- derivative manifest
- measurements CSV/JSON
- ROI JSON
- figure exports
- view-state metadata
- scale/voxel metadata
- methods card
- publication/citation records
- known caveats
- job logs

This package should be useful for papers, supplements, internal review, grant figures, and reproducibility records.

## Pilot Plan

Do not start with the whole 90 TB estate. Start with three representative subsets.

### Pilot A: Published Dataset

Purpose:

- prove that CAOS can reconstruct a known publication path
- validate citation/provenance handling
- compare raw data, derived data, and final published outputs

Deliverables:

- manifest
- checksums
- publication linkage
- one streamable derivative
- one CAOS project
- one figure/provenance package

### Pilot B: Triaged Irrelevant Dataset

Purpose:

- prove that CAOS can preserve negative or rejected decisions
- avoid rediscovering why data was not useful
- test quality and triage vocabulary

Deliverables:

- manifest
- triage status record
- quality/metadata report
- preview sheet if allowed
- CAOS note explaining why it is not promoted

### Pilot C: Unmined Candidate Dataset

Purpose:

- search for new value
- test measurement/ROI/job workflow
- assess whether CAOS can support a new analysis question

Deliverables:

- manifest
- metadata report
- streamable derivative
- CAOS project with ROIs/measurements
- publication-potential memo
- recommended next analysis jobs

## Milestones

### Milestone 0: Authority And Safety

- identify data owner and approval path
- define allowed operations
- choose local staging drive/location
- confirm no raw mutation
- draft data-use ledger

Exit criteria:

- written authority record exists
- read-only scan is approved

### Milestone 1: Inventory

- run `archive_scanner.py scan` read-only
- produce file manifest
- produce size and extension summaries
- identify unreadable/problem paths
- estimate checksum runtime

Exit criteria:

- archive has a stable inventory
- no cloud movement yet
- `inventory-summary.json` and `file-manifest.jsonl` are reviewed before any checksum or conversion job is started

### Milestone 2: Fixity

- run `archive_scanner.py scan --checksum sha256 --resume-checksums` for staged SHA-256 fixity
- verify a second copy or sample copy
- produce fixity report

Exit criteria:

- raw data identity is known
- copy/backup plan can be evaluated honestly
- duplicate checksums and checksum errors have been reviewed

### Milestone 3: Classification

- classify publication/triage status for pilot subsets
- classify rights/storage permissions
- identify high-value candidates

Exit criteria:

- at least three pilot subsets selected
- each has explicit status and allowed operations

### Milestone 4: CAOS Pilot Derivatives

- convert one asset per pilot where allowed
- generate previews
- open in Workbench
- create project files
- export project packages

Exit criteria:

- CAOS can operate on real LBNL-derived assets end to end

### Milestone 5: Cloud Backup / Mirror

- choose storage provider and class
- define bucket layout
- run small upload test
- verify checksums after upload
- run restore drill
- only then consider larger upload

Exit criteria:

- backup is proven by restore, not assumed by upload

### Milestone 6: Mining And Publication Workflows

- define biological questions
- run measurement/ROI/job workflows
- compare with published records
- produce candidate findings
- route findings through scientific review

Exit criteria:

- at least one reusable figure, methods card, or candidate insight package exists

## Immediate Engineering Tasks

1. Add richer local extractors and fixtures as real LBNL formats and failure modes are discovered.
2. Extend the private derivative factory from its tested classic TIFF and integer-MRC beachhead to real-fixture HDF5/BigTIFF/proprietary readers, then add multiscale/compression/preview policy and explicit recipe supersession.
3. Add local mining summaries over bounded worksets: feature tables, duplicate/near-duplicate candidates, quality flags, morphology summaries, and publication-candidate evidence.
4. Add cloud-provider-native copy verification where available, using source and remote checksums before or instead of rereading all bytes.

Completed in the repo:

- `workers/ingestion/archive_scanner.py` read-only inventory CLI
- `file-manifest.jsonl` first-pass schema
- `metadata-extraction.jsonl` first-pass schema
- `metadata-gaps.csv`
- `volume-candidates.csv`
- `asset-status-ledger.jsonl` conservative status seed
- SHA-256 checksum mode
- disk-backed resumable checksum reuse and duplicate tracking for unchanged files, bound to source archive id/root plus file device/inode identity
- staged scanner artifacts that preserve the last complete outputs across interruption
- scanner output-directory lock and `--preflight-only` safety report
- scanner `scan-progress.jsonl` and `scan-checkpoint.json` artifacts for long-running inventory/checksum runs
- `archive_scanner.py compare-scans` disk-backed copy/mirror verification reports over two scanner output directories
- `workers/ingestion/archive_registry.py` private registry importer
- disk-backed private registry import joins with streamed review/candidate outputs
- `archive_registry.py import-public-data` public pilot registry adapter
- `private-registry-assets.jsonl` first-pass registry asset schema
- `private-registry-search-index.jsonl`
- `private-registry-review-queue.csv`
- `archive_registry.py apply-status-overlay` curated registry rebuilds for publication, triage, rights, blocked-state, and allowed-operation decisions
- `status-overlay-unmatched.csv` audit output for overlay rows that did not match registry assets
- `archive_registry.py promote-workset` bounded workset promotion artifacts with registry provenance
- enforced 10,000-asset promotion cap and streaming query selection without a full-registry in-memory search map
- `workset.json`, `workset-assets.jsonl`, `workset-assets.csv`, and `workset-review-queue.csv`
- Workbench private registry reader for `private-registry.json`
- Workbench registry panel grouping for project-ready assets, conversion queue assets, and review pressure
- Workbench registry search/filter controls for path, format, dtype, status, metadata gaps, readiness, review pressure, and sidecar-matched conversion assets
- Workbench bounded native registry query command that pages project-ready, conversion-queue, and review rows without loading full asset JSONL into React
- Workbench disposable SQLite/FTS registry cache at `private-registry-index.sqlite`, rebuilt automatically when `private-registry-assets.jsonl` changes
- Workbench `workset.json` opener that reads `workset-assets.jsonl`, normalizes promoted assets into the local registry model, shows selected workset scope/readiness, and reuses registry search/review/conversion panels
- Workbench project creation and native save from an unambiguously matched project-ready registry/workset asset, with registry and workset provenance preserved in the project volume manifest
- Workbench registry-to-index-queue bridge that can start matched local conversion jobs from conversion-queue rows
- Workbench selected-registry conversion batch planner that turns matched private-registry conversion rows into persisted batch runs
- Volume-engine dry-run batch conversion planner with total/per-dataset caps, active/completed job skips, failed-job retry policy, and checkpoint payloads
- Volume-engine persisted batch conversion run registry with bounded concurrency, checkpoint files, cancel, resume, and child-job reconciliation
- Workbench batch conversion plan controls, checkpoint export, configurable concurrency, start-run, cancel, resume, and recent-run status
- `private_workset_derivative.py` permission-gated immutable TIFF/MRC-to-OME-Zarr conversion with source/output checksums, provenance, validation, signed-value transforms, and digest-verified resume checkpoints
- Volume-engine private-workset registration, persistent restart recovery, private queue/job/batch routing, and derivative loading into Workbench slice/3D endpoints
- packaged desktop ingestion worker resources plus repo/resource-root handoff to the volume-engine sidecar
- golden synthetic archive test from scan and SHA-256 through registry, status overlay, promotion, conversion, validation, and indexed queue state
- archive/private status fields in CAOS project volume references
- `workers/ingestion/archive_pilot_report.py` local pilot report generator
- `pilot-report.json`, `pilot-report.md`, `pilot-assets.csv`, and `pilot-review-queue.csv`
- deterministic `sha256-tree-v1` composite checksum records for imported OME-Zarr directory volumes
- scanner tests on synthetic folders
- stricter CAOS project validation for measurements, ROIs, local jobs, active volume fingerprints, and stable dirty-state signatures

## Immediate Product Tasks

1. Identify who can approve storage, conversion, and reuse.
2. Pick the three pilot subsets.
3. Define the publication/triage status vocabulary with the lead.
4. Decide whether the first cloud target is GCS, institutional storage, Backblaze B2, AWS, or a local NAS-first approach.
5. Decide what "new insight" means for the first mining pass: morphology, quality, reuse, comparison, segmentation training data, or publication figure generation.
6. Decide who reviews any candidate biological findings.

## Risks

- Cloud upload without permission creates institutional or legal problems.
- Raw files are accidentally altered during cleanup or conversion.
- Voxel metadata is missing or wrong, causing invalid measurements.
- Archive structure encodes project knowledge that is lost if paths are flattened.
- Data has already been triaged for reasons not visible in files.
- Cost is underestimated because retrieval, egress, and duplicate derivatives are ignored.
- CAOS becomes a viewer instead of a provenance engine.
- Account sync is promoted before privacy and retention obligations are clear.
- Mining produces plausible-looking but scientifically weak findings.

## Open Questions

- What formats dominate the archive?
- How many files versus how many true volume assets?
- Which data is raw acquisition versus processed derivative?
- What publications does the archive map to?
- What data is unpublished but scientifically reusable?
- What data is restricted by collaboration, grant, journal, or institutional policy?
- Is cloud upload permitted, and to which provider/account?
- What restore time is acceptable?
- Who will pay recurring storage costs?
- What is the first scientific question CAOS should help answer?
- What is the minimum project package that would be useful to the lead?

## Definition Of Done For The Beachhead

The beachhead is successful when:

- the archive has a read-only inventory
- raw files have fixity records
- at least one backup/mirror path has been tested by restore
- pilot subsets have explicit publication/triage/status labels
- at least one representative volume opens in CAOS from a validated derivative
- CAOS project export captures source, view, measurement/ROI/job state, and provenance
- a publication-style package can be exported from a pilot project
- the team can decide what to mine next from evidence, not guesswork

## External Standards And Storage References

- OME-Zarr / OME-NGFF: https://ngff.openmicroscopy.org/specifications/
- Google Cloud Storage classes: https://docs.cloud.google.com/storage/docs/storage-classes
- Google Cloud Storage pricing and retrieval notes: https://cloud.google.com/storage/pricing
- AWS S3 Glacier storage classes: https://aws.amazon.com/s3/storage-classes/glacier/
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
