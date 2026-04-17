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


@dataclass(frozen=True)
class DatasetSearchPage:
    total: int
    results: list[DatasetRecord]


class DatasetRepository(Protocol):
    def search_datasets(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int,
    ) -> DatasetSearchPage: ...

    def list_datasets(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int | None = None,
    ) -> list[DatasetRecord]: ...

    def get_search_commonalities(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
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
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> list[dict[str, Any]]: ...

    def get_toolkit_matrix(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
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
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = None,
    modality: str | None = None,
    metric_family: str | None = None,
    comparator_class: str | None = None,
    modality_family: str | None = None,
    public_data_only: bool = False,
    include_borderline: bool = False,
) -> list[DatasetRecord]:
    filtered: list[DatasetRecord] = []

    for dataset in datasets:
        if not _is_visible_dataset(dataset, include_borderline=include_borderline):
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
        if public_data_only and dataset.public_data_status == "none":
            continue
        filtered.append(dataset)

    return sorted(filtered, key=lambda dataset: (-dataset.year, dataset.dataset_id))


def _build_dataset_filters(
    *,
    query: str | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = None,
    modality: str | None = None,
    metric_family: str | None = None,
    comparator_class: str | None = None,
    modality_family: str | None = None,
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
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int,
    ) -> DatasetSearchPage:
        records = _filter_in_memory_datasets(
            self.datasets,
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return DatasetSearchPage(total=len(records), results=records[:limit])

    def list_datasets(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int | None = None,
    ) -> list[DatasetRecord]:
        records = self.search_datasets(
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
            limit=limit or len(self.datasets),
        )
        return records.results

    def get_search_commonalities(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int = 5,
    ) -> dict[str, list[str]]:
        datasets = _filter_in_memory_datasets(
            self.datasets,
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
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
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
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
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                metric_family=metric_family,
                comparator_class=comparator_class,
                modality_family=modality_family,
                public_data_only=public_data_only,
                include_borderline=include_borderline,
            )
            if dataset.lateral_resolution_nm is not None and dataset.sample_size is not None
        ]

    def get_toolkit_matrix(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        datasets = self.list_datasets(
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
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
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int,
    ) -> DatasetSearchPage:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
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
            cell_type_filter=bool(cell_type),
            organelle_filter=bool(organelle),
            organelle_pair_filter=bool(organelle_pair),
            modality_filter=bool(modality),
            modality_family_filter=bool(modality_family),
            metric_family_filter=bool(metric_family),
            comparator_class_filter=bool(comparator_class),
            public_data_only=public_data_only,
            include_borderline=include_borderline,
            limit=limit,
        )
        return DatasetSearchPage(total=total, results=results)

    def list_datasets(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int | None = None,
    ) -> list[DatasetRecord]:
        if limit is None:
            started_at = perf_counter()
            clauses, params = _build_dataset_filters(
                query=query,
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                metric_family=metric_family,
                comparator_class=comparator_class,
                modality_family=modality_family,
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
                cell_type_filter=bool(cell_type),
                organelle_filter=bool(organelle),
                organelle_pair_filter=bool(organelle_pair),
                modality_filter=bool(modality),
                modality_family_filter=bool(modality_family),
                metric_family_filter=bool(metric_family),
                comparator_class_filter=bool(comparator_class),
                public_data_only=public_data_only,
                include_borderline=include_borderline,
                limit=limit,
            )
            return records

        return self.search_datasets(
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
            limit=limit,
        ).results

    def get_search_commonalities(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
        limit: int = 5,
    ) -> dict[str, list[str]]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
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
            cell_type_filter=bool(cell_type),
            organelle_filter=bool(organelle),
            organelle_pair_filter=bool(organelle_pair),
            modality_filter=bool(modality),
            modality_family_filter=bool(modality_family),
            metric_family_filter=bool(metric_family),
            comparator_class_filter=bool(comparator_class),
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
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> list[dict[str, Any]]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
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
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        return rows

    def get_toolkit_matrix(
        self,
        *,
        query: str | None = None,
        cell_type: str | None = None,
        organelle: str | None = None,
        organelle_pair: str | None = None,
        modality: str | None = None,
        metric_family: str | None = None,
        comparator_class: str | None = None,
        modality_family: str | None = None,
        public_data_only: bool = False,
        include_borderline: bool = False,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        clauses, params = _build_dataset_filters(
            query=query,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
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
