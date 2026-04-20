# Scion Lab Notes

This is the internal working notebook for Scion.

## Completed Technical Phases

### Phase 1: Real Persistence
- Replaced mock-driven repositories with native Postgres.
- Moved all search and faceted filtering logic into SQL `WHERE` clauses.
- Standardized schema for biological targets (organelles, pairs).

### Phase 2: Analytics & Insight Layer
- Built the **Imaging Frontier Plot**: SVG scatter plot with log-scale resolution.
- Built the **Imaging Toolkit**: adaptive dot matrix for organelle vs modality mapping.
- Built the **Gap Finder**: density-based heatmap for identifying research white-space.
- All visualizations are fully interactive and link back to specific search results.

### Phase 3: Decision Support (Planner)
- Built the **Experiment Assistant**: A feasibility engine that benchmarks new plans against historical data.
- Added status-based reporting (Feasible / High-Risk) based on physical limits of the frontier.
- Integrated automated Baseline Data discovery for segmentation training sets.
- Added multi-organelle planner queries, optional resolution/sample-size thresholds, PMID export, and a table-first precedent view.

### Phase 4: Scientific Utility & Polish
- Implemented **Export Engine** (CSV, JSON, and BibTeX).
- Added record-level citation copy support in the dataset detail view.
- Applied "Scion Style": sharp-edged (0px radius), EB Garamond typography, and soft dark-grey theme.

### Phase 5: Hardening & Operations
- Removed Docker from the supported local workflow.
- Added managed native stack scripts, readiness checks, and structured request/query logging.
- Added DB-backed API integration tests and a full stack smoke test.
- Shifted more expensive analytics/search work into SQL to keep the API fast and low-bloat.
- Fixed CI so local `Makefile` targets work both with the repo venv and with GitHub Actions runner Python.

### Phase 6: Public Data Pilot Ingestion
- Added a dependency-light EMPIAR/Figshare pilot worker for public-data mirroring tests.
- Pilot outputs download manifests, checksum file inventories, normalized asset manifests, validation reports, and middle-slice previews.
- Added offline reruns from cached source metadata plus cached download manifests, so local validation can be repeated without network.
- Added an asset-state manifest that separates `source_asset`, `mirrored_asset`, `validated_volume`, and `streamable_derivative`.
- Added a conversion-readiness manifest and curation review queue so validated volumes can be separated from blocked assets before OME-Zarr work.
- Added a local pilot index page across mirrored datasets for quick inspection and dataset selection.
- Added a dependency-light OME-Zarr conversion spike that writes a single-scale Zarr v2 / OME-NGFF derivative for one validated TIFF volume and records it in a derivative manifest.
- Added a native Scion Slice Viewer path: sampled browser PNG planes, `slice-manifest.json`, and a local-only `/pilot/viewer` route for fast inspection before heavier OME-Zarr/Neuroglancer integration.
- Added non-network ingestion unit tests for metadata source priority, TIFF/ImageJ scale extraction, TrakEM2 calibration sidecars, MRC default-scale warnings, Figshare z-spacing warnings, and collection-level imageset-count warnings.
- First validated pilot: Rudlaff 2020 / EMPIAR-10392, 11 files, 3.938 GiB, MRC plus TIFF.
- Second validated pilot: Uwizeye 2021b / EMPIAR-10672, 8 files, 2.915 GiB, recursive EMPIAR folders and TIFF-only volumes.
- Third validated pilot: Laundon 2019 / Figshare-7346750, 30 files, 3.019 GiB, TIFF volumes plus TrakEM2 XML sidecars.
- Hardening finding: raw file headers are not authoritative by default. Rudlaff MRC headers encode default-looking physical scale while curated metadata says 10 x 10 x 20 nm.
- Hardening finding: EMPIAR imageset metadata can be collection-level rather than file-level. Uwizeye reports 500 images for one imageset spanning 8 local TIFF files and 4848 total local slices.
- Hardening finding: Figshare TIFFs may need paired TrakEM2 XML calibration sidecars for physical voxel size. Laundon has one TIFF held at `needs_review` because the parsed z-spacing is suspiciously small.

## dead ends & decisions

