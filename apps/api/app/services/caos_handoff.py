from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from urllib.parse import urlparse

from app.schemas import (
    CaosHandoff,
    CaosHandoffAssetCandidate,
    CaosHandoffIntegrity,
    CaosHandoffProjectSeed,
    CaosHandoffRequirements,
    DatasetRecord,
)


EMPIAR_RE = re.compile(r"(?:EMPIAR[-_/]?|world_availability/)(\d+)", re.IGNORECASE)
FIGSHARE_RE = re.compile(r"/(?:articles|ndownloader)/(?:[^/?#]+/)*(\d+)(?:[/?#]|$)", re.IGNORECASE)
ZENODO_RE = re.compile(r"/(?:records?|record)/(\d+)(?:[/?#]|$)", re.IGNORECASE)


def _repository_identity(locator_url: str) -> tuple[str | None, str | None]:
    parsed = urlparse(locator_url)
    host = parsed.netloc.lower()
    value = f"{host}{parsed.path}"

    if "empiar" in host or "ebi.ac.uk" in host:
        match = EMPIAR_RE.search(value)
        return "EMPIAR", match.group(1) if match else None

    if "figshare" in host:
        match = FIGSHARE_RE.search(parsed.path)
        return "Figshare", match.group(1) if match else None

    if "zenodo" in host:
        match = ZENODO_RE.search(parsed.path)
        return "Zenodo", match.group(1) if match else None

    if host:
        return host, None
    return None, None


def _asset_candidates(dataset: DatasetRecord) -> list[CaosHandoffAssetCandidate]:
    candidates: list[CaosHandoffAssetCandidate] = []
    seen: set[str] = set()
    for locator_url in dataset.public_locator_urls:
        normalized = locator_url.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        repository, accession = _repository_identity(normalized)
        candidates.append(
            CaosHandoffAssetCandidate(
                locator_url=normalized,
                repository=repository,
                accession=accession,
            )
        )
    return candidates


def _dataset_fingerprint(
    dataset: DatasetRecord,
    candidates: list[CaosHandoffAssetCandidate],
) -> str:
    # Keep this canonical form intentionally language-neutral so the native
    # Workbench can verify it without depending on Python's JSON float format.
    identity_fields = [
        dataset.dataset_id,
        dataset.title,
        dataset.paper_title,
        str(dataset.year),
        dataset.source_study_id or "",
        dataset.publication_pmid or "",
        dataset.source_publication_url or "",
        dataset.public_data_status,
        *sorted(candidate.locator_url for candidate in candidates),
    ]
    payload = "\n".join(identity_fields)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_caos_handoff(dataset: DatasetRecord) -> CaosHandoff:
    candidates = _asset_candidates(dataset)
    citation = dataset.paper_title or dataset.title
    note = (
        f"Atlas handoff for {citation}. Confirm local data identity, calibration, rights, "
        "and derivative provenance before scientific use."
    )
    return CaosHandoff(
        generated_at=datetime.now(UTC),
        atlas={
            "dataset_path": f"/datasets/{dataset.dataset_id}",
            "api_path": f"/api/datasets/{dataset.dataset_id}",
        },
        dataset=dataset,
        asset_candidates=candidates,
        project_seed=CaosHandoffProjectSeed(
            name=f"{dataset.cell_type} — {dataset.year}",
            note=note,
            intended_operations=["inspect", "compare", "measure", "annotate", "review"],
        ),
        requirements=CaosHandoffRequirements(),
        integrity=CaosHandoffIntegrity(
            dataset_fingerprint=_dataset_fingerprint(dataset, candidates),
        ),
    )
