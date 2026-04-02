from fastapi.testclient import TestClient

from app.data.mock_datasets import MOCK_DATASETS
from app.dependencies import get_dataset_repository
from app.errors import DatabaseUnavailableError
from app.main import app
from app.repositories import InMemoryDatasetRepository


app.dependency_overrides[get_dataset_repository] = lambda: InMemoryDatasetRepository(MOCK_DATASETS)
client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_dataset_search_endpoint() -> None:
    response = client.get("/api/datasets", params={"organelle": "mitochondria"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] >= 1
    assert all("mitochondria" in item["organelles"] for item in payload["results"])


class BrokenDatasetRepository:
    def list_datasets(self, **kwargs):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_dataset(self, dataset_id: str):
        raise DatabaseUnavailableError("Scion database is unavailable.")

    def get_datasets_by_ids(self, dataset_ids: list[str]):
        raise DatabaseUnavailableError("Scion database is unavailable.")


def test_dataset_endpoints_return_503_when_database_is_unavailable() -> None:
    app.dependency_overrides[get_dataset_repository] = lambda: BrokenDatasetRepository()

    try:
        response = client.get("/api/datasets")
    finally:
        app.dependency_overrides[get_dataset_repository] = (
            lambda: InMemoryDatasetRepository(MOCK_DATASETS)
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Scion database is unavailable."}
