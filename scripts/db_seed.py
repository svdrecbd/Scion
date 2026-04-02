#!/usr/bin/env python3
from __future__ import annotations

import csv
import os
import re
from itertools import combinations
from pathlib import Path

from psycopg import connect


ROOT = Path(__file__).resolve().parent.parent
MANIFESTS_DIR = ROOT / "references" / "manifests"
DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/scion"


def read_database_url() -> str:
    if os.getenv("SCION_DATABASE_URL"):
        return os.environ["SCION_DATABASE_URL"]

    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("SCION_DATABASE_URL="):
                return line.split("=", 1)[1].strip()

    return DEFAULT_DATABASE_URL


def load_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def mean_numeric(value: str) -> float | None:
    numbers = [float(number) for number in re.findall(r"\d+(?:\.\d+)?", value or "")]
    if not numbers:
        return None
    return sum(numbers) / len(numbers)


def derive_species(cell_type: str, organism_type: str) -> str:
    if "," in cell_type:
        return cell_type.split(",", 1)[0].strip()

    words = cell_type.split()
    if len(words) == 2 and words[0][:1].isupper() and words[1][:1].islower():
        return cell_type.strip()

    if len(words) == 2 and words[0].endswith("."):
        return cell_type.strip()

    return organism_type.strip() or cell_type.strip()


def normalize_modality_family(modality: str) -> str:
    lowered = modality.lower()
    if any(token in lowered for token in ["fib-sem", "sbf-sem", "sem", "electron", "cryo", "tem", "et"]):
        return "EM"
    if any(token in lowered for token in ["sxt", "x-ray", "stxm", "hxt"]):
        return "X-ray"
    if any(
        token in lowered
        for token in ["optical", "fluorescence", "phase contrast", "diffraction", "lls", "sim"]
    ):
        return "optical"
    return "other"


def split_terms(*values: str) -> list[str]:
    terms: list[str] = []
    seen: set[str] = set()

    for value in values:
        for raw in re.split(r"[;,]", value or ""):
            term = raw.strip().strip('"').strip()
            if not term:
                continue
            normalized = term.lower()
            if normalized not in seen:
                seen.add(normalized)
                terms.append(normalized)

    return terms


def build_pairs(organelles: list[str]) -> list[str]:
    return [":".join(pair) for pair in combinations(sorted(set(organelles)), 2)]


def normalize_metric_families(value: str) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()

    for raw in re.split(r"[;,]", value or ""):
        lowered = raw.strip().lower()
        if not lowered:
            continue

        if "volume fraction" in lowered:
            metric = "volume_fraction"
        elif "surface area" in lowered:
            metric = "surface_area"
        elif "contact" in lowered or "association" in lowered:
            metric = "contacts"
        elif "position" in lowered or "distance" in lowered:
            metric = "distance"
        elif "dimension" in lowered:
            metric = "dimensions"
        elif "shape" in lowered:
            metric = "shape"
        elif "density" in lowered:
            metric = "density"
        elif "count" in lowered or "#" in lowered:
            metric = "count"
        elif "volume" in lowered:
            metric = "volume"
        else:
            metric = "other"

        if metric not in seen:
            seen.add(metric)
            normalized.append(metric)

    return normalized


def normalize_comparator(value: str) -> tuple[str | None, str | None]:
    detail = (value or "").strip()
    if not detail:
        return None, None

    lowered = detail.lower()
    if "cell cycle" in lowered:
        return "cell cycle", detail
    if any(token in lowered for token in ["glucose", "metabolic", "fed", "fasted"]):
        return "metabolic condition", detail
    if any(token in lowered for token in ["development", "stage", "differentiation", "young", "mature"]):
        return "developmental stage", detail
    if any(token in lowered for token in ["methodology", "resolution", "modality"]):
        return "methodology", detail
    if any(token in lowered for token in ["species", "cell type"]):
        return "cell type", detail
    if any(token in lowered for token in ["stress", "infection", "treatment", "mutant", "mutation"]):
        return "treatment", detail
    return "other", detail


def sample_size_bucket(sample_size: int | None) -> str:
    if sample_size is None:
        return "unknown"
    if sample_size <= 1:
        return "1"
    if sample_size <= 10:
        return "2-10"
    if sample_size <= 50:
        return "11-50"
    return "51+"


def completeness_score(*, organelles: list[str], metrics: list[str], sample_size: int | None, xy: float | None, z: float | None, public_status: str) -> float:
    score = 0.0
    score += 0.2  # identity fields are always present in this seed
    score += 0.15  # biology
    score += 0.15 if xy is not None or z is not None else 0.05
    score += 0.2 if organelles else 0.0
    score += 0.1 if metrics else 0.0
    score += 0.1 if sample_size is not None else 0.0
    score += 0.1 if public_status != "none" else 0.05
    return round(min(score, 1.0), 2)


def publication_url(pmid: str, study_slug: str) -> str:
    if pmid:
        return f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
    return f"https://github.com/mmirvis/Cell-Anatomy-Scoping-Review/tree/main#{study_slug}"


