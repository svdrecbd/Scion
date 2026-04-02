from collections import defaultdict

from app.schemas import CompareResponse, DatasetRecord


def _intersection(values: list[list[str]]) -> list[str]:
    if not values:
        return []
    shared = set(values[0])
    for group in values[1:]:
        shared &= set(group)
    return sorted(shared)


def _unique(values: list[list[str]]) -> list[str]:
    unique_values: set[str] = set()
    for group in values:
        unique_values.update(group)
    return sorted(unique_values)


def _all_same(values: list[str]) -> bool:
    return len(set(values)) == 1 if values else False


def build_compare_response(datasets: list[DatasetRecord]) -> CompareResponse:
    shared_fields = {
        "cell_types": _intersection([[dataset.cell_type] for dataset in datasets]),
        "species": _intersection([[dataset.species] for dataset in datasets]),
        "organelles": _intersection([dataset.organelles for dataset in datasets]),
        "organelle_pairs": _intersection([dataset.organelle_pairs for dataset in datasets]),
        "metric_families": _intersection([dataset.metric_families for dataset in datasets]),
        "comparator_classes": _intersection(
            [[dataset.comparator_class] for dataset in datasets if dataset.comparator_class]
        ),
        "modality_families": _intersection([[dataset.modality_family] for dataset in datasets]),
    }

    key_differences = {
        "modalities": _unique([[dataset.modality] for dataset in datasets]),
        "sample_size_buckets": _unique([[dataset.sample_size_bucket] for dataset in datasets]),
        "public_data_statuses": _unique([[dataset.public_data_status] for dataset in datasets]),
        "boundary_confirmation": _unique(
            [[dataset.whole_cell_boundary_confirmed] for dataset in datasets]
        ),
    }

    score = 0
    if _all_same([dataset.cell_type for dataset in datasets]):
        score += 25
    if _all_same([dataset.species for dataset in datasets]):
        score += 10
    if shared_fields["organelle_pairs"]:
        score += min(20, 5 * len(shared_fields["organelle_pairs"]))
    if shared_fields["metric_families"]:
        score += min(15, 3 * len(shared_fields["metric_families"]))
    if _all_same([dataset.modality_family for dataset in datasets]):
        score += 10
    if shared_fields["comparator_classes"]:
        score += 10
    if all(dataset.metadata_completeness_score >= 0.8 for dataset in datasets):
        score += 10

    score = min(score, 100)

    if score >= 75:
        summary = "High biological overlap with enough shared structure to justify direct comparison."
    elif score >= 50:
        summary = "Moderate comparability; useful for targeted comparison with technical caveats."
    else:
        summary = "Low direct comparability; treat these datasets as analogs rather than close matches."

    return CompareResponse(
        datasets=datasets,
        shared_fields=shared_fields,
        key_differences=key_differences,
        comparability_score=score,
        summary=summary,
    )
