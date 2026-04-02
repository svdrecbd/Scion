# Ingestion scaffold

This directory is where source-specific ingestion code should live.

For the MVP, the goal is not full automation. The goal is a repeatable path from raw source metadata to a validated Scion dataset record.

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

## Output contract

Each adapter should emit canonical records that match the API schema in `apps/api/app/schemas.py`.
