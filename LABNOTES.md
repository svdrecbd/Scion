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

### Phase 4: Scientific Utility & Polish
- Implemented **Export Engine** (CSV and JSON streaming).
- Added **Citation Engine** (APA formatting).
- Applied "Scion Style": sharp-edged (0px radius), EB Garamond typography, and soft dark-grey theme.

## dead ends & decisions

- **Rejected: Docker**. Decided native Postgres setup aligns better with the "no-bloat" ethos and reduces overhead for local dev.
- **Decision: Raw SVG**. Rejected Recharts/D3 to keep the frontend bundle under 100KB and ensure pixel-perfect typography integration.
- **Decision: Borderline Studies**. Instead of excluding near-misses, we chose to "badge and reveal" to maximize evidence transparency.

## Team Rules

1. Correctness > operational simplicity > feature breadth.
2. The URL is the canonical state.
3. No silent failures.
4. No bold headers.
5. 0px border radius is the law.

## Future Phase: Full Data Scion (The 3TB Horizon)

Theory crafting for the transition from a Metadata Atlas to a unified Volumetric Laboratory.

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