def build_records() -> list[dict]:
    studies = {
        row["study_id"]: row
        for row in load_csv(MANIFESTS_DIR / "study_manifest.csv")
        if row["included_status"] == "included"
    }
    public_assets = {row["study_id"]: row for row in load_csv(MANIFESTS_DIR / "public_data_assets.csv")}
    locators = load_csv(MANIFESTS_DIR / "corpus_locator.csv")

    records: list[dict] = []
    for row in locators:
        study = studies[row["study_id"]]
        public_asset = public_assets.get(row["study_id"])

        public_status = "none"
        if public_asset:
            scope_note = (public_asset["availability_scope_note"] or "").lower()
            public_status = "complete" if "full dataset provided" in scope_note else "partial"

        organelles = split_terms(row["organelles_common"], row["organelles_specialized"])
        metrics = normalize_metric_families(study["quantifications"])
        comparator_class, comparator_detail = normalize_comparator(study["comparators_conditions"])
        xy_nm = mean_numeric(row["xy_nm"])
        z_nm = mean_numeric(row["z_nm"])
        isotropic = None
        if xy_nm is not None and z_nm is not None and max(xy_nm, z_nm) > 0:
            isotropic = abs(xy_nm - z_nm) / max(xy_nm, z_nm) <= 0.15

        sample_size = int(row["min_sample_size"]) if row["min_sample_size"] else None
        note_parts: list[str] = []
        if public_status == "complete":
            note_parts.append("Public data available.")
        elif public_status == "partial":
            note_parts.append("Some public data available.")
        short_sample_note = (row["sample_size_notes"] or "").strip()
        if short_sample_note and len(short_sample_note) <= 120:
            note_parts.append(short_sample_note)

        records.append(
            {
                "dataset_id": row["dataset_locator_id"],
                "title": f'{row["cell_type"]} whole-cell dataset ({row["imaging_modality"]})',
                "paper_title": study["title"],
                "year": int(row["year"]),
                "source": row["journal_published"] or row["study_id"],
                "source_type": "paper",
                "public_data_status": public_status,
                "species": derive_species(row["cell_type"], row["organism_type"]),
                "cell_type": row["cell_type"].strip(),
                "tissue_or_system": None,
                "comparator_class": comparator_class,
                "comparator_detail": comparator_detail,
                "modality": row["imaging_modality"],
                "modality_family": normalize_modality_family(row["imaging_modality"]),
                "lateral_resolution_nm": xy_nm,
                "axial_resolution_nm": z_nm,
                "isotropic": isotropic,
                "organelles": organelles,
                "organelle_pairs": build_pairs(organelles),
                "metric_families": metrics,
                "sample_size": sample_size,
                "sample_size_bucket": sample_size_bucket(sample_size),
                "metadata_completeness_score": completeness_score(
                    organelles=organelles,
                    metrics=metrics,
                    sample_size=sample_size,
                    xy=xy_nm,
                    z=z_nm,
                    public_status=public_status,
                ),
                "whole_cell_boundary_confirmed": "yes",
                "notes": " ".join(note_parts) or None,
                "included_status": row["included_status"],
                "source_study_id": row["study_id"],
                "source_publication_url": publication_url(study["pmid"], row["study_slug"]),
                "public_locator_urls": [
                    value.strip()
                    for value in (row["public_locator_urls"] or "").split(";")
                    if value.strip()
                ],
            }
        )

    return records


def main() -> None:
    database_url = read_database_url()
    records = build_records()

    with connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM dataset_records")
            for record in records:
                cursor.execute(
                    """
                    INSERT INTO dataset_records (
                        dataset_id,
                        title,
                        paper_title,
                        year,
                        source,
                        source_type,
                        public_data_status,
                        species,
                        cell_type,
                        tissue_or_system,
                        comparator_class,
                        comparator_detail,
                        modality,
                        modality_family,
                        lateral_resolution_nm,
                        axial_resolution_nm,
                        isotropic,
                        organelles,
                        organelle_pairs,
                        metric_families,
                        sample_size,
                        sample_size_bucket,
                        metadata_completeness_score,
                        whole_cell_boundary_confirmed,
                        notes,
                        included_status,
                        source_study_id,
                        source_publication_url,
                        public_locator_urls
                    ) VALUES (
                        %(dataset_id)s,
                        %(title)s,
                        %(paper_title)s,
                        %(year)s,
                        %(source)s,
                        %(source_type)s,
                        %(public_data_status)s,
                        %(species)s,
                        %(cell_type)s,
                        %(tissue_or_system)s,
                        %(comparator_class)s,
                        %(comparator_detail)s,
                        %(modality)s,
                        %(modality_family)s,
                        %(lateral_resolution_nm)s,
                        %(axial_resolution_nm)s,
                        %(isotropic)s,
                        %(organelles)s,
                        %(organelle_pairs)s,
                        %(metric_families)s,
                        %(sample_size)s,
                        %(sample_size_bucket)s,
                        %(metadata_completeness_score)s,
                        %(whole_cell_boundary_confirmed)s,
                        %(notes)s,
                        %(included_status)s,
                        %(source_study_id)s,
                        %(source_publication_url)s,
                        %(public_locator_urls)s
                    )
                    """,
                    record,
                )
        connection.commit()

    print(f"seeded {len(records)} dataset records")


if __name__ == "__main__":
    main()
