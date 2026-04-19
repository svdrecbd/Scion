from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import logging
from time import perf_counter
from typing import Any, Protocol

from app.config import get_settings
from app.db import get_connection
from app.observability import duration_ms_since, operation_log_level, with_request_context
from app.schemas import DatasetRecord
from app.services.search import summarize_commonalities, summarize_facets

query_logger = logging.getLogger("scion.query")

DATASET_SELECT_COLUMNS = """
    dataset_id,
    title,
    paper_title,
    year,
    source,
    source_type,
    public_data_status,
    species,
    cell_type,
    tissue_or_system,
    comparator_class,
    comparator_detail,
    modality,
    modality_family,
    lateral_resolution_nm,
    axial_resolution_nm,
    isotropic,
    organelles,
    organelle_pairs,
    metric_families,
    sample_size,
    sample_size_bucket,
    metadata_completeness_score,
    whole_cell_boundary_confirmed,
    notes,
    source_study_id,
    publication_pmid,
    source_publication_url,
    public_locator_urls,
    included_status
"""

ANALYTICS_DIMENSIONS = {
    "dataset_id": "dataset_id",
    "title": "title",
    "paper_title": "paper_title",
    "year": "year",
    "source": "source",
    "source_type": "source_type",
    "public_data_status": "public_data_status",
    "species": "species",
    "cell_type": "cell_type",
    "tissue_or_system": "tissue_or_system",
    "comparator_class": "comparator_class",
    "comparator_detail": "comparator_detail",
    "modality": "modality",
    "modality_family": "modality_family",
    "sample_size_bucket": "sample_size_bucket",
    "whole_cell_boundary_confirmed": "whole_cell_boundary_confirmed",
    "included_status": "included_status",
    "organelles": "(organelles)[1]",
    "organelle_pairs": "(organelle_pairs)[1]",
    "metric_families": "(metric_families)[1]",
}

PUBLIC_DATA_STATUSES = ("complete", "partial", "none")


@dataclass(frozen=True)
class DatasetSearchPage:
    total: int
    results: list[DatasetRecord]


