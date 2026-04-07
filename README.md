# Scion

Scion is a structured lookup and comparison layer for whole-cell imaging datasets. It acts as a specialized discovery engine for researchers to synthesize evidence across the structural organization of the cell.

**“PubMed + compare mode for whole-cell datasets.”**

## Core capabilities

- **Discovery Engine**: Search and filter the corpus by cell type, organelle, organelle pair, modality, or metric.
- **Analytics Suite**: Visualize the Imaging Frontier (Res vs SS), Toolkit Matrix (Organelle vs Modality), and Gap Finder (White-Space Exploration).
- **Experiment Assistant**: A feasibility engine that validates new experiment plans against historical benchmarks.
- **Comparison Workbench**: Side-by-side technical alignment with shared-trait highlighting and comparability scoring.
- **Scientific Utility**: Copy-paste APA citations and export filtered result sets as standardized CSV or JSON.

## Why this exists

Researchers can usually find individual papers and repositories. What is still hard is answering questions like:

- Where else has this cell type shown up with this specific resolution?
- Which organelle pairs recur across the literature?
- What are the achievable sample sizes for this modality?
- Which datasets are actually comparable for a pooled analysis?

Scion is meant to make those questions fast and metadata-native.

## Quick start (Native MacOS)

Scion follows a "no-bloat" ethos and runs natively without Docker. Native Postgres is the only supported local database path.

```bash
# 1. Install Postgres (if not already present)
brew install postgresql@16
brew services start postgresql@16

# 2. Setup project
make bootstrap
make db-migrate
make db-seed

# 3. Start the managed stack
make stack-up
```

Then open:
- **Web**: `http://localhost:3000`
- **API**: `http://localhost:8000/docs`

Useful lifecycle commands:

```bash
make stack-status
make stack-down
```

If you need to run services separately instead of the managed stack:

```bash
make api
make web
```

For active development with reload or HMR:

```bash
make api-dev
make web-dev
```

Verification:

```bash
make check
```

`make check` runs API tests, web typecheck, a production build, and a stack smoke test against a temporary seeded Postgres database.

## Design principles

1. **Comparability over completeness**  
   Standardize the technical slice of the world that can actually be compared.

2. **Provenance over hand-waving**  
   Every record includes direct links to source publications (PMIDs) and raw data repositories.

3. **Queryability over polish**  
   A credible lookup engine beats a fancy viewer with weak search semantics.

4. **Zero-Bloat Engineering**  
   Custom SVG/CSS visualizations, regular weight typography (EB Garamond), and sharp-edged (0px) aesthetic.

## Current status

- [x] Native Postgres repository layer with SQL-level filtering.
- [x] Full Discovery UI with faceted search.
- [x] Comprehensive Analytics (Frontier, Toolkit, Gaps).
- [x] Experiment Planning Assistant (Feasibility scoring).
- [x] Borderline study explorer for "near-miss" transparency.
- [x] Export Engine (CSV/JSON).

## Repository structure

- `apps/web` – Thin Next.js frontend (Server Components focus)
- `apps/api` – FastAPI backend (Repository pattern)
- `db` – Forward-only SQL migrations
- `references/manifests` – Generated corpus metadata (118 datasets)
- `LABNOTES.md` – Internal architecture decisions and technical journal
- `ONBOARDING.md` – Contributor orientation