- **Rejected: Docker**. Decided native Postgres setup aligns better with the "no-bloat" ethos and reduces overhead for local dev.
- **Decision: Raw SVG**. Rejected Recharts/D3 to keep the frontend bundle under 100KB and ensure pixel-perfect typography integration.
- **Decision: Borderline Studies**. Instead of excluding near-misses, we chose to "badge and reveal" to maximize evidence transparency.
- **Decision: Thin frontend**. The main latency pressure is page composition, not the API. Keep backend semantics strong and avoid frontend-state bloat unless the product genuinely needs it.
- **Decision: Full-data ingest starts as audit-first**. Before conversion or serving, every public dataset must produce a reproducible manifest, checksum inventory, scale/provenance decision, validation report, and preview page.
- **Decision: Native viewer before Neuroglancer**. Scion should own the default low-bloat slice-viewing experience. Neuroglancer belongs behind an advanced-viewer path until user needs justify deeper integration or a maintained fork.

## Team Rules

1. Correctness > operational simplicity > feature breadth.
2. The URL is the canonical state.
3. No silent failures.
4. No bold headers.
5. 0px border radius is the law.

## Collaboration notes

- Safe copy-edit surfaces usually live in:
  - `apps/web/app/guide/page.tsx`
  - `apps/web/app/page.tsx`
  - `apps/web/app/analytics/page.tsx`
  - `apps/web/app/plan/page.tsx`
  - `apps/web/components/navbar.tsx`
- If a collaborator is mostly editing language, GitHub web editing is enough.
- If a collaborator is changing behavior, they should use a branch/PR flow even if they have write access.

## Future Phase: Full Data Scion (The 3TB Horizon)

Theory crafting for the transition from a Metadata Atlas to a unified Volumetric Laboratory.

### Pinned Note (2026-04-04)

Full-data discussion is paused while Phase 1 UX and guidance are tightened.

- Preferred cloud target is `GCS`.
- We need to treat acquisition states explicitly:
  - `indexed`: Scion knows the study and asset exists.
  - `mirrored`: We have a verified copy with provenance and checksums.
  - `streamable`: The mirrored asset has been validated and converted into a serving format such as OME-Zarr.
- The key operational mistake to avoid is treating "we obtained the files once" as equivalent to "this dataset is ready for the product."
- Before any asset is considered production-grade, Scion needs an ingestion contract covering:
  - permission to mirror
  - permission to transform
  - permission to re-serve or stream
  - source locator and citation requirements
  - file manifest and checksums
  - format/axis/voxel metadata
  - pipeline version and validation status
- The main risks are not storage alone. They are permissions, provenance, metadata quality, and reproducible transforms.
- When full-data work resumes, the next design pass should define:
  - the asset schema in Postgres
  - GCS bucket layout
  - worker stages
  - what makes a dataset move from indexed -> mirrored -> streamable

### 1. The Blueprint
- **Unified Volumetric Viewer**: Web-native 3D slicing (Neuroglancer/OME-Zarr) to compare volumes side-by-side without downloads.
- **Cross-Study "Virtual Staining"**: Unified segmentation overlays. Toggle "Mitochondria" across 15+ different studies simultaneously.
- **Universal Metric Engine**: Move from reporting author claims to calculating metrics (Volume, SA) using standardized, re-run algorithms to eliminate inter-lab bias.
- **Image-to-Image Similarity**: Visual search using structural embeddings (e.g., "Find cells with mitochondria that look like this").
- **IMAGE-NET for Biology**: A definitive source for ML researchers to download 100k+ "Verified Organelle" slices for training.

### 2. Technical Implications of the 3TB Manifest
- **Infrastructural Shift**: Move from 127.0.0.1 to Cloud Object Storage (S3/GCS). "Analyze-in-place" model to minimize egress costs.
- **OME-Zarr Streaming**: All raw data must be converted to chunked OME-Zarr to allow KB-sized tile requests instead of TB-sized downloads.
- **Spatial Indexing**: The manifest must move from text-search to coordinate-search (e.g., "Mitochondria at X,Y,Z").
- **Normalization Factory**: The hardest part. Re-scaling and re-orienting 3TB of data from 118 disparate papers into a common Reference Space.
