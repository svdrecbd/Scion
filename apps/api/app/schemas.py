import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


PublicDataStatus = Literal["none", "partial", "complete"]
SourceType = Literal["paper", "repository", "internal"]
ModalityFamily = Literal["EM", "X-ray", "optical", "other"]
BoundaryStatus = Literal["yes", "no", "unclear"]
SignupStatus = Literal["ok"]

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


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
    source_study_id: str | None = None
    publication_pmid: str | None = None
    source_publication_url: str | None = None
    public_locator_urls: list[str] = Field(default_factory=list)
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


class BetaSignupRequest(BaseModel):
    first_name: str | None = Field(default=None, max_length=80)
    last_name: str | None = Field(default=None, max_length=80)
    affiliation: str | None = Field(default=None, max_length=160)
    email: str = Field(min_length=3, max_length=254)
    source_path: str | None = Field(default=None, max_length=300)
    consent_text_version: str = Field(default="beta-interest-v1", max_length=40)
    website: str | None = Field(default=None, max_length=200)

    @field_validator("first_name", "last_name", "affiliation", "source_path", "website", mode="before")
    @classmethod
    def blank_optional_to_none(cls, value):
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None

    @field_validator("consent_text_version", mode="before")
    @classmethod
    def normalize_consent_version(cls, value):
        normalized = str(value or "").strip()
        return normalized or "beta-interest-v1"

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not EMAIL_RE.match(normalized):
            raise ValueError("Enter a valid email address.")
        return normalized


class BetaSignupResponse(BaseModel):
    status: SignupStatus


class AuthStartRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not EMAIL_RE.match(normalized):
            raise ValueError("Enter a valid email address.")
        return normalized


class AuthStartResponse(BaseModel):
    status: Literal["ok"]
    message: str


class AuthVerifyRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    code: str = Field(min_length=4, max_length=12)
    remember: bool = False

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not EMAIL_RE.match(normalized):
            raise ValueError("Enter a valid email address.")
        return normalized

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return "".join(ch for ch in value.strip() if ch.isdigit())


class AuthUser(BaseModel):
    user_id: UUID
    primary_email: str
    display_name: str | None = None
    created_at: datetime


class AuthSession(BaseModel):
    session_id: UUID
    created_at: datetime
    expires_at: datetime
    last_seen_at: datetime
    user_agent: str | None = None
    ip_address: str | None = None
    current: bool = False
    remember: bool = False


class AuthMeResponse(BaseModel):
    authenticated: bool
    user: AuthUser | None = None
    session: AuthSession | None = None


class AuthVerifyResponse(BaseModel):
    status: Literal["ok"]
    user: AuthUser
    session: AuthSession


class AuthSessionsResponse(BaseModel):
    sessions: list[AuthSession]


class AuthDevice(BaseModel):
    device_id: UUID
    device_name: str
    platform: str | None = None
    created_at: datetime
    expires_at: datetime
    last_seen_at: datetime | None = None
    current: bool = False


class DevicePairStartRequest(BaseModel):
    device_name: str = Field(default="Workbench", min_length=1, max_length=120)
    platform: str | None = Field(default=None, max_length=80)

    @field_validator("device_name", mode="before")
    @classmethod
    def normalize_device_name(cls, value):
        normalized = str(value or "").strip()
        return normalized or "Workbench"

    @field_validator("platform", mode="before")
    @classmethod
    def normalize_platform(cls, value):
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None


class DevicePairStartResponse(BaseModel):
    status: Literal["ok"]
    user_code: str
    device_code: str
    verification_uri: str
    expires_at: datetime
    interval_seconds: int


class DevicePairApproveRequest(BaseModel):
    user_code: str = Field(min_length=4, max_length=20)

    @field_validator("user_code")
    @classmethod
    def normalize_user_code(cls, value: str) -> str:
        return value.strip().upper().replace(" ", "").replace("-", "")


class DevicePairApproveResponse(BaseModel):
    status: Literal["approved"]
    device_name: str
    platform: str | None = None


class DevicePairPollRequest(BaseModel):
    device_code: str = Field(min_length=16, max_length=200)


class DevicePairPollResponse(BaseModel):
    status: Literal["pending", "approved", "expired"]
    device_token: str | None = None
    user: AuthUser | None = None
    device: AuthDevice | None = None
    expires_at: datetime | None = None


class AuthDevicesResponse(BaseModel):
    devices: list[AuthDevice]


class DeviceMeResponse(BaseModel):
    authenticated: bool
    user: AuthUser | None = None
    device: AuthDevice | None = None
