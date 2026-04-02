from __future__ import annotations
from typing import Literal
from pydantic import BaseModel
from app.schemas import DatasetRecord

FeasibilityStatus = Literal["feasible", "challenging", "high-risk", "frontier"]

class PlanAnalysis(BaseModel):
    biological_target: str
    target_res_nm: float
    target_sample_size: int
    status: FeasibilityStatus
    status_message: str
    modality_recommendation: str
    precedents: list[DatasetRecord]
    standard_metrics: list[str]
    suggested_baselines: list[DatasetRecord]

def analyze_experiment_plan(
    datasets: list[DatasetRecord],
    organelles: list[str],
    target_res: float,
    target_ss: int
) -> PlanAnalysis:
    # 1. Find studies matching at least one organelle
    bio_matches = [
        d for d in datasets 
        if any(o in d.organelles for o in organelles)
    ]
    
    # 2. Narrow by resolution and sample size
    strict_matches = [
        d for d in bio_matches
        if (d.lateral_resolution_nm or 999) <= target_res * 1.5
        and (d.sample_size or 0) >= target_ss * 0.5
    ]
    
    # 3. Calculate status
    status: FeasibilityStatus = "feasible"
    if not bio_matches:
        status = "frontier"
        msg = "No studies in the corpus have imaged this biological target. This would be a novel contribution."
    elif not strict_matches:
        status = "high-risk"
        msg = f"While {len(bio_matches)} studies exist for these organelles, none have achieved your specific combination of resolution and sample size. This plan pushes current technical limits."
    elif len(strict_matches) < 3:
        status = "challenging"
        msg = f"Only {len(strict_matches)} studies have achieved similar technical specs for this target. This experiment is at the edge of common practice."
    else:
        status = "feasible"
        msg = f"{len(strict_matches)} studies have successfully achieved or exceeded these specs. This is a well-precedented experiment plan."

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
        modality_recommendation=f"Based on {len(bio_matches)} studies, {top_modality} is the most common approach for this target.",
        precedents=strict_matches or bio_matches[:10],
        standard_metrics=sorted_metrics[:3],
        suggested_baselines=[d for d in bio_matches if d.public_data_status != 'none'][:3]
    )
