from typing import Literal

from pydantic import BaseModel, Field


PublicDataStatus = Literal["none", "partial", "complete"]
SourceType = Literal["paper", "repository", "internal"]
ModalityFamily = Literal["EM", "X-ray", "optical", "other"]
BoundaryStatus = Literal["yes", "no", "unclear"]


class DatasetRecord(BaseModel):
    dataset_id: str
    title: str
    paper_title: str
    year: int
    source: str
    source_type: SourceType
    public_data_status: PublicDataStatus

    species: str
    cell_type: str
    tissue_or_system: str | None = None
    comparator_class: str | None = None
    comparator_detail: str | None = None

    modality: str
    modality_family: ModalityFamily
    lateral_resolution_nm: float | None = None
    axial_resolution_nm: float | None = None
    isotropic: bool | None = None

    organelles: list[str]
    organelle_pairs: list[str]
    metric_families: list[str]

    sample_size: int | None = None
    sample_size_bucket: str = "unknown"
    metadata_completeness_score: float = Field(ge=0.0, le=1.0)
    whole_cell_boundary_confirmed: BoundaryStatus = "unclear"
    notes: str | None = None
    source_publication_url: str | None = None
    included_status: str = "included"


class SearchResponse(BaseModel):
    total: int
    results: list[DatasetRecord]
    commonalities: dict[str, list[str]]


class FacetValue(BaseModel):
    value: str
    count: int


class FacetResponse(BaseModel):
    cell_types: list[FacetValue]
    modalities: list[FacetValue]
    organelles: list[FacetValue]
    metric_families: list[FacetValue]
    comparator_classes: list[FacetValue]


class CompareRequest(BaseModel):
    dataset_ids: list[str] = Field(min_length=2, max_length=8)


class CompareResponse(BaseModel):
    datasets: list[DatasetRecord]
    shared_fields: dict[str, list[str]]
    key_differences: dict[str, list[str]]
    comparability_score: int = Field(ge=0, le=100)
    summary: str
