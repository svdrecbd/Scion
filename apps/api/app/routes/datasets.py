import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from app.dependencies import get_dataset_repository
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
from app.services.search import (
    filter_datasets,
    summarize_commonalities,
    summarize_facets,
)

router = APIRouter(prefix="/datasets", tags=["datasets"])


@router.get("", response_model=SearchResponse)
def search_datasets(
    query: str | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    limit: int = 200,
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> SearchResponse:
    filtered = repository.list_datasets(
        query=query,
        cell_type=cell_type,
        organelle=organelle,
        organelle_pair=organelle_pair,
        modality=modality,
        modality_family=modality_family,
        metric_family=metric_family,
        comparator_class=comparator_class,
        public_data_only=public_data_only,
        include_borderline=include_borderline,
    )
    return SearchResponse(
        total=len(filtered),
        results=filtered[:limit],
        commonalities=summarize_commonalities(filtered),
    )


@router.get("/export")
def export_datasets(
    format: str = Query("csv", pattern="^(csv|json|bibtex)$"),
    query: str | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    filtered = repository.list_datasets(
        query=query,
        cell_type=cell_type,
        organelle=organelle,
        organelle_pair=organelle_pair,
        modality=modality,
        modality_family=modality_family,
        metric_family=metric_family,
        comparator_class=comparator_class,
        public_data_only=public_data_only,
        include_borderline=include_borderline,
    )

    if format == "json":
        return filtered

    if format == "bibtex":
        bib_entries = []
        for d in filtered:
            # Create a slug for the cite key
            slug = d.dataset_id.replace("-", "")
            entry = f"@article{{{slug},\n"
            entry += f"  title = {{{d.paper_title}}},\n"
            entry += f"  author = {{{d.source}}},\n"
            entry += f"  journal = {{{d.source}}},\n"
            entry += f"  year = {{{d.year}}},\n"
            entry += f"  note = {{Indexed in Scion: {d.title}}}\n"
            entry += "}\n"
            bib_entries.append(entry)

        return StreamingResponse(
            io.StringIO("\n".join(bib_entries)),
            media_type="text/plain",
            headers={"Content-Disposition": "attachment; filename=scion_export.bib"},
        )

    output = io.StringIO()
    writer = csv.writer(output)

    # Header
    writer.writerow(
        [
            "Dataset ID",
            "Title",
            "Paper Title",
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
            "Notes",
        ]
    )

    # Rows
    for d in filtered:
        writer.writerow(
            [
                d.dataset_id,
                d.title,
                d.paper_title,
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
                d.notes or "",
            ]
        )

    output.seek(0)
    filename = f"scion_export_{format}.{format}"
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/facets", response_model=FacetResponse)
def get_facets(
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> FacetResponse:
    facets = summarize_facets(repository.list_datasets())

    def facet_values(key: str) -> list[FacetValue]:
        return [FacetValue(value=value, count=count) for value, count in facets[key]]

    return FacetResponse(
        cell_types=facet_values("cell_types"),
        modalities=facet_values("modalities"),
        organelles=facet_values("organelles"),
        metric_families=facet_values("metric_families"),
        comparator_classes=facet_values("comparator_classes"),
    )


@router.get("/analytics/cross-tab")
def get_cross_tab(
    row: str = Query(..., description="The trait for rows (e.g., cell_type)"),
    col: str = Query(..., description="The trait for columns (e.g., public_data_status)"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    datasets = repository.list_datasets(include_borderline=True)

    # Calculate counts for each intersection
    table = {}
    row_totals = {}
    col_totals = {}

    for d in datasets:
        # Get values for row and column
        r_val = getattr(d, row, "none")
        c_val = getattr(d, col, "none")

        # Normalize None to "none"
        if r_val is None:
            r_val = "none"
        if c_val is None:
            c_val = "none"

        # Handle lists (like organelles) by taking the first one
        if isinstance(r_val, list):
            r_val = r_val[0] if r_val else "none"
        if isinstance(c_val, list):
            c_val = c_val[0] if c_val else "none"

        # Ensure values are strings for dictionary keys and sorting
        r_val = str(r_val)
        c_val = str(c_val)

        if r_val not in table:
            table[r_val] = {}
        table[r_val][c_val] = table[r_val].get(c_val, 0) + 1

        row_totals[r_val] = row_totals.get(r_val, 0) + 1
        col_totals[c_val] = col_totals.get(c_val, 0) + 1

    return {
        "table": table,
        "row_totals": row_totals,
        "col_totals": col_totals,
        "rows": sorted(row_totals.keys()),
        "cols": sorted(col_totals.keys()),
    }


@router.get("/analytics/frontier")
def get_frontier_data(
    query: str | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    datasets = repository.list_datasets(
        query=query,
        cell_type=cell_type,
        organelle=organelle,
        organelle_pair=organelle_pair,
        modality=modality,
        modality_family=modality_family,
        metric_family=metric_family,
        comparator_class=comparator_class,
        public_data_only=public_data_only,
        include_borderline=include_borderline,
    )

    return [
        {
            "id": d.dataset_id,
            "title": d.title,
            "res": d.lateral_resolution_nm,
            "ss": d.sample_size,
            "modality": d.modality_family,
        }
        for d in datasets
        if d.lateral_resolution_nm and d.sample_size
    ]


@router.get("/analytics/toolkit")
def get_toolkit_matrix(
    query: str | None = None,
    cell_type: str | None = None,
    organelle: str | None = None,
    organelle_pair: str | None = Query(default=None, alias="pair"),
    modality: str | None = None,
    modality_family: str | None = Query(default=None, alias="family"),
    metric_family: str | None = Query(default=None, alias="metric"),
    comparator_class: str | None = None,
    public_data_only: bool = Query(default=False, alias="public"),
    include_borderline: bool = Query(default=False, alias="borderline"),
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    datasets = repository.list_datasets(
        query=query,
        cell_type=cell_type,
        organelle=organelle,
        organelle_pair=organelle_pair,
        modality=modality,
        modality_family=modality_family,
        metric_family=metric_family,
        comparator_class=comparator_class,
        public_data_only=public_data_only,
        include_borderline=include_borderline,
    )

    # Calculate counts for each organelle vs modality family
    matrix = {}
    organelles_found = set()
    modality_families = set()

    for d in datasets:
        mod_fam = d.modality_family
        modality_families.add(mod_fam)

        for org in d.organelles:
            organelles_found.add(org)
            if org not in matrix:
                matrix[org] = {}
            matrix[org][mod_fam] = matrix[org].get(mod_fam, 0) + 1

    return {
        "matrix": matrix,
        "organelles": sorted(list(organelles_found)),
        "modalities": sorted(list(modality_families)),
    }


@router.get("/analytics/benchmarks")
def get_benchmarks(
    repository: DatasetRepository = Depends(get_dataset_repository),
):
    datasets = repository.list_datasets(include_borderline=True)

    # Group by modality family
    benchmarks = {}

    for d in datasets:
        family = d.modality_family
        if family not in benchmarks:
            benchmarks[family] = {"resolutions": [], "sample_sizes": [], "count": 0}

        if d.lateral_resolution_nm:
            benchmarks[family]["resolutions"].append(d.lateral_resolution_nm)
        if d.sample_size:
            benchmarks[family]["sample_sizes"].append(d.sample_size)
        benchmarks[family]["count"] += 1

    # Calculate statistics for each family
    results = []
    for family, data in benchmarks.items():
        res = sorted(data["resolutions"])
        ss = sorted(data["sample_sizes"])

        def stats(values):
            if not values:
                return None
            return {
                "min": min(values),
                "max": max(values),
                "median": values[len(values) // 2],
                "avg": round(sum(values) / len(values), 1),
            }

        results.append(
            {
                "modality_family": family,
                "count": data["count"],
                "resolution_stats": stats(res),
                "sample_size_stats": stats(ss),
            }
        )

    return results


@router.get("/analytics/plan", response_model=PlanAnalysis)
def get_experiment_plan(
    organelles: str = Query(..., description="Comma-separated organelles"),
    res: float = Query(..., description="Target resolution in nm"),
    ss: int = Query(..., description="Target sample size in cells"),
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> PlanAnalysis:
    datasets = repository.list_datasets(include_borderline=True)
    organelle_list = [o.strip() for o in organelles.split(",") if o.strip()]
    return analyze_experiment_plan(datasets, organelle_list, res, ss)


@router.get("/{dataset_id}/similar", response_model=list[DatasetRecord])
def get_similar_datasets(
    dataset_id: str,
    limit: int = 4,
    repository: DatasetRepository = Depends(get_dataset_repository),
) -> list[DatasetRecord]:
    target = repository.get_dataset(dataset_id)
    if not target:
        raise HTTPException(status_code=404, detail="Dataset not found")

    all_datasets = repository.list_datasets()

    # Simple similarity scoring
    scored = []
    for d in all_datasets:
        if d.dataset_id == target.dataset_id:
            continue

        score = 0
        if d.cell_type == target.cell_type:
            score += 40
        if d.species == target.species:
            score += 10
        if d.modality_family == target.modality_family:
            score += 10

        # Overlap scores for sets
        shared_organelles = set(d.organelles) & set(target.organelles)
        score += len(shared_organelles) * 5

        shared_metrics = set(d.metric_families) & set(target.metric_families)
        score += len(shared_metrics) * 5

        scored.append((d, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    return [x[0] for x in scored[:limit]]


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
    selected = repository.get_datasets_by_ids(payload.dataset_ids)

    if len(selected) != len(payload.dataset_ids):
        raise HTTPException(status_code=404, detail="One or more dataset IDs were not found")

    return build_compare_response(selected)
