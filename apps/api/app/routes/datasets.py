import csv
import io
import logging
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.dependencies import get_dataset_repository
from app.errors import ExportLimitError
from app.observability import duration_ms_since, operation_log_level, with_request_context
from app.pressure import pressure_guard
from app.repositories import DatasetRepository
from app.schemas import (
    CompareRequest,
    CompareResponse,
    DatasetRecord,
    FacetResponse,
    FacetValue,
    SearchResponse,
)
from app.services.compare import build_compare_response
from app.services.plan import PlanAnalysis, analyze_experiment_plan

router = APIRouter(prefix="/datasets", tags=["datasets"])
route_logger = logging.getLogger("scion.route")


def _guard_analytics_slot(slot_name: str):
    settings = get_settings()
    return pressure_guard(
        slot_name,
        limit=settings.analytics_slot_limit,
        detail="Scion analytics capacity is saturated. Retry shortly.",
        retry_after_seconds=settings.busy_retry_after_seconds,
    )


def _guard_export_slot():
    settings = get_settings()
    return pressure_guard(
        "datasets.export",
        limit=settings.export_slot_limit,
        detail="Scion export capacity is saturated. Retry shortly.",
        retry_after_seconds=settings.busy_retry_after_seconds,
    )


def _log_route_timing(operation: str, started_at: float, **context) -> None:
    duration_ms = duration_ms_since(started_at)
    route_logger.log(
        operation_log_level(duration_ms, get_settings().slow_operation_ms),
        "route operation completed",
        extra=with_request_context(
            {
                "event": "route_operation_completed",
                "operation": operation,
                "duration_ms": duration_ms,
                **context,
            }
        ),
    )


def _parse_plan_organelles(organelles: str) -> list[str]:
    return [organelle.strip() for organelle in organelles.split(",") if organelle.strip()]


def _build_plan_analysis(
    *,
    repository: DatasetRepository,
    organelles: str,
    res: float | None,
    ss: int | None,
    cell_type: str | None,
    metric_family: str | None,
    comparator_class: str | None,
    modality_family: str | None,
) -> tuple[list[str], list[DatasetRecord], PlanAnalysis]:
    organelle_list = _parse_plan_organelles(organelles)
    datasets = repository.list_datasets(
        cell_type=cell_type,
        metric_family=metric_family,
        comparator_class=comparator_class,
        modality_family=modality_family,
        include_borderline=True,
    )
    return organelle_list, datasets, analyze_experiment_plan(datasets, organelle_list, res, ss)


