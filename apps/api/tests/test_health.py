import os

from fastapi.testclient import TestClient
import pytest

from app.config import get_settings
from app.data.mock_datasets import MOCK_DATASETS
from app.dependencies import get_dataset_repository
from app.errors import DatabaseUnavailableError
from app.main import app
from app.observability import REQUEST_ID_HEADER
from app.pressure import get_pressure_semaphore
from app.repositories import InMemoryDatasetRepository


@pytest.fixture
def client() -> TestClient:
    previous_skip_startup_checks = os.environ.get("SCION_SKIP_STARTUP_CHECKS")
    os.environ["SCION_SKIP_STARTUP_CHECKS"] = "true"
    get_settings.cache_clear()
    app.dependency_overrides[get_dataset_repository] = lambda: InMemoryDatasetRepository(
        MOCK_DATASETS
    )
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        if previous_skip_startup_checks is None:
            os.environ.pop("SCION_SKIP_STARTUP_CHECKS", None)
        else:
            os.environ["SCION_SKIP_STARTUP_CHECKS"] = previous_skip_startup_checks
        get_settings.cache_clear()


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/api/health", headers={REQUEST_ID_HEADER: "health-test"})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["x-request-id"] == "health-test"


def test_dataset_search_endpoint(client: TestClient) -> None:
    response = client.get("/api/datasets", params={"organelle": "mitochondria", "limit": 1})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] >= 1
    assert len(payload["results"]) == 1
    assert all("mitochondria" in item["organelles"] for item in payload["results"])
    assert "top_organelles" in payload["commonalities"]


def test_facets_endpoint_uses_repository_counts(client: TestClient) -> None:
    response = client.get("/api/datasets/facets")
    assert response.status_code == 200
    payload = response.json()
    assert payload["cell_types"]
    assert payload["organelles"]
    assert payload["metric_families"]


def test_similar_and_plan_endpoints_work_with_in_memory_repository(client: TestClient) -> None:
    search_response = client.get("/api/datasets")
    assert search_response.status_code == 200
    dataset_id = search_response.json()["results"][0]["dataset_id"]

    similar_response = client.get(f"/api/datasets/{dataset_id}/similar")
    assert similar_response.status_code == 200
    assert all(item["dataset_id"] != dataset_id for item in similar_response.json())

    plan_response = client.get(
        "/api/datasets/analytics/plan",
        params={"organelles": "mitochondria", "res": "50", "ss": "5"},
    )
    assert plan_response.status_code == 200
    payload = plan_response.json()
    assert payload["status"] in {"feasible", "challenging", "high-risk", "frontier"}
    assert "precedents" in payload


class BrokenDatasetRepository:
    def search_datasets(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def list_datasets(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_search_commonalities(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_dataset(self, dataset_id: str):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_datasets_by_ids(self, dataset_ids: list[str]):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_cross_tab(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_frontier_data(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_toolkit_matrix(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_measurement_grammar(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_reusability_map(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_coverage_atlas(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_corpus_timeline(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_benchmarks(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_facets(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_similar_datasets(self, *args, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def list_plan_datasets(self, *args, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")


def test_dataset_endpoints_return_503_when_database_is_unavailable(client: TestClient) -> None:
    app.dependency_overrides[get_dataset_repository] = lambda: BrokenDatasetRepository()

    try:
        response = client.get("/api/datasets", headers={REQUEST_ID_HEADER: "db-down-test"})
    finally:
        app.dependency_overrides[get_dataset_repository] = lambda: InMemoryDatasetRepository(
            MOCK_DATASETS
        )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Scion database is unavailable.",
        "request_id": "db-down-test",
    }
    assert response.headers["x-request-id"] == "db-down-test"


def test_export_endpoint_rejects_oversized_requests(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SCION_EXPORT_MAX_ROWS", "1")
    get_settings.cache_clear()

    try:
        response = client.get(
            "/api/datasets/export",
            params={"format": "json"},
            headers={REQUEST_ID_HEADER: "export-limit-test"},
        )
    finally:
        get_settings.cache_clear()

    assert response.status_code == 413
    assert response.json() == {
        "detail": "Export exceeds the 1-row safety limit. Narrow the filters and retry.",
        "request_id": "export-limit-test",
    }
    assert response.headers["x-request-id"] == "export-limit-test"


def test_export_endpoint_returns_429_when_export_slot_is_busy(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SCION_EXPORT_SLOT_LIMIT", "1")
    monkeypatch.setenv("SCION_BUSY_RETRY_AFTER_SECONDS", "7")
    get_settings.cache_clear()
    semaphore = get_pressure_semaphore("datasets.export", 1)
    acquired = semaphore.acquire(blocking=False)
    assert acquired

    try:
        response = client.get(
            "/api/datasets/export",
            params={"format": "json"},
            headers={REQUEST_ID_HEADER: "export-busy-test"},
        )
    finally:
        semaphore.release()
        get_settings.cache_clear()

    assert response.status_code == 429
    assert response.headers["retry-after"] == "7"
    assert response.json() == {
        "detail": "Scion export capacity is saturated. Retry shortly.",
        "request_id": "export-busy-test",
    }


def test_analytics_endpoint_returns_429_when_slot_is_busy(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SCION_ANALYTICS_SLOT_LIMIT", "1")
    monkeypatch.setenv("SCION_BUSY_RETRY_AFTER_SECONDS", "9")
    get_settings.cache_clear()
    semaphore = get_pressure_semaphore("datasets.analytics.frontier", 1)
    acquired = semaphore.acquire(blocking=False)
    assert acquired

    try:
        response = client.get(
            "/api/datasets/analytics/frontier",
            headers={REQUEST_ID_HEADER: "analytics-busy-test"},
        )
    finally:
        semaphore.release()
        get_settings.cache_clear()

    assert response.status_code == 429
    assert response.headers["retry-after"] == "9"
    assert response.json() == {
        "detail": "Scion analytics capacity is saturated. Retry shortly.",
        "request_id": "analytics-busy-test",
    }
