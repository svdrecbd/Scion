# Mirvis Corpus Manifest

This directory contains machine-readable manifests derived from the upstream repository:

- repo: https://github.com/mmirvis/Cell-Anatomy-Scoping-Review.git
- commit: `a2218f4e65818f3187f2b3c050690bd16fd21c6e`

Files:

- `study_manifest.csv` - included and borderline study-level records
- `public_data_assets.csv` - public dataset locations, links, formats, and reported sizes
- `corpus_locator.csv` - dataset-level locator table joined with study and public-asset metadata
- `manifest_summary.json` - machine-readable summary counts

Regenerate:

- `python scripts/build_mirvis_manifest.py`

Current counts:

- included studies: 89
- borderline studies: 39
- public asset rows: 12
- dataset locator rows: 118

Reported public-data footprint:

- included studies only: 1.831 TB to 1.834 TB
- including the one borderline public row: 2.931 TB to 2.934 TB

Notes:

- These totals come from the sizes reported in `Additional file 3_publicdatasets.xlsx`.
- Some size fields are ambiguous in the source workbook. The CSV preserves both the raw size string and any parse note.
- `corpus_locator.csv` is the most useful operational table when the question is "what dataset exists and where does its public data live?"
