from app.repositories import DatasetRepository, PostgresDatasetRepository


def get_dataset_repository() -> DatasetRepository:
    return PostgresDatasetRepository()