class DatasetRepository(Protocol):
    def search_datasets(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int,
    ) -> DatasetSearchPage: ...

    def list_datasets(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int | None = None,
    ) -> list[DatasetRecord]: ...

    def get_search_commonalities(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int = 5,
    ) -> dict[str, list[str]]: ...

    def get_dataset(self, dataset_id: str) -> DatasetRecord | None: ...

    def get_datasets_by_ids(self, dataset_ids: Sequence[str]) -> list[DatasetRecord]: ...

    def get_cross_tab(
        self,
        *,
        row: str,
        col: str,
        include_borderline: bool = True,
    ) -> dict[str, Any]: ...

    def get_frontier_data(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> list[dict[str, Any]]: ...

    def get_toolkit_matrix(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]: ...

    def get_measurement_grammar(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]: ...

    def get_reusability_map(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]: ...

    def get_coverage_atlas(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]: ...

    def get_corpus_timeline(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]: ...

    def get_benchmarks(self, *, include_borderline: bool = True) -> list[dict[str, Any]]: ...

    def get_facets(self, *, include_borderline: bool = False) -> dict[str, list[tuple[str, int]]]: ...

    def get_similar_datasets(
        self,
        target: DatasetRecord,
        *,
        limit: int = 4,
    ) -> list[DatasetRecord]: ...

    def list_plan_datasets(
        self,
        organelles: Sequence[str],
        *,
        include_borderline: bool = True,
    ) -> list[DatasetRecord]: ...


def _row_to_dataset(row: dict) -> DatasetRecord:
    return DatasetRecord(
        dataset_id=row["dataset_id"],
        title=row["title"],
        paper_title=row["paper_title"],
        year=row["year"],
        source=row["source"],
        source_type=row["source_type"],
        public_data_status=row["public_data_status"],
        species=row["species"],
        cell_type=row["cell_type"],
        tissue_or_system=row["tissue_or_system"],
        comparator_class=row["comparator_class"],
        comparator_detail=row["comparator_detail"],
        modality=row["modality"],
        modality_family=row["modality_family"],
        lateral_resolution_nm=row["lateral_resolution_nm"],
        axial_resolution_nm=row["axial_resolution_nm"],
        isotropic=row["isotropic"],
        organelles=row["organelles"] or [],
        organelle_pairs=row["organelle_pairs"] or [],
        metric_families=row["metric_families"] or [],
        sample_size=row["sample_size"],
        sample_size_bucket=row["sample_size_bucket"],
        metadata_completeness_score=row["metadata_completeness_score"],
        whole_cell_boundary_confirmed=row["whole_cell_boundary_confirmed"],
        notes=row["notes"],
        source_study_id=row["source_study_id"],
        publication_pmid=row["publication_pmid"],
        source_publication_url=row["source_publication_url"],
        public_locator_urls=row["public_locator_urls"] or [],
        included_status=row["included_status"],
    )


def _normalize_cross_tab_value(value: object) -> str:
    if value is None:
        return "none"
    if isinstance(value, list):
        value = value[0] if value else "none"

    text = str(value).strip()
    return text or "none"


def _build_cross_tab_response(counts: Sequence[tuple[str, str, int]]) -> dict[str, Any]:
    table: dict[str, dict[str, int]] = {}
    row_totals: dict[str, int] = {}
    col_totals: dict[str, int] = {}

    for row_value, col_value, count in counts:
        table.setdefault(row_value, {})[col_value] = count
        row_totals[row_value] = row_totals.get(row_value, 0) + count
        col_totals[col_value] = col_totals.get(col_value, 0) + count

    return {
        "table": table,
        "row_totals": row_totals,
        "col_totals": col_totals,
        "rows": sorted(row_totals.keys()),
        "cols": sorted(col_totals.keys()),
    }


def _build_measurement_grammar_response(counts: Sequence[tuple[str, str, int]]) -> dict[str, Any]:
    matrix: dict[str, dict[str, int]] = {}
    organelle_totals: dict[str, int] = {}
    metric_totals: dict[str, int] = {}

    for organelle, metric_family, count in counts:
        normalized_count = int(count)
        matrix.setdefault(organelle, {})[metric_family] = normalized_count
        organelle_totals[organelle] = organelle_totals.get(organelle, 0) + normalized_count
        metric_totals[metric_family] = metric_totals.get(metric_family, 0) + normalized_count

    organelle_diversity = {
        organelle: len(metric_counts)
        for organelle, metric_counts in matrix.items()
    }
    organelles = sorted(
        matrix.keys(),
        key=lambda organelle: (
            -organelle_diversity[organelle],
            -organelle_totals[organelle],
            organelle,
        ),
    )
    metric_families = sorted(
        metric_totals.keys(),
        key=lambda metric_family: (-metric_totals[metric_family], metric_family),
    )

    return {
        "matrix": matrix,
        "organelles": organelles,
        "metric_families": metric_families,
        "organelle_totals": organelle_totals,
        "metric_totals": metric_totals,
        "organelle_metric_family_counts": organelle_diversity,
    }


def _build_reusability_map_response(
    status_counts: Sequence[tuple[str, str, int]],
    reusable_traits: Sequence[tuple[str, str, str]],
) -> dict[str, Any]:
    matrix: dict[str, dict[str, int]] = {}
    row_totals: dict[str, int] = {}
    reusable_totals: dict[str, int] = {}
    reusable_modality_families: dict[str, set[str]] = {}
    reusable_metric_families: dict[str, set[str]] = {}

    for organelle, status, count in status_counts:
        normalized_count = int(count)
        matrix.setdefault(organelle, {status_name: 0 for status_name in PUBLIC_DATA_STATUSES})
        matrix[organelle][status] = normalized_count
        row_totals[organelle] = row_totals.get(organelle, 0) + normalized_count
        if status != "none":
            reusable_totals[organelle] = reusable_totals.get(organelle, 0) + normalized_count

    for organelle, modality_family, metric_family in reusable_traits:
        reusable_modality_families.setdefault(organelle, set()).add(modality_family)
        reusable_metric_families.setdefault(organelle, set()).add(metric_family)

    public_share = {
        organelle: round(reusable_totals.get(organelle, 0) / total, 3) if total else 0
        for organelle, total in row_totals.items()
    }
    organelles = sorted(
        row_totals.keys(),
        key=lambda organelle: (
            -reusable_totals.get(organelle, 0),
            -public_share[organelle],
            -row_totals[organelle],
            organelle,
        ),
    )

    return {
        "matrix": matrix,
        "organelles": organelles,
        "statuses": list(PUBLIC_DATA_STATUSES),
        "row_totals": row_totals,
        "reusable_totals": reusable_totals,
        "public_share": public_share,
        "reusable_modality_families": {
            organelle: sorted(values)
            for organelle, values in reusable_modality_families.items()
        },
        "reusable_metric_families": {
            organelle: sorted(values)
            for organelle, values in reusable_metric_families.items()
        },
    }


def _build_coverage_atlas_response(
    pair_counts: Sequence[tuple[str, str, int]],
    cell_type_counts: Sequence[tuple[str, int]],
    cell_type_species_rows: Sequence[tuple[str, str]],
) -> dict[str, Any]:
    matrix: dict[str, dict[str, int]] = {}
    organelle_totals: dict[str, int] = {}
    cell_type_totals = {cell_type: int(count) for cell_type, count in cell_type_counts}
    cell_type_species: dict[str, set[str]] = {}

    for cell_type, species in cell_type_species_rows:
        cell_type_species.setdefault(cell_type, set()).add(species)

    for cell_type, organelle, count in pair_counts:
        normalized_count = int(count)
        matrix.setdefault(cell_type, {})[organelle] = normalized_count
        organelle_totals[organelle] = organelle_totals.get(organelle, 0) + normalized_count

    organelle_diversity = {
        cell_type: len(organelle_counts)
        for cell_type, organelle_counts in matrix.items()
    }
    cell_types = sorted(
        cell_type_totals.keys(),
        key=lambda value: (
            -organelle_diversity.get(value, 0),
            -cell_type_totals[value],
            value,
        ),
    )
    organelles = sorted(
        organelle_totals.keys(),
        key=lambda value: (-organelle_totals[value], value),
    )

    return {
        "matrix": matrix,
        "cell_types": cell_types,
        "organelles": organelles,
        "cell_type_totals": cell_type_totals,
        "organelle_totals": organelle_totals,
        "cell_type_organelle_counts": organelle_diversity,
        "cell_type_species": {
            cell_type: sorted(values)
            for cell_type, values in cell_type_species.items()
        },
    }


def _build_corpus_timeline_response(
    family_counts: Sequence[tuple[int, str, int]],
    year_summaries: Sequence[tuple[int, int, int, int, int]],
) -> dict[str, Any]:
    matrix: dict[int, dict[str, int]] = {}
    modality_totals: dict[str, int] = {}
    year_totals: dict[int, int] = {}
    public_counts: dict[int, int] = {}
    organelle_counts: dict[int, int] = {}
    metric_family_counts: dict[int, int] = {}

    for year, modality_family, count in family_counts:
        normalized_count = int(count)
        matrix.setdefault(year, {})[modality_family] = normalized_count
        modality_totals[modality_family] = modality_totals.get(modality_family, 0) + normalized_count

    for year, total, public_count, organelle_count, metric_family_count in year_summaries:
        year_totals[year] = int(total)
        public_counts[year] = int(public_count)
        organelle_counts[year] = int(organelle_count)
        metric_family_counts[year] = int(metric_family_count)

    years = sorted(year_totals.keys())
    modality_families = sorted(
        modality_totals.keys(),
        key=lambda value: (-modality_totals[value], value),
    )

    return {
        "matrix": matrix,
        "years": years,
        "modality_families": modality_families,
        "year_totals": year_totals,
        "public_counts": public_counts,
        "organelle_counts": organelle_counts,
        "metric_family_counts": metric_family_counts,
    }


def _build_stats(values: list[int | float]) -> dict[str, float] | None:
    if not values:
        return None

    sorted_values = sorted(values)
    median = sorted_values[len(sorted_values) // 2]
    average = round(sum(sorted_values) / len(sorted_values), 1)
    return {
        "min": min(sorted_values),
        "max": max(sorted_values),
        "median": median,
        "avg": average,
    }


def _similarity_score(left: DatasetRecord, right: DatasetRecord) -> int:
    score = 0
    if left.cell_type == right.cell_type:
        score += 40
    if left.species == right.species:
        score += 10
    if left.modality_family == right.modality_family:
        score += 10
    score += len(set(left.organelles) & set(right.organelles)) * 5
    score += len(set(left.metric_families) & set(right.metric_families)) * 5
    return score


def _matches_contains(value: str | None, target: str | None) -> bool:
    if not target:
        return True
    return target.lower() in (value or "").lower()


def _matches_any(values: Sequence[str], target: str | None) -> bool:
    if not target:
        return True
    normalized_target = target.lower()
    return any(normalized_target == value.lower() for value in values)


def _is_visible_dataset(dataset: DatasetRecord, *, include_borderline: bool) -> bool:
    if include_borderline:
        return dataset.included_status in {"included", "borderline"}
    return dataset.included_status == "included"


def _filter_in_memory_datasets(
    datasets: Sequence[DatasetRecord],
    *,
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = None,
    modality: str | None = None,
    metric_family: str | None = None,
    comparator_class: str | None = None,
    modality_family: str | None = None,
    public_data_status: str | None = None,
    public_data_only: bool = False,
    include_borderline: bool = False,
) -> list[DatasetRecord]:
    filtered: list[DatasetRecord] = []
    if public_data_status and public_data_status not in PUBLIC_DATA_STATUSES:
        raise ValueError(f"Unsupported public data status '{public_data_status}'.")

    for dataset in datasets:
        if not _is_visible_dataset(dataset, include_borderline=include_borderline):
            continue
        if year is not None and dataset.year != year:
            continue
        if query:
            haystack = " ".join(
                [
                    dataset.title,
                    dataset.paper_title,
                    dataset.source_study_id or "",
                    dataset.publication_pmid or "",
                    dataset.source,
                    dataset.species,
                    dataset.cell_type,
                    dataset.comparator_class or "",
                    dataset.comparator_detail or "",
                    dataset.modality,
                    " ".join(dataset.organelles),
                    " ".join(dataset.organelle_pairs),
                    " ".join(dataset.metric_families),
                    dataset.notes or "",
                ]
            ).lower()
            if query.lower() not in haystack:
                continue
        if not _matches_contains(dataset.cell_type, cell_type):
            continue
        if not _matches_any(dataset.organelles, organelle):
            continue
        if not _matches_any(dataset.organelle_pairs, organelle_pair):
            continue
        if not _matches_contains(dataset.modality, modality):
            continue
        if not _matches_contains(dataset.modality_family, modality_family):
            continue
        if not _matches_any(dataset.metric_families, metric_family):
            continue
        if comparator_class and (dataset.comparator_class or "").lower() != comparator_class.lower():
            continue
        if public_data_status and dataset.public_data_status != public_data_status:
            continue
        if public_data_only and dataset.public_data_status == "none":
            continue
        filtered.append(dataset)

    return sorted(filtered, key=lambda dataset: (-dataset.year, dataset.dataset_id))


def _build_dataset_filters(
    *,
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = None,
    modality: str | None = None,
    metric_family: str | None = None,
    comparator_class: str | None = None,
    modality_family: str | None = None,
    public_data_status: str | None = None,
    public_data_only: bool = False,
    include_borderline: bool = False,
) -> tuple[list[str], list[object]]:
    clauses: list[str] = []
    params: list[object] = []

    if not include_borderline:
        clauses.append("included_status = 'included'")
    else:
        clauses.append("included_status IN ('included', 'borderline')")

    if query:
        clauses.append(
            """
            (
                title ILIKE %s OR
                paper_title ILIKE %s OR
                source_study_id ILIKE %s OR
                publication_pmid ILIKE %s OR
                source ILIKE %s OR
                species ILIKE %s OR
                cell_type ILIKE %s OR
                notes ILIKE %s
            )
            """.strip()
        )
        pattern = f"%{query}%"
        params.extend([pattern] * 8)

    if year is not None:
        clauses.append("year = %s")
        params.append(year)

    if cell_type:
        clauses.append("cell_type ILIKE %s")
        params.append(f"%{cell_type}%")

    if organelle:
        clauses.append("organelles @> ARRAY[%s]::text[]")
        params.append(organelle)

    if organelle_pair:
        clauses.append("organelle_pairs @> ARRAY[%s]::text[]")
        params.append(organelle_pair)

    if modality:
        clauses.append("modality ILIKE %s")
        params.append(f"%{modality}%")

    if modality_family:
        clauses.append("modality_family ILIKE %s")
        params.append(f"%{modality_family}%")

    if metric_family:
        clauses.append("metric_families @> ARRAY[%s]::text[]")
        params.append(metric_family)

    if comparator_class:
        clauses.append("comparator_class ILIKE %s")
        params.append(f"%{comparator_class}%")

    if public_data_status:
        if public_data_status not in PUBLIC_DATA_STATUSES:
            raise ValueError(f"Unsupported public data status '{public_data_status}'.")
        clauses.append("public_data_status = %s")
        params.append(public_data_status)

    if public_data_only:
        clauses.append("public_data_status != 'none'")

    return clauses, params


def _where_clause(clauses: Sequence[str]) -> str:
    return f" WHERE {' AND '.join(clauses)}" if clauses else ""


def _cross_tab_dimension_expression(name: str) -> str:
    expression = ANALYTICS_DIMENSIONS.get(name)
    if expression is None:
        supported = ", ".join(sorted(ANALYTICS_DIMENSIONS.keys()))
        raise ValueError(f"Unsupported analytics dimension '{name}'. Choose one of: {supported}.")
    return f"COALESCE(NULLIF(TRIM(({expression})::text), ''), 'none')"


@dataclass
class InMemoryDatasetRepository:
    datasets: list[DatasetRecord]

    def search_datasets(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int,
    ) -> DatasetSearchPage:
        records = _filter_in_memory_datasets(
            self.datasets,
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return DatasetSearchPage(total=len(records), results=records[:limit])

    def list_datasets(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int | None = None,
    ) -> list[DatasetRecord]:
        records = self.search_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
            limit=limit or len(self.datasets),
        )
        return records.results

    def get_search_commonalities(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int = 5,
    ) -> dict[str, list[str]]:
        datasets = _filter_in_memory_datasets(
            self.datasets,
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return summarize_commonalities(datasets, limit=limit)

    def get_dataset(self, dataset_id: str) -> DatasetRecord | None:
        for dataset in self.datasets:
            if dataset.dataset_id == dataset_id and dataset.included_status in {
                "included",
                "borderline",
            }:
                return dataset
        return None

    def get_datasets_by_ids(self, dataset_ids: Sequence[str]) -> list[DatasetRecord]:
        by_id = {
            dataset.dataset_id: dataset
            for dataset in self.datasets
            if dataset.included_status in {"included", "borderline"}
        }
        return [by_id[dataset_id] for dataset_id in dataset_ids if dataset_id in by_id]

    def get_cross_tab(
        self,
        *,
        row: str,
        col: str,
        include_borderline: bool = True,
    ) -> dict[str, Any]:
        if row not in ANALYTICS_DIMENSIONS or col not in ANALYTICS_DIMENSIONS:
            _cross_tab_dimension_expression(row)
            _cross_tab_dimension_expression(col)

        counts: dict[tuple[str, str], int] = {}
        for dataset in self.list_datasets(include_borderline=include_borderline):
            row_value = _normalize_cross_tab_value(getattr(dataset, row, None))
            col_value = _normalize_cross_tab_value(getattr(dataset, col, None))
            counts[(row_value, col_value)] = counts.get((row_value, col_value), 0) + 1

        ordered_counts = [
            (row_value, col_value, count)
            for (row_value, col_value), count in sorted(counts.items())
        ]
        return _build_cross_tab_response(ordered_counts)

    def get_frontier_data(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> list[dict[str, Any]]:
        return [
            {
                "id": dataset.dataset_id,
                "title": dataset.title,
                "res": dataset.lateral_resolution_nm,
                "ss": dataset.sample_size,
                "modality": dataset.modality_family,
            }
            for dataset in self.list_datasets(
                query=query,
                year=year,
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                metric_family=metric_family,
                comparator_class=comparator_class,
                modality_family=modality_family,
                public_data_status=public_data_status,
                public_data_only=public_data_only,
                include_borderline=include_borderline,
            )
            if dataset.lateral_resolution_nm is not None and dataset.sample_size is not None
        ]

    def get_toolkit_matrix(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        datasets = self.list_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )

        matrix: dict[str, dict[str, int]] = {}
        organelles_found: set[str] = set()
        modality_families = {dataset.modality_family for dataset in datasets}

        for dataset in datasets:
            for organelle_value in dataset.organelles:
                organelles_found.add(organelle_value)
                matrix.setdefault(organelle_value, {})
                matrix[organelle_value][dataset.modality_family] = (
                    matrix[organelle_value].get(dataset.modality_family, 0) + 1
                )

        return {
            "matrix": matrix,
            "organelles": sorted(organelles_found),
            "modalities": sorted(modality_families),
        }

    def get_measurement_grammar(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        datasets = self.list_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )

        counts: dict[tuple[str, str], int] = {}
        for dataset in datasets:
            for organelle_value in dataset.organelles:
                for metric_family_value in dataset.metric_families:
                    key = (organelle_value, metric_family_value)
                    counts[key] = counts.get(key, 0) + 1

        return _build_measurement_grammar_response(
            [
                (organelle_value, metric_family_value, count)
                for (organelle_value, metric_family_value), count in sorted(counts.items())
            ]
        )

    def get_reusability_map(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        datasets = self.list_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )

        status_counts: dict[tuple[str, str], int] = {}
        reusable_traits: set[tuple[str, str, str]] = set()
        for dataset in datasets:
            for organelle_value in dataset.organelles:
                status_key = (organelle_value, dataset.public_data_status)
                status_counts[status_key] = status_counts.get(status_key, 0) + 1
                if dataset.public_data_status != "none":
                    for metric_family_value in dataset.metric_families:
                        reusable_traits.add(
                            (
                                organelle_value,
                                dataset.modality_family,
                                metric_family_value,
                            )
                        )

        return _build_reusability_map_response(
            [
                (organelle_value, status, count)
                for (organelle_value, status), count in sorted(status_counts.items())
            ],
            sorted(reusable_traits),
        )

    def get_coverage_atlas(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        datasets = self.list_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )

        pair_counts: dict[tuple[str, str], int] = {}
        cell_type_counts: dict[str, int] = {}
        cell_type_species: set[tuple[str, str]] = set()
        for dataset in datasets:
            cell_type_counts[dataset.cell_type] = cell_type_counts.get(dataset.cell_type, 0) + 1
            cell_type_species.add((dataset.cell_type, dataset.species))
            for organelle_value in dataset.organelles:
                key = (dataset.cell_type, organelle_value)
                pair_counts[key] = pair_counts.get(key, 0) + 1

        return _build_coverage_atlas_response(
            [
                (cell_type_value, organelle_value, count)
                for (cell_type_value, organelle_value), count in sorted(pair_counts.items())
            ],
            sorted(cell_type_counts.items()),
            sorted(cell_type_species),
        )

    def get_corpus_timeline(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        datasets = self.list_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )

        family_counts: dict[tuple[int, str], int] = {}
        year_records: dict[int, int] = {}
        public_counts: dict[int, int] = {}
        organelles_by_year: dict[int, set[str]] = {}
        metrics_by_year: dict[int, set[str]] = {}
        for dataset in datasets:
            family_key = (dataset.year, dataset.modality_family)
            family_counts[family_key] = family_counts.get(family_key, 0) + 1
            year_records[dataset.year] = year_records.get(dataset.year, 0) + 1
            if dataset.public_data_status != "none":
                public_counts[dataset.year] = public_counts.get(dataset.year, 0) + 1
            organelles_by_year.setdefault(dataset.year, set()).update(dataset.organelles)
            metrics_by_year.setdefault(dataset.year, set()).update(dataset.metric_families)

        return _build_corpus_timeline_response(
            [
                (year_value, modality_family_value, count)
                for (year_value, modality_family_value), count in sorted(family_counts.items())
            ],
            [
                (
                    year_value,
                    year_records[year_value],
                    public_counts.get(year_value, 0),
                    len(organelles_by_year.get(year_value, set())),
                    len(metrics_by_year.get(year_value, set())),
                )
                for year_value in sorted(year_records)
            ],
        )

    def get_benchmarks(self, *, include_borderline: bool = True) -> list[dict[str, Any]]:
        grouped: dict[str, dict[str, list[int | float] | int]] = {}
        for dataset in self.list_datasets(include_borderline=include_borderline):
            grouped.setdefault(
                dataset.modality_family,
                {"resolutions": [], "sample_sizes": [], "count": 0},
            )
            grouped[dataset.modality_family]["count"] += 1
            if dataset.lateral_resolution_nm is not None:
                grouped[dataset.modality_family]["resolutions"].append(dataset.lateral_resolution_nm)
            if dataset.sample_size is not None:
                grouped[dataset.modality_family]["sample_sizes"].append(dataset.sample_size)

        return [
            {
                "modality_family": family,
                "count": int(values["count"]),
                "resolution_stats": _build_stats(list(values["resolutions"])),
                "sample_size_stats": _build_stats(list(values["sample_sizes"])),
            }
            for family, values in sorted(grouped.items())
        ]

    def get_facets(self, *, include_borderline: bool = False) -> dict[str, list[tuple[str, int]]]:
        return summarize_facets(self.list_datasets(include_borderline=include_borderline))

    def get_similar_datasets(
        self,
        target: DatasetRecord,
        *,
        limit: int = 4,
    ) -> list[DatasetRecord]:
        scored = [
            (dataset, _similarity_score(dataset, target))
            for dataset in self.list_datasets()
            if dataset.dataset_id != target.dataset_id
        ]
        scored.sort(key=lambda item: (-item[1], -item[0].year, item[0].dataset_id))
        return [dataset for dataset, _ in scored[:limit]]

    def list_plan_datasets(
        self,
        organelles: Sequence[str],
        *,
        include_borderline: bool = True,
    ) -> list[DatasetRecord]:
        organelle_set = {organelle.lower() for organelle in organelles}
        if not organelle_set:
            return []

        return [
            dataset
            for dataset in self.list_datasets(include_borderline=include_borderline)
            if organelle_set & {organelle.lower() for organelle in dataset.organelles}
        ]


class PostgresDatasetRepository:
    def _log_query(self, operation: str, started_at: float, **context: Any) -> None:
        duration_ms = duration_ms_since(started_at)
        query_logger.log(
            operation_log_level(duration_ms, get_settings().slow_operation_ms),
            "repository query completed",
            extra=with_request_context(
                {
                    "event": "repository_query_completed",
                    "operation": operation,
                    "duration_ms": duration_ms,
                    **context,
                }
            ),
        )

    def search_datasets(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int,
    ) -> DatasetSearchPage:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        query_sql = f"""
            SELECT
                {DATASET_SELECT_COLUMNS},
                COUNT(*) OVER() AS total_count
            FROM dataset_records
            {_where_clause(clauses)}
            ORDER BY year DESC, dataset_id ASC
            LIMIT %s
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query_sql, [*params, limit])
                rows = cursor.fetchall()

        results = [_row_to_dataset(row) for row in rows]
        total = rows[0]["total_count"] if rows else 0

        self._log_query(
            "search_datasets",
            started_at,
            row_count=len(results),
            total=total,
            query_present=bool(query),
            year_filter=year is not None,
            cell_type_filter=bool(cell_type),
            organelle_filter=bool(organelle),
            organelle_pair_filter=bool(organelle_pair),
            modality_filter=bool(modality),
            modality_family_filter=bool(modality_family),
            metric_family_filter=bool(metric_family),
            comparator_class_filter=bool(comparator_class),
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
            limit=limit,
        )
        return DatasetSearchPage(total=total, results=results)

    def list_datasets(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int | None = None,
    ) -> list[DatasetRecord]:
        if limit is None:
            started_at = perf_counter()
            clauses, params = _build_dataset_filters(
                query=query,
                year=year,
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                metric_family=metric_family,
                comparator_class=comparator_class,
                modality_family=modality_family,
                public_data_status=public_data_status,
                public_data_only=public_data_only,
                include_borderline=include_borderline,
            )
            query_sql = f"""
                SELECT
                    {DATASET_SELECT_COLUMNS}
                FROM dataset_records
                {_where_clause(clauses)}
                ORDER BY year DESC, dataset_id ASC
            """

            with get_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(query_sql, params)
                    records = [_row_to_dataset(row) for row in cursor.fetchall()]

            self._log_query(
                "list_datasets",
                started_at,
                row_count=len(records),
                query_present=bool(query),
                year_filter=year is not None,
                cell_type_filter=bool(cell_type),
                organelle_filter=bool(organelle),
                organelle_pair_filter=bool(organelle_pair),
                modality_filter=bool(modality),
                modality_family_filter=bool(modality_family),
                metric_family_filter=bool(metric_family),
                comparator_class_filter=bool(comparator_class),
                public_data_status_filter=bool(public_data_status),
                public_data_only=public_data_only,
                include_borderline=include_borderline,
                limit=limit,
            )
            return records

        return self.search_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
            limit=limit,
        ).results

    def get_search_commonalities(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int = 5,
    ) -> dict[str, list[str]]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        where_sql = _where_clause(clauses)
        query_map = {
            "top_organelles": f"""
                SELECT organelle AS value, COUNT(*) AS count
                FROM dataset_records
                CROSS JOIN LATERAL unnest(organelles) AS organelle
                {where_sql}
                GROUP BY organelle
                ORDER BY count DESC, value ASC
                LIMIT %s
            """,
            "top_organelle_pairs": f"""
                SELECT organelle_pair AS value, COUNT(*) AS count
                FROM dataset_records
                CROSS JOIN LATERAL unnest(organelle_pairs) AS organelle_pair
                {where_sql}
                GROUP BY organelle_pair
                ORDER BY count DESC, value ASC
                LIMIT %s
            """,
            "top_metric_families": f"""
                SELECT metric_family AS value, COUNT(*) AS count
                FROM dataset_records
                CROSS JOIN LATERAL unnest(metric_families) AS metric_family
                {where_sql}
                GROUP BY metric_family
                ORDER BY count DESC, value ASC
                LIMIT %s
            """,
            "top_modalities": f"""
                SELECT modality AS value, COUNT(*) AS count
                FROM dataset_records
                {where_sql}
                GROUP BY modality
                ORDER BY count DESC, value ASC
                LIMIT %s
            """,
            "top_cell_types": f"""
                SELECT cell_type AS value, COUNT(*) AS count
                FROM dataset_records
                {where_sql}
                GROUP BY cell_type
                ORDER BY count DESC, value ASC
                LIMIT %s
            """,
        }

        summary: dict[str, list[str]] = {}
        with get_connection() as connection:
            with connection.cursor() as cursor:
                for key, query_sql in query_map.items():
                    cursor.execute(query_sql, [*params, limit])
                    summary[key] = [row["value"] for row in cursor.fetchall()]

        self._log_query(
            "get_search_commonalities",
            started_at,
            limit=limit,
            query_present=bool(query),
            year_filter=year is not None,
            cell_type_filter=bool(cell_type),
            organelle_filter=bool(organelle),
            organelle_pair_filter=bool(organelle_pair),
            modality_filter=bool(modality),
            modality_family_filter=bool(modality_family),
            metric_family_filter=bool(metric_family),
            comparator_class_filter=bool(comparator_class),
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return summary

    def get_dataset(self, dataset_id: str) -> DatasetRecord | None:
        started_at = perf_counter()
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT
                        {DATASET_SELECT_COLUMNS}
                    FROM dataset_records
                    WHERE dataset_id = %s
                      AND included_status IN ('included', 'borderline')
                    """,
                    (dataset_id,),
                )
                row = cursor.fetchone()
                record = _row_to_dataset(row) if row else None

        self._log_query(
            "get_dataset",
            started_at,
            dataset_id=dataset_id,
            found=record is not None,
        )
        return record

    def get_datasets_by_ids(self, dataset_ids: Sequence[str]) -> list[DatasetRecord]:
        if not dataset_ids:
            return []

        started_at = perf_counter()
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT
                        {DATASET_SELECT_COLUMNS}
                    FROM dataset_records
                    WHERE dataset_id = ANY(%s)
                      AND included_status IN ('included', 'borderline')
                    """,
                    (list(dataset_ids),),
                )
                rows = {_row["dataset_id"]: _row_to_dataset(_row) for _row in cursor.fetchall()}
                records = [rows[dataset_id] for dataset_id in dataset_ids if dataset_id in rows]

        self._log_query(
            "get_datasets_by_ids",
            started_at,
            requested_count=len(dataset_ids),
            found_count=len(records),
        )
        return records

    def get_cross_tab(
        self,
        *,
        row: str,
        col: str,
        include_borderline: bool = True,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        row_expr = _cross_tab_dimension_expression(row)
        col_expr = _cross_tab_dimension_expression(col)
        clauses, params = _build_dataset_filters(include_borderline=include_borderline)
        query_sql = f"""
            SELECT
                {row_expr} AS row_value,
                {col_expr} AS col_value,
                COUNT(*) AS count
            FROM dataset_records
            {_where_clause(clauses)}
            GROUP BY row_value, col_value
            ORDER BY row_value ASC, col_value ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query_sql, params)
                rows = cursor.fetchall()

        response = _build_cross_tab_response(
            [(row["row_value"], row["col_value"], row["count"]) for row in rows]
        )
        self._log_query(
            "get_cross_tab",
            started_at,
            row_dimension=row,
            col_dimension=col,
            pair_count=len(rows),
            include_borderline=include_borderline,
        )
        return response

    def get_frontier_data(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> list[dict[str, Any]]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        clauses.extend(
            [
                "lateral_resolution_nm IS NOT NULL",
                "sample_size IS NOT NULL",
            ]
        )
        query_sql = f"""
            SELECT
                dataset_id AS id,
                title,
                lateral_resolution_nm AS res,
                sample_size AS ss,
                modality_family AS modality
            FROM dataset_records
            {_where_clause(clauses)}
            ORDER BY year DESC, dataset_id ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query_sql, params)
                rows = cursor.fetchall()

        self._log_query(
            "get_frontier_data",
            started_at,
            row_count=len(rows),
            query_present=bool(query),
            year_filter=year is not None,
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return rows

    def get_toolkit_matrix(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        where_sql = _where_clause(clauses)

        modalities_sql = f"""
            SELECT DISTINCT modality_family
            FROM dataset_records
            {where_sql}
            ORDER BY modality_family ASC
        """
        matrix_sql = f"""
            SELECT
                organelle,
                modality_family,
                COUNT(*) AS count
            FROM dataset_records
            CROSS JOIN LATERAL unnest(organelles) AS organelle
            {where_sql}
            GROUP BY organelle, modality_family
            ORDER BY organelle ASC, modality_family ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(modalities_sql, params)
                modalities = [row["modality_family"] for row in cursor.fetchall()]

                cursor.execute(matrix_sql, params)
                rows = cursor.fetchall()

        matrix: dict[str, dict[str, int]] = {}
        organelles: list[str] = []
        current_organelle: str | None = None
        for row in rows:
            organelle_name = row["organelle"]
            if organelle_name != current_organelle:
                organelles.append(organelle_name)
                current_organelle = organelle_name
            matrix.setdefault(organelle_name, {})[row["modality_family"]] = row["count"]

        response = {
            "matrix": matrix,
            "organelles": organelles,
            "modalities": modalities,
        }
        self._log_query(
            "get_toolkit_matrix",
            started_at,
            cell_count=len(rows),
            organelle_count=len(organelles),
            modality_count=len(modalities),
            query_present=bool(query),
            year_filter=year is not None,
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return response

    def get_measurement_grammar(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        query_sql = f"""
            SELECT
                organelle.value AS organelle,
                metric_family.value AS metric_family,
                COUNT(*) AS count
            FROM dataset_records
            CROSS JOIN LATERAL unnest(organelles) AS organelle(value)
            CROSS JOIN LATERAL unnest(metric_families) AS metric_family(value)
            {_where_clause(clauses)}
            GROUP BY organelle.value, metric_family.value
            ORDER BY organelle.value ASC, metric_family.value ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query_sql, params)
                rows = cursor.fetchall()

        response = _build_measurement_grammar_response(
            [(row["organelle"], row["metric_family"], row["count"]) for row in rows]
        )
        self._log_query(
            "get_measurement_grammar",
            started_at,
            cell_count=len(rows),
            organelle_count=len(response["organelles"]),
            metric_family_count=len(response["metric_families"]),
            query_present=bool(query),
            year_filter=year is not None,
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return response

    def get_reusability_map(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        where_sql = _where_clause(clauses)
        status_sql = f"""
            SELECT
                organelle.value AS organelle,
                public_data_status,
                COUNT(*) AS count
            FROM dataset_records
            CROSS JOIN LATERAL unnest(organelles) AS organelle(value)
            {where_sql}
            GROUP BY organelle.value, public_data_status
            ORDER BY organelle.value ASC, public_data_status ASC
        """
        reusable_traits_sql = f"""
            SELECT DISTINCT
                organelle.value AS organelle,
                modality_family,
                metric_family.value AS metric_family
            FROM dataset_records
            CROSS JOIN LATERAL unnest(organelles) AS organelle(value)
            CROSS JOIN LATERAL unnest(metric_families) AS metric_family(value)
            {where_sql}
              AND public_data_status != 'none'
            ORDER BY organelle.value ASC, modality_family ASC, metric_family.value ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(status_sql, params)
                status_rows = cursor.fetchall()

                cursor.execute(reusable_traits_sql, params)
                reusable_trait_rows = cursor.fetchall()

        response = _build_reusability_map_response(
            [
                (row["organelle"], row["public_data_status"], row["count"])
                for row in status_rows
            ],
            [
                (row["organelle"], row["modality_family"], row["metric_family"])
                for row in reusable_trait_rows
            ],
        )
        self._log_query(
            "get_reusability_map",
            started_at,
            status_cell_count=len(status_rows),
            reusable_trait_count=len(reusable_trait_rows),
            organelle_count=len(response["organelles"]),
            query_present=bool(query),
            year_filter=year is not None,
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return response

    def get_coverage_atlas(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        where_sql = _where_clause(clauses)
        pair_counts_sql = f"""
            SELECT
                cell_type,
                organelle.value AS organelle,
                COUNT(*) AS count
            FROM dataset_records
            CROSS JOIN LATERAL unnest(organelles) AS organelle(value)
            {where_sql}
            GROUP BY cell_type, organelle.value
            ORDER BY cell_type ASC, organelle.value ASC
        """
        cell_type_counts_sql = f"""
            SELECT cell_type, COUNT(*) AS count
            FROM dataset_records
            {where_sql}
            GROUP BY cell_type
            ORDER BY cell_type ASC
        """
        species_sql = f"""
            SELECT DISTINCT cell_type, species
            FROM dataset_records
            {where_sql}
            ORDER BY cell_type ASC, species ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(pair_counts_sql, params)
                pair_rows = cursor.fetchall()

                cursor.execute(cell_type_counts_sql, params)
                cell_type_rows = cursor.fetchall()

                cursor.execute(species_sql, params)
                species_rows = cursor.fetchall()

        response = _build_coverage_atlas_response(
            [
                (row["cell_type"], row["organelle"], row["count"])
                for row in pair_rows
            ],
            [(row["cell_type"], row["count"]) for row in cell_type_rows],
            [(row["cell_type"], row["species"]) for row in species_rows],
        )
        self._log_query(
            "get_coverage_atlas",
            started_at,
            cell_count=len(pair_rows),
            cell_type_count=len(response["cell_types"]),
            organelle_count=len(response["organelles"]),
            query_present=bool(query),
            year_filter=year is not None,
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return response

    def get_corpus_timeline(
        self,
        *,
        query: str | None = None,
        year: int | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_status: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        where_sql = _where_clause(clauses)
        family_counts_sql = f"""
            SELECT year, modality_family, COUNT(*) AS count
            FROM dataset_records
            {where_sql}
            GROUP BY year, modality_family
            ORDER BY year ASC, modality_family ASC
        """
        year_summary_sql = f"""
            SELECT
                year,
                COUNT(*) AS total_count,
                COUNT(*) FILTER (WHERE public_data_status != 'none') AS public_count
            FROM dataset_records
            {where_sql}
            GROUP BY year
            ORDER BY year ASC
        """
        organelle_summary_sql = f"""
            SELECT year, COUNT(DISTINCT organelle.value) AS organelle_count
            FROM dataset_records
            CROSS JOIN LATERAL unnest(organelles) AS organelle(value)
            {where_sql}
            GROUP BY year
            ORDER BY year ASC
        """
        metric_summary_sql = f"""
            SELECT year, COUNT(DISTINCT metric_family.value) AS metric_family_count
            FROM dataset_records
            CROSS JOIN LATERAL unnest(metric_families) AS metric_family(value)
            {where_sql}
            GROUP BY year
            ORDER BY year ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(family_counts_sql, params)
                family_rows = cursor.fetchall()

                cursor.execute(year_summary_sql, params)
                year_rows = cursor.fetchall()

                cursor.execute(organelle_summary_sql, params)
                organelle_rows = cursor.fetchall()

                cursor.execute(metric_summary_sql, params)
                metric_rows = cursor.fetchall()

        organelle_counts = {
            row["year"]: row["organelle_count"]
            for row in organelle_rows
        }
        metric_counts = {
            row["year"]: row["metric_family_count"]
            for row in metric_rows
        }
        response = _build_corpus_timeline_response(
            [
                (row["year"], row["modality_family"], row["count"])
                for row in family_rows
            ],
            [
                (
                    row["year"],
                    row["total_count"],
                    row["public_count"],
                    organelle_counts.get(row["year"], 0),
                    metric_counts.get(row["year"], 0),
                )
                for row in year_rows
            ],
        )
        self._log_query(
            "get_corpus_timeline",
            started_at,
            year_count=len(response["years"]),
            modality_family_count=len(response["modality_families"]),
            query_present=bool(query),
            year_filter=year is not None,
            public_data_status_filter=bool(public_data_status),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return response

    def get_benchmarks(self, *, include_borderline: bool = True) -> list[dict[str, Any]]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(include_borderline=include_borderline)
        query_sql = f"""
            SELECT
                modality_family,
                COUNT(*) AS count,
                MIN(lateral_resolution_nm) FILTER (WHERE lateral_resolution_nm IS NOT NULL) AS resolution_min,
                MAX(lateral_resolution_nm) FILTER (WHERE lateral_resolution_nm IS NOT NULL) AS resolution_max,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY lateral_resolution_nm)
                    FILTER (WHERE lateral_resolution_nm IS NOT NULL) AS resolution_median,
                ROUND(
                    (AVG(lateral_resolution_nm) FILTER (WHERE lateral_resolution_nm IS NOT NULL))::numeric,
                    1
                ) AS resolution_avg,
                MIN(sample_size) FILTER (WHERE sample_size IS NOT NULL) AS sample_size_min,
                MAX(sample_size) FILTER (WHERE sample_size IS NOT NULL) AS sample_size_max,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY sample_size)
                    FILTER (WHERE sample_size IS NOT NULL) AS sample_size_median,
                ROUND(
                    (AVG(sample_size) FILTER (WHERE sample_size IS NOT NULL))::numeric,
                    1
                ) AS sample_size_avg
            FROM dataset_records
            {_where_clause(clauses)}
            GROUP BY modality_family
            ORDER BY modality_family ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query_sql, params)
                rows = cursor.fetchall()

        results = []
        for row in rows:
            resolution_stats = None
            if row["resolution_median"] is not None:
                resolution_stats = {
                    "min": row["resolution_min"],
                    "max": row["resolution_max"],
                    "median": row["resolution_median"],
                    "avg": row["resolution_avg"],
                }

            sample_size_stats = None
            if row["sample_size_median"] is not None:
                sample_size_stats = {
                    "min": row["sample_size_min"],
                    "max": row["sample_size_max"],
                    "median": row["sample_size_median"],
                    "avg": row["sample_size_avg"],
                }

            results.append(
                {
                    "modality_family": row["modality_family"],
                    "count": row["count"],
                    "resolution_stats": resolution_stats,
                    "sample_size_stats": sample_size_stats,
                }
            )

        self._log_query(
            "get_benchmarks",
            started_at,
            benchmark_count=len(results),
            include_borderline=include_borderline,
        )
        return results

    def get_facets(self, *, include_borderline: bool = False) -> dict[str, list[tuple[str, int]]]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(include_borderline=include_borderline)
        where_sql = _where_clause(clauses)
        query_map = {
            "cell_types": f"""
                SELECT cell_type AS value, COUNT(*) AS count
                FROM dataset_records
                {where_sql}
                GROUP BY cell_type
                ORDER BY count DESC, value ASC
            """,
            "modalities": f"""
                SELECT modality AS value, COUNT(*) AS count
                FROM dataset_records
                {where_sql}
                GROUP BY modality
                ORDER BY count DESC, value ASC
            """,
            "organelles": f"""
                SELECT organelle AS value, COUNT(*) AS count
                FROM dataset_records
                CROSS JOIN LATERAL unnest(organelles) AS organelle
                {where_sql}
                GROUP BY organelle
                ORDER BY count DESC, value ASC
            """,
            "metric_families": f"""
                SELECT metric_family AS value, COUNT(*) AS count
                FROM dataset_records
                CROSS JOIN LATERAL unnest(metric_families) AS metric_family
                {where_sql}
                GROUP BY metric_family
                ORDER BY count DESC, value ASC
            """,
            "comparator_classes": f"""
                SELECT comparator_class AS value, COUNT(*) AS count
                FROM dataset_records
                {where_sql}
                  AND comparator_class IS NOT NULL
                  AND comparator_class != ''
                GROUP BY comparator_class
                ORDER BY count DESC, value ASC
            """,
        }

        facets: dict[str, list[tuple[str, int]]] = {}
        with get_connection() as connection:
            with connection.cursor() as cursor:
                for key, query_sql in query_map.items():
                    cursor.execute(query_sql, params)
                    facets[key] = [(row["value"], row["count"]) for row in cursor.fetchall()]

        self._log_query(
            "get_facets",
            started_at,
            include_borderline=include_borderline,
            cell_type_count=len(facets["cell_types"]),
            modality_count=len(facets["modalities"]),
            organelle_count=len(facets["organelles"]),
            metric_family_count=len(facets["metric_families"]),
            comparator_class_count=len(facets["comparator_classes"]),
        )
        return facets

    def get_similar_datasets(
        self,
        target: DatasetRecord,
        *,
        limit: int = 4,
    ) -> list[DatasetRecord]:
        started_at = perf_counter()
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT
                        {DATASET_SELECT_COLUMNS},
                        (
                            CASE WHEN cell_type = %s THEN 40 ELSE 0 END +
                            CASE WHEN species = %s THEN 10 ELSE 0 END +
                            CASE WHEN modality_family = %s THEN 10 ELSE 0 END +
                            5 * cardinality(ARRAY(
                                SELECT unnest(organelles)
                                INTERSECT
                                SELECT unnest(%s::text[])
                            )) +
                            5 * cardinality(ARRAY(
                                SELECT unnest(metric_families)
                                INTERSECT
                                SELECT unnest(%s::text[])
                            ))
                        ) AS similarity_score
                    FROM dataset_records
                    WHERE dataset_id != %s
                      AND included_status = 'included'
                    ORDER BY similarity_score DESC, year DESC, dataset_id ASC
                    LIMIT %s
                    """,
                    (
                        target.cell_type,
                        target.species,
                        target.modality_family,
                        target.organelles,
                        target.metric_families,
                        target.dataset_id,
                        limit,
                    ),
                )
                records = [_row_to_dataset(row) for row in cursor.fetchall()]

        self._log_query(
            "get_similar_datasets",
            started_at,
            dataset_id=target.dataset_id,
            returned_count=len(records),
            limit=limit,
        )
        return records

    def list_plan_datasets(
        self,
        organelles: Sequence[str],
        *,
        include_borderline: bool = True,
    ) -> list[DatasetRecord]:
        if not organelles:
            return []

        started_at = perf_counter()
        clauses, params = _build_dataset_filters(include_borderline=include_borderline)
        clauses.append("organelles && %s::text[]")
        params.append(list(organelles))
        query_sql = f"""
            SELECT
                {DATASET_SELECT_COLUMNS}
            FROM dataset_records
            {_where_clause(clauses)}
            ORDER BY year DESC, dataset_id ASC
        """

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query_sql, params)
                records = [_row_to_dataset(row) for row in cursor.fetchall()]

        self._log_query(
            "list_plan_datasets",
            started_at,
            organelle_count=len(organelles),
            row_count=len(records),
            include_borderline=include_borderline,
        )
        return records
