from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from app.db import get_connection
from app.schemas import DatasetRecord


class DatasetRepository(Protocol):
    def list_datasets(self) -> list[DatasetRecord]: ...

    def get_dataset(self, dataset_id: str) -> DatasetRecord | None: ...

    def get_datasets_by_ids(self, dataset_ids: Sequence[str]) -> list[DatasetRecord]: ...


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
        source_publication_url=row["source_publication_url"],
        included_status=row["included_status"],
    )


@dataclass
class InMemoryDatasetRepository:
    datasets: list[DatasetRecord]

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
    ) -> list[DatasetRecord]:
        return self.datasets


    def get_dataset(self, dataset_id: str) -> DatasetRecord | None:
        for dataset in self.datasets:
            if dataset.dataset_id == dataset_id:
                return dataset
        return None

    def get_datasets_by_ids(self, dataset_ids: Sequence[str]) -> list[DatasetRecord]:
        by_id = {dataset.dataset_id: dataset for dataset in self.datasets}
        return [by_id[dataset_id] for dataset_id in dataset_ids if dataset_id in by_id]


class PostgresDatasetRepository:
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
    ) -> list[DatasetRecord]:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                base_query = """
                    SELECT
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
                        source_publication_url,
                        included_status
                    FROM dataset_records
                    WHERE 1=1
                """
                if not include_borderline:
                    base_query += " AND included_status = 'included'"
                else:
                    base_query += " AND included_status IN ('included', 'borderline')"
                params = []

                if query:
                    base_query += """
                        AND (
                            title ILIKE %s OR
                            paper_title ILIKE %s OR
                            source ILIKE %s OR
                            species ILIKE %s OR
                            cell_type ILIKE %s OR
                            notes ILIKE %s
                        )
                    """
                    pattern = f"%{query}%"
                    params.extend([pattern] * 6)

                if cell_type:
                    base_query += " AND cell_type ILIKE %s"
                    params.append(f"%{cell_type}%")

                if organelle:
                    base_query += " AND %s = ANY(organelles)"
                    params.append(organelle)

                if organelle_pair:
                    base_query += " AND %s = ANY(organelle_pairs)"
                    params.append(organelle_pair)

                if modality:
                    base_query += " AND modality ILIKE %s"
                    params.append(f"%{modality}%")

                if modality_family:
                    base_query += " AND modality_family ILIKE %s"
                    params.append(f"%{modality_family}%")

                if metric_family:
                    base_query += " AND %s = ANY(metric_families)"
                    params.append(metric_family)

                if comparator_class:
                    base_query += " AND comparator_class ILIKE %s"
                    params.append(f"%{comparator_class}%")

                if public_data_only:
                    base_query += " AND public_data_status != 'none'"

                base_query += " ORDER BY year DESC, dataset_id ASC"

                cursor.execute(base_query, params)
                return [_row_to_dataset(row) for row in cursor.fetchall()]

    def get_dataset(self, dataset_id: str) -> DatasetRecord | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
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
                        source_publication_url,
                        included_status
                    FROM dataset_records
                    WHERE dataset_id = %s AND included_status = 'included'
                    """,
                    (dataset_id,),
                )
                row = cursor.fetchone()
                return _row_to_dataset(row) if row else None

    def get_datasets_by_ids(self, dataset_ids: Sequence[str]) -> list[DatasetRecord]:
        if not dataset_ids:
            return []

        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
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
                        source_publication_url,
                        included_status
                    FROM dataset_records
                    WHERE dataset_id = ANY(%s) AND included_status = 'included'
                    """,
                    (list(dataset_ids),),
                )
                rows = {_row["dataset_id"]: _row_to_dataset(_row) for _row in cursor.fetchall()}
                return [rows[dataset_id] for dataset_id in dataset_ids if dataset_id in rows]
