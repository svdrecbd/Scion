from collections import Counter
from typing import Iterable

from app.schemas import DatasetRecord


def summarize_commonalities(datasets: list[DatasetRecord], limit: int = 5) -> dict[str, list[str]]:
    organelles = Counter()
    organelle_pairs = Counter()
    metric_families = Counter()
    modalities = Counter()
    cell_types = Counter()

    for dataset in datasets:
        organelles.update(dataset.organelles)
        organelle_pairs.update(dataset.organelle_pairs)
        metric_families.update(dataset.metric_families)
        modalities.update([dataset.modality])
        cell_types.update([dataset.cell_type])

    return {
        "top_organelles": [value for value, _ in organelles.most_common(limit)],
        "top_organelle_pairs": [value for value, _ in organelle_pairs.most_common(limit)],
        "top_metric_families": [value for value, _ in metric_families.most_common(limit)],
        "top_modalities": [value for value, _ in modalities.most_common(limit)],
        "top_cell_types": [value for value, _ in cell_types.most_common(limit)],
    }


def summarize_facets(datasets: list[DatasetRecord]) -> dict[str, list[tuple[str, int]]]:
    def counter_for(iterable: Iterable[str]) -> list[tuple[str, int]]:
        return Counter(iterable).most_common()

    return {
        "cell_types": counter_for(dataset.cell_type for dataset in datasets),
        "modalities": counter_for(dataset.modality for dataset in datasets),
        "organelles": counter_for(organelle for dataset in datasets for organelle in dataset.organelles),
        "metric_families": counter_for(
            metric for dataset in datasets for metric in dataset.metric_families
        ),
        "comparator_classes": counter_for(
            dataset.comparator_class for dataset in datasets if dataset.comparator_class
        ),
    }