@router.get("", response_model=SearchResponse)
def search_datasets(
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    limit: int = Query(default=200, ge=1, le=500),
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> SearchResponse:
    started_at = perf_counter()
    try:
        page = repository.search_datasets(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            modality_family=modality_family,
            metric_family=metric_family,
            comparator_class=comparator_class,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    commonalities = (
        repository.get_search_commonalities(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            modality_family=modality_family,
            metric_family=metric_family,
            comparator_class=comparator_class,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        if page.total
        else {
            "top_organelles": [],
            "top_organelle_pairs": [],
            "top_metric_families": [],
            "top_modalities": [],
            "top_cell_types": [],
        }
    )
    response = SearchResponse(
        total=page.total,
        results=page.results,
        commonalities=commonalities,
    )
    _log_route_timing(
        "datasets.search",
        started_at,
        total_matches=response.total,
        returned_count=len(response.results),
        limit=limit,
    )
    return response


@router.get("/export")
def export_datasets(
    format: str = Query("csv", pattern="^(csv|json|bibtex)$"),
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    settings = get_settings()

    with _guard_export_slot():
        try:
            filtered = repository.list_datasets(
                query=query,
                year=year,
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                modality_family=modality_family,
                metric_family=metric_family,
                comparator_class=comparator_class,
                public_data_status=public_data_status,
                public_data_only=public_data_only,
                include_borderline=include_borderline,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if len(filtered) > settings.export_max_rows:
            route_logger.warning(
                "export rejected due to safety limit",
                extra=with_request_context(
                    {
                        "event": "route_export_rejected_limit",
                        "requested_count": len(filtered),
                        "row_limit": settings.export_max_rows,
                        "format": format,
                    }
                ),
            )
            raise ExportLimitError(
                f"Export exceeds the {settings.export_max_rows}-row safety limit. Narrow the filters and retry.",
                row_limit=settings.export_max_rows,
            )

        if format == "json":
            _log_route_timing(
                "datasets.export",
                started_at,
                format=format,
                exported_count=len(filtered),
            )
            return filtered

        if format == "bibtex":
            bib_entries = []
            for d in filtered:
                slug = d.dataset_id.replace("-", "")
                entry = f"@article{{{slug},\n"
                entry += f"  title = {{{d.paper_title}}},\n"
                entry += f"  author = {{{d.source_study_id or d.source}}},\n"
                entry += f"  journal = {{{d.source}}},\n"
                entry += f"  year = {{{d.year}}},\n"
                if d.publication_pmid:
                    entry += f"  pmid = {{{d.publication_pmid}}},\n"
                entry += f"  note = {{Indexed in Scion: {d.title}}}\n"
                entry += "}\n"
                bib_entries.append(entry)

            response = StreamingResponse(
                io.StringIO("\n".join(bib_entries)),
                media_type="text/plain",
                headers={
                    "Content-Disposition": "attachment; filename=scion_export.bib",
                    "X-Scion-Export-Count": str(len(filtered)),
                    "X-Scion-Export-Limit": str(settings.export_max_rows),
                },
            )
            _log_route_timing(
                "datasets.export",
                started_at,
                format=format,
                exported_count=len(filtered),
            )
            return response

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
                "Dataset ID",
                "Title",
                "Paper Title",
                "Study",
                "PMID",
                "Year",
                "Journal",
                "Species",
                "Cell Type",
                "Modality",
                "Res XY (nm)",
                "Res Z (nm)",
                "Organelles",
                "Metrics",
                "Public Data Status",
                "Included Status",
                "Publication URL",
                "Public Data URLs",
                "Notes",
            ]
        )

        for d in filtered:
            writer.writerow(
                [
                    d.dataset_id,
                    d.title,
                    d.paper_title,
                    d.source_study_id or "",
                    d.publication_pmid or "",
                    d.year,
                    d.source,
                    d.species,
                    d.cell_type,
                    d.modality,
                    d.lateral_resolution_nm,
                    d.axial_resolution_nm,
                    "; ".join(d.organelles),
                    "; ".join(d.metric_families),
                    d.public_data_status,
                    d.included_status,
                    d.source_publication_url or "",
                    "; ".join(d.public_locator_urls),
                    d.notes or "",
                ]
            )

        output.seek(0)
        filename = f"scion_export_{format}.{format}"
        response = StreamingResponse(
            output,
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "X-Scion-Export-Count": str(len(filtered)),
                "X-Scion-Export-Limit": str(settings.export_max_rows),
            },
        )
        _log_route_timing(
            "datasets.export",
            started_at,
            format=format,
            exported_count=len(filtered),
        )
        return response


@router.get("/facets", response_model=FacetResponse)
def get_facets(
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> FacetResponse:
    started_at = perf_counter()
    facets = repository.get_facets()

    def facet_values(key: str) -> list[FacetValue]:
        return [FacetValue(value=value, count=count) for value, count in facets[key]]

    response = FacetResponse(
        cell_types=facet_values("cell_types"),
        modalities=facet_values("modalities"),
        organelles=facet_values("organelles"),
        metric_families=facet_values("metric_families"),
        comparator_classes=facet_values("comparator_classes"),
    )
    _log_route_timing(
        "datasets.facets",
        started_at,
        cell_type_count=len(response.cell_types),
        modality_count=len(response.modalities),
        organelle_count=len(response.organelles),
        metric_family_count=len(response.metric_families),
        comparator_class_count=len(response.comparator_classes),
    )
    return response


@router.get("/analytics/cross-tab")
def get_cross_tab(
    row: str = Query(..., description="The trait for rows (e.g., cell_type)"),
    col: str = Query(..., description="The trait for columns (e.g., public_data_status)"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.cross_tab"):
        try:
            response = repository.get_cross_tab(row=row, col=col, include_borderline=True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        _log_route_timing(
            "datasets.analytics.cross_tab",
            started_at,
            row_count=len(response["rows"]),
            col_count=len(response["cols"]),
        )
        return response


@router.get("/analytics/frontier")
def get_frontier_data(
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.frontier"):
        result = repository.get_frontier_data(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            modality_family=modality_family,
            metric_family=metric_family,
            comparator_class=comparator_class,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        _log_route_timing(
            "datasets.analytics.frontier",
            started_at,
            returned_count=len(result),
        )
        return result


@router.get("/analytics/toolkit")
def get_toolkit_matrix(
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.toolkit"):
        response = repository.get_toolkit_matrix(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            modality_family=modality_family,
            metric_family=metric_family,
            comparator_class=comparator_class,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        _log_route_timing(
            "datasets.analytics.toolkit",
            started_at,
            organelle_count=len(response["organelles"]),
            modality_count=len(response["modalities"]),
        )
        return response


@router.get("/analytics/measurement-grammar")
def get_measurement_grammar(
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.measurement_grammar"):
        response = repository.get_measurement_grammar(
            query=query,
            year=year,
            cell_type=cell_type,
            organelle=organelle,
            organelle_pair=organelle_pair,
            modality=modality,
            modality_family=modality_family,
            metric_family=metric_family,
            comparator_class=comparator_class,
            public_data_status=public_data_status,
            public_data_only=public_data_only,
            include_borderline=include_borderline,
        )
        _log_route_timing(
            "datasets.analytics.measurement_grammar",
            started_at,
            organelle_count=len(response["organelles"]),
            metric_family_count=len(response["metric_families"]),
        )
        return response


@router.get("/analytics/reusability-map")
def get_reusability_map(
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.reusability_map"):
        try:
            response = repository.get_reusability_map(
                query=query,
                year=year,
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                modality_family=modality_family,
                metric_family=metric_family,
                comparator_class=comparator_class,
                public_data_status=public_data_status,
                public_data_only=public_data_only,
                include_borderline=include_borderline,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        _log_route_timing(
            "datasets.analytics.reusability_map",
            started_at,
            organelle_count=len(response["organelles"]),
        )
        return response


@router.get("/analytics/coverage-atlas")
def get_coverage_atlas(
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.coverage_atlas"):
        try:
            response = repository.get_coverage_atlas(
                query=query,
                year=year,
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                modality_family=modality_family,
                metric_family=metric_family,
                comparator_class=comparator_class,
                public_data_status=public_data_status,
                public_data_only=public_data_only,
                include_borderline=include_borderline,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        _log_route_timing(
            "datasets.analytics.coverage_atlas",
            started_at,
            cell_type_count=len(response["cell_types"]),
            organelle_count=len(response["organelles"]),
        )
        return response


@router.get("/analytics/timeline")
def get_corpus_timeline(
    query: str | None = None,
    year: int | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_status: str | None = Query(default=None, alias="status"),
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.timeline"):
        try:
            response = repository.get_corpus_timeline(
                query=query,
                year=year,
                cell_type=cell_type,
                organelle=organelle,
                organelle_pair=organelle_pair,
                modality=modality,
                modality_family=modality_family,
                metric_family=metric_family,
                comparator_class=comparator_class,
                public_data_status=public_data_status,
                public_data_only=public_data_only,
                include_borderline=include_borderline,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        _log_route_timing(
            "datasets.analytics.timeline",
            started_at,
            year_count=len(response["years"]),
            modality_family_count=len(response["modality_families"]),
        )
        return response


@router.get("/analytics/benchmarks")
def get_benchmarks(
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.benchmarks"):
        results = repository.get_benchmarks(include_borderline=True)

        _log_route_timing(
            "datasets.analytics.benchmarks",
            started_at,
            benchmark_count=len(results),
        )
        return results


@router.get("/analytics/plan", response_model=PlanAnalysis)
def get_experiment_plan(
    organelles: str = Query(..., description="Comma-separated organelles"),
    res: float | None = Query(default=None, description="Target resolution in nm; omit for any"),
    ss: int | None = Query(default=None, description="Target sample size in cells; omit for any"),
    cell_type: str | None = None,
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> PlanAnalysis:
    started_at = perf_counter()
    with _guard_analytics_slot("datasets.analytics.plan"):
        organelle_list, datasets, response = _build_plan_analysis(
            repository=repository,
            organelles=organelles,
            res=res,
            ss=ss,
            cell_type=cell_type,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
        )
        _log_route_timing(
            "datasets.analytics.plan",
            started_at,
            source_count=len(datasets),
            organelle_count=len(organelle_list),
            cell_type_filter=bool(cell_type),
            metric_family_filter=bool(metric_family),
            comparator_class_filter=bool(comparator_class),
            modality_family_filter=bool(modality_family),
            precedent_count=len(response.precedents),
            baseline_count=len(response.suggested_baselines),
        )
        return response


@router.get("/analytics/plan/export")
def export_experiment_plan(
    organelles: str = Query(..., description="Comma-separated organelles"),
    res: float | None = Query(default=None, description="Target resolution in nm; omit for any"),
    ss: int | None = Query(default=None, description="Target sample size in cells; omit for any"),
    cell_type: str | None = None,
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    started_at = perf_counter()
    settings = get_settings()

    with _guard_export_slot():
        organelle_list, _, analysis = _build_plan_analysis(
            repository=repository,
            organelles=organelles,
            res=res,
            ss=ss,
            cell_type=cell_type,
            metric_family=metric_family,
            comparator_class=comparator_class,
            modality_family=modality_family,
        )

        if len(analysis.precedents) > settings.export_max_rows:
            route_logger.warning(
                "plan export rejected due to safety limit",
                extra=with_request_context(
                    {
                        "event": "route_plan_export_rejected_limit",
                        "requested_count": len(analysis.precedents),
                        "row_limit": settings.export_max_rows,
                    }
                ),
            )
            raise ExportLimitError(
                f"Export exceeds the {settings.export_max_rows}-row safety limit. Narrow the filters and retry.",
                row_limit=settings.export_max_rows,
            )

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
                "Dataset ID",
                "Study",
                "PMID",
                "Paper Title",
                "Year",
                "Journal",
                "Cell Type",
                "Species",
                "Modality",
                "Modality Family",
                "Res XY (nm)",
                "Res Z (nm)",
                "Sample Size",
                "Organelles",
                "Metrics",
                "Comparator Class",
                "Comparator Detail",
                "Public Data Status",
                "Publication URL",
            ]
        )
        for dataset in analysis.precedents:
            writer.writerow(
                [
                    dataset.dataset_id,
                    dataset.source_study_id or "",
                    dataset.publication_pmid or "",
                    dataset.paper_title,
                    dataset.year,
                    dataset.source,
                    dataset.cell_type,
                    dataset.species,
                    dataset.modality,
                    dataset.modality_family,
                    dataset.lateral_resolution_nm,
                    dataset.axial_resolution_nm,
                    dataset.sample_size,
                    "; ".join(dataset.organelles),
                    "; ".join(dataset.metric_families),
                    dataset.comparator_class or "",
                    dataset.comparator_detail or "",
                    dataset.public_data_status,
                    dataset.source_publication_url or "",
                ]
            )

        output.seek(0)
        response = StreamingResponse(
            output,
            media_type="text/csv",
            headers={
                "Content-Disposition": "attachment; filename=scion_plan_precedents.csv",
                "X-Scion-Export-Count": str(len(analysis.precedents)),
                "X-Scion-Export-Limit": str(settings.export_max_rows),
            },
        )
        _log_route_timing(
            "datasets.analytics.plan.export",
            started_at,
            exported_count=len(analysis.precedents),
            organelle_count=len(organelle_list),
        )
        return response


@router.get("/{dataset_id}/similar", response_model=list[DatasetRecord])
def get_similar_datasets(
    dataset_id: str,
    limit: int = 4,
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> list[DatasetRecord]:
    started_at = perf_counter()
    target = repository.get_dataset(dataset_id)
    if not target:
        raise HTTPException(status_code=404, detail="Dataset not found")

    response = repository.get_similar_datasets(target, limit=limit)
    _log_route_timing(
        "datasets.similar",
        started_at,
        dataset_id=dataset_id,
        returned_count=len(response),
    )
    return response


@router.get("/{dataset_id}")
def get_dataset(
    dataset_id: str,
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    dataset = repository.get_dataset(dataset_id)
    if dataset:
        return dataset
    raise HTTPException(status_code=404, detail="Dataset not found")


@router.post("/compare", response_model=CompareResponse)
def compare_datasets(
    payload: CompareRequest,
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> CompareResponse:
    started_at = perf_counter()
    selected = repository.get_datasets_by_ids(payload.dataset_ids)

    if len(selected) != len(payload.dataset_ids):
        raise HTTPException(status_code=404, detail="One or more dataset IDs were not found")

    response = build_compare_response(selected)
    _log_route_timing(
        "datasets.compare",
        started_at,
        dataset_count=len(response.datasets),
        comparability_score=response.comparability_score,
    )
    return response
