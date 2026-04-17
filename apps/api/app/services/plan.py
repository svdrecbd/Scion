from __future__ import annotations
from typing import Literal
from pydantic import BaseModel
from app.schemas import DatasetRecord

FeasibilityStatus = Literal["feasible", "challenging", "high-risk", "frontier"]

class PlanAnalysis(BaseModel):
    biological_target: str
    target_res_nm: float | None = None
    target_sample_size: int | None = None
    status: FeasibilityStatus
    status_message: str
    modality_recommendation: str
    precedents: list[DatasetRecord]
    standard_metrics: list[str]
    suggested_baselines: list[DatasetRecord]
    matched_records_count: int
    threshold_records_count: int

def analyze_experiment_plan(
    datasets: list[DatasetRecord],
    organelles: list[str],
    target_res: float | None,
    target_ss: int | None
) -> PlanAnalysis:
    # 1. Find studies matching at least one requested organelle.
    bio_matches = [
        d for d in datasets 
        if any(o in d.organelles for o in organelles)
    ]
    
    # 2. Narrow by requested thresholds. Missing thresholds mean "any".
    strict_matches: list[DatasetRecord] = []
    for dataset in bio_matches:
        meets_resolution = True
        meets_sample_size = True

        if target_res is not None:
            meets_resolution = (dataset.lateral_resolution_nm or 999) <= target_res * 1.5

        if target_ss is not None:
            meets_sample_size = (dataset.sample_size or 0) >= target_ss * 0.5

        if meets_resolution and meets_sample_size:
            strict_matches.append(dataset)
    
    # 3. Calculate status
    status: FeasibilityStatus = "feasible"
    if not bio_matches:
        status = "frontier"
        msg = "No records in the current corpus capture this organelle target."
    elif not strict_matches:
        status = "high-risk"
        msg = f"{len(bio_matches)} matching records exist in the current corpus, but none meet the active threshold filters."
    elif len(strict_matches) < 3:
        status = "challenging"
        msg = f"Only {len(strict_matches)} records in the current corpus meet the active threshold filters for this target."
    else:
        status = "feasible"
        msg = f"{len(strict_matches)} records in the current corpus meet the active filters for this target."

    # 4. Modality Triage
    modality_counts = {}
    for d in bio_matches:
        modality_counts[d.modality] = modality_counts.get(d.modality, 0) + 1
    
    top_modality = max(modality_counts, key=modality_counts.get) if modality_counts else "Unknown"
    
    # 5. Metrics
    metrics_found = {}
    for d in bio_matches:
        for m in d.metric_families:
            metrics_found[m] = metrics_found.get(m, 0) + 1
    
    sorted_metrics = sorted(metrics_found.keys(), key=lambda x: metrics_found[x], reverse=True)

    return PlanAnalysis(
        biological_target=" & ".join(organelles),
        target_res_nm=target_res,
        target_sample_size=target_ss,
        status=status,
        status_message=msg,
        modality_recommendation=f"In the current corpus, {top_modality} is the most common modality for this target ({len(bio_matches)} matching records).",
        precedents=strict_matches or bio_matches,
        standard_metrics=sorted_metrics[:3],
        suggested_baselines=[d for d in bio_matches if d.public_data_status != 'none'][:3],
        matched_records_count=len(bio_matches),
        threshold_records_count=len(strict_matches),
    )
