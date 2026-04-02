# Scion API

FastAPI backend for the Scion MVP.

## Responsibilities

- dataset lookup
- facet summaries
- commonality summaries
- compare mode
- future curation and ingestion APIs

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
.venv/bin/python -m uvicorn app.main:app --reload
```
