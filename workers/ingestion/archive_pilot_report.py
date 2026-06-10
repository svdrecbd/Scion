from __future__ import annotations

import argparse
import csv
import json
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPORT_BUILDER_VERSION = "archive-pilot-report-v0.1"
REPORT_SCHEMA = "cell-anatomy-archive-pilot-report"
SCHEMA_VERSION = 1

PILOT_KINDS = {"published", "triaged", "candidate", "custom"}


@dataclass
class PilotSelection:
    pilot_id: str
    title: str
    kind: str
    asset_ids: list[str] = field(default_factory=list)
    path_prefixes: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)
    all_assets: bool = False
    volume_candidates_only: bool = False
    limit: int | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_slug(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    return "-".join(part for part in slug.split("-") if part) or "pilot"


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Required pilot report input is missing: {path}")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return value


def iter_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open() as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"Expected JSON object at {path}:{line_number}")
            records.append(value)
    return records


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def int_value(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def bool_value(value: Any) -> bool:
    return bool(value)


def list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def dict_value(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def format_bytes(value: int) -> str:
    if value < 1024:
        return f"{value} B"
    if value < 1024**2:
        return f"{value / 1024:.1f} KiB"
    if value < 1024**3:
        return f"{value / 1024**2:.1f} MiB"
    if value < 1024**4:
        return f"{value / 1024**3:.2f} GiB"
    return f"{value / 1024**4:.2f} TiB"


def dimensions_text(asset: dict[str, Any]) -> str:
    dimensions = dict_value(dict_value(asset.get("metadata")).get("dimensions"))
    x = dimensions.get("x")
    y = dimensions.get("y")
    z = dimensions.get("z")
    if x and y and z:
        return f"{z} x {y} x {x}"
    if x and y:
        return f"{y} x {x}"
    return ""


def asset_search_text(asset: dict[str, Any], search_entry: dict[str, Any] | None) -> str:
    metadata = dict_value(asset.get("metadata"))
    status = dict_value(asset.get("status"))
    tokens = [
        asset.get("asset_id"),
        asset.get("archive_id"),
        asset.get("relative_path"),
        asset.get("name"),
        asset.get("extension"),
        asset.get("likely_role"),
        metadata.get("format"),
        metadata.get("dtype"),
        status.get("publication_status"),
        status.get("triage_status"),
        status.get("rights_status"),
        search_entry.get("search_text") if search_entry else "",
    ]
    return " ".join(str(token) for token in tokens if token).lower()


def search_entries_by_asset(registry_dir: Path) -> dict[str, dict[str, Any]]:
    entries = iter_jsonl(registry_dir / "private-registry-search-index.jsonl")
    mapped: dict[str, dict[str, Any]] = {}
    for entry in entries:
        asset_id = entry.get("asset_id")
        if isinstance(asset_id, str) and asset_id:
            mapped[asset_id] = entry
    return mapped


def matches_selection(
    asset: dict[str, Any],
    selection: PilotSelection,
    search_entry: dict[str, Any] | None,
) -> bool:
    has_explicit_selector = bool(selection.asset_ids or selection.path_prefixes or selection.queries)
    if selection.all_assets or (selection.volume_candidates_only and not has_explicit_selector):
        selected = True
    else:
        selected = False
        asset_id = str(asset.get("asset_id") or "")
        relative_path = str(asset.get("relative_path") or "")
        if asset_id and asset_id in set(selection.asset_ids):
            selected = True
        if selection.path_prefixes and any(relative_path.startswith(prefix) for prefix in selection.path_prefixes):
            selected = True
        if selection.queries:
            text = asset_search_text(asset, search_entry)
            selected = selected or all(query.lower() in text for query in selection.queries)

    if not selected:
        return False
    if selection.volume_candidates_only and not bool_value(dict_value(asset.get("readiness")).get("is_volume_candidate")):
        return False
    return True


def select_assets(
    assets: list[dict[str, Any]],
    search_by_asset: dict[str, dict[str, Any]],
    selection: PilotSelection,
) -> list[dict[str, Any]]:
    if not (
        selection.all_assets
        or selection.asset_ids
        or selection.path_prefixes
        or selection.queries
        or selection.volume_candidates_only
    ):
        raise ValueError("Provide at least one selector (--asset-id, --path-prefix, --query) or use --all.")

    selected = [
        asset
        for asset in assets
        if matches_selection(asset, selection, search_by_asset.get(str(asset.get("asset_id") or "")))
    ]
    selected.sort(
        key=lambda asset: (
            not bool_value(dict_value(asset.get("readiness")).get("is_volume_candidate")),
            str(asset.get("relative_path") or ""),
        )
    )
    if selection.limit is not None:
        return selected[: selection.limit]
    return selected


def counter_dict(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items()))


def asset_row(asset: dict[str, Any]) -> dict[str, Any]:
    metadata = dict_value(asset.get("metadata"))
    status = dict_value(asset.get("status"))
    checksum = dict_value(asset.get("checksum"))
    readiness = dict_value(asset.get("readiness"))
    review = dict_value(asset.get("review"))
    operations = dict_value(status.get("allowed_operations"))
    return {
        "asset_id": asset.get("asset_id") or "",
        "archive_id": asset.get("archive_id") or "",
        "relative_path": asset.get("relative_path") or "",
        "path_type": asset.get("path_type") or "",
        "likely_role": asset.get("likely_role") or "",
        "format": metadata.get("format") or "",
        "metadata_status": metadata.get("status") or "",
        "dimensions": dimensions_text(asset),
        "dtype": metadata.get("dtype") or "",
        "size_bytes": int_value(asset.get("size_bytes")),
        "size_human": format_bytes(int_value(asset.get("size_bytes"))),
        "checksum_algorithm": checksum.get("algorithm") or "",
        "checksum_digest": checksum.get("digest") or "",
        "duplicate_of": checksum.get("duplicate_of") or "",
        "publication_status": status.get("publication_status") or "",
        "triage_status": status.get("triage_status") or "",
        "rights_status": status.get("rights_status") or "",
        "can_view_in_caos": bool_value(operations.get("can_view_in_caos")),
        "can_convert": bool_value(operations.get("can_convert")),
        "metadata_ready": bool_value(readiness.get("metadata_ready")),
        "conversion_ready": bool_value(readiness.get("conversion_ready")),
        "project_ready": bool_value(readiness.get("project_ready")),
        "blockers": ";".join(str(item) for item in list_value(readiness.get("blockers"))),
        "metadata_gap_codes": ";".join(str(item) for item in list_value(review.get("gap_codes"))),
        "recommended_actions": " ".join(str(item) for item in list_value(review.get("recommended_actions"))),
    }


def selected_asset_summary(assets: list[dict[str, Any]]) -> dict[str, Any]:
    bytes_total = sum(int_value(asset.get("size_bytes")) for asset in assets)
    role_counts: Counter[str] = Counter()
    format_counts: Counter[str] = Counter()
    extension_counts: Counter[str] = Counter()
    rights_counts: Counter[str] = Counter()
    publication_counts: Counter[str] = Counter()
    triage_counts: Counter[str] = Counter()
    blocker_counts: Counter[str] = Counter()
    gap_counts: Counter[str] = Counter()
    action_counts: Counter[str] = Counter()

    checksum_count = 0
    duplicate_count = 0
    volume_count = 0
    metadata_ready_count = 0
    conversion_ready_count = 0
    project_ready_count = 0
    review_required_count = 0

    for asset in assets:
        metadata = dict_value(asset.get("metadata"))
        status = dict_value(asset.get("status"))
        checksum = dict_value(asset.get("checksum"))
        readiness = dict_value(asset.get("readiness"))
        review = dict_value(asset.get("review"))
        role_counts.update([str(asset.get("likely_role") or "unknown")])
        format_counts.update([str(metadata.get("format") or "[none]")])
        extension_counts.update([str(asset.get("extension") or "[none]")])
        rights_counts.update([str(status.get("rights_status") or "unknown")])
        publication_counts.update([str(status.get("publication_status") or "unknown")])
        triage_counts.update([str(status.get("triage_status") or "unknown")])
        blocker_counts.update(str(item) for item in list_value(readiness.get("blockers")) if item)
        gap_counts.update(str(item) for item in list_value(review.get("gap_codes")) if item)
        action_counts.update(str(item) for item in list_value(review.get("recommended_actions")) if item)
        if checksum.get("digest"):
            checksum_count += 1
        if checksum.get("duplicate_of"):
            duplicate_count += 1
        if readiness.get("is_volume_candidate"):
            volume_count += 1
        if readiness.get("metadata_ready"):
            metadata_ready_count += 1
        if readiness.get("conversion_ready"):
            conversion_ready_count += 1
        if readiness.get("project_ready"):
            project_ready_count += 1
        if status.get("review_required"):
            review_required_count += 1

    return {
        "selected_asset_count": len(assets),
        "selected_bytes_total": bytes_total,
        "selected_bytes_human": format_bytes(bytes_total),
        "volume_candidate_count": volume_count,
        "checksum_record_count": checksum_count,
        "duplicate_asset_count": duplicate_count,
        "metadata_ready_count": metadata_ready_count,
        "conversion_ready_count": conversion_ready_count,
        "project_ready_count": project_ready_count,
        "review_required_count": review_required_count,
        "role_counts": counter_dict(role_counts),
        "format_counts": counter_dict(format_counts),
        "extension_counts": counter_dict(extension_counts),
        "rights_status_counts": counter_dict(rights_counts),
        "publication_status_counts": counter_dict(publication_counts),
        "triage_status_counts": counter_dict(triage_counts),
        "blocker_counts": counter_dict(blocker_counts),
        "metadata_gap_counts": counter_dict(gap_counts),
        "top_recommended_actions": [
            {"action": action, "count": count}
            for action, count in action_counts.most_common(12)
        ],
    }


def report_findings(summary: dict[str, Any]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    count = int_value(summary.get("selected_asset_count"))
    if count == 0:
        return [
            {
                "severity": "blocker",
                "code": "empty_selection",
                "summary": "The pilot selector did not match any registry assets.",
            }
        ]

    if summary["rights_status_counts"].get("unknown", 0) > 0:
        findings.append(
            {
                "severity": "blocker",
                "code": "rights_unknown",
                "summary": f"{summary['rights_status_counts']['unknown']} selected assets still have unknown rights status.",
            }
        )
    if summary["checksum_record_count"] < count:
        findings.append(
            {
                "severity": "review",
                "code": "missing_fixity",
                "summary": f"{count - summary['checksum_record_count']} selected assets do not have direct checksum records.",
            }
        )
    if summary["metadata_gap_counts"]:
        gap_total = sum(summary["metadata_gap_counts"].values())
        findings.append(
            {
                "severity": "review",
                "code": "metadata_gaps",
                "summary": f"{gap_total} metadata gaps remain across the selected pilot subset.",
            }
        )
    if summary["project_ready_count"] == 0:
        findings.append(
            {
                "severity": "blocker",
                "code": "no_project_ready_assets",
                "summary": "No selected assets are currently project-ready for CAOS work.",
            }
        )
    if summary["duplicate_asset_count"] > 0:
        findings.append(
            {
                "severity": "review",
                "code": "duplicate_checksums",
                "summary": f"{summary['duplicate_asset_count']} selected assets duplicate another checksum.",
            }
        )
    return findings


def report_next_steps(report: dict[str, Any]) -> list[str]:
    summary = report["summary"]
    steps = [
        "Confirm data owner, allowed operations, publication/triage status, and reviewer for this pilot subset.",
    ]
    if summary["checksum_record_count"] < summary["selected_asset_count"]:
        steps.append("Run or resume SHA-256 fixity for selected assets that lack direct checksum records.")
    if summary["metadata_gap_counts"]:
        steps.append("Resolve metadata gaps before conversion or measurement, starting with blocker-severity gaps.")
    if summary["project_ready_count"] == 0:
        steps.append("Curate rights/status and select at least one asset that can be converted and viewed in CAOS.")
    else:
        steps.append("Open the project-ready assets in Workbench and create a local CAOS project package.")
    if report["selection"]["kind"] == "published":
        steps.append("Map selected assets to DOI, figure, supplement, and methods text for publication reconstruction.")
    elif report["selection"]["kind"] == "triaged":
        steps.append("Capture the triage reason so the archive records why these assets should not be promoted.")
    elif report["selection"]["kind"] == "candidate":
        steps.append("Write one candidate scientific question and the minimum measurement/ROI/job evidence needed.")
    return steps


def build_report(
    registry_dir: Path,
    output_dir: Path,
    selection: PilotSelection,
) -> dict[str, Any]:
    registry_dir = registry_dir.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    registry_summary = read_json(registry_dir / "private-registry.json")
    assets = iter_jsonl(registry_dir / "private-registry-assets.jsonl")
    search_by_asset = search_entries_by_asset(registry_dir)
    selected_assets = select_assets(assets, search_by_asset, selection)
    rows = [asset_row(asset) for asset in selected_assets]
    summary = selected_asset_summary(selected_assets)

    report = {
        "schema": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "report_builder": REPORT_BUILDER_VERSION,
        "generated_at": utc_now(),
        "selection": {
            "pilot_id": selection.pilot_id,
            "title": selection.title,
            "kind": selection.kind,
            "asset_ids": selection.asset_ids,
            "path_prefixes": selection.path_prefixes,
            "queries": selection.queries,
            "all_assets": selection.all_assets,
            "volume_candidates_only": selection.volume_candidates_only,
            "limit": selection.limit,
        },
        "source_registry": {
            "registry_dir": str(registry_dir),
            "registry_id": registry_summary.get("registry_id"),
            "archive_id": dict_value(registry_summary.get("source_scan")).get("archive_id"),
            "archive_root": dict_value(registry_summary.get("source_scan")).get("root"),
            "asset_count": registry_summary.get("asset_count"),
            "volume_candidate_count": registry_summary.get("volume_candidate_count"),
            "review_queue_count": registry_summary.get("review_queue_count"),
        },
        "summary": summary,
        "findings": report_findings(summary),
        "assets": rows,
        "artifacts": {
            "json": "pilot-report.json",
            "markdown": "pilot-report.md",
            "assets_csv": "pilot-assets.csv",
            "review_queue_csv": "pilot-review-queue.csv",
        },
        "output_dir": str(output_dir),
    }
    report["next_steps"] = report_next_steps(report)

    write_json(output_dir / "pilot-report.json", report)
    write_assets_csv(output_dir / "pilot-assets.csv", rows)
    write_assets_csv(
        output_dir / "pilot-review-queue.csv",
        [
            row
            for row in rows
            if row["blockers"] or row["metadata_gap_codes"] or row["rights_status"] == "unknown"
        ],
    )
    (output_dir / "pilot-report.md").write_text(render_markdown_report(report))
    return report


def write_assets_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = [
        "asset_id",
        "archive_id",
        "relative_path",
        "path_type",
        "likely_role",
        "format",
        "metadata_status",
        "dimensions",
        "dtype",
        "size_bytes",
        "size_human",
        "checksum_algorithm",
        "checksum_digest",
        "duplicate_of",
        "publication_status",
        "triage_status",
        "rights_status",
        "can_view_in_caos",
        "can_convert",
        "metadata_ready",
        "conversion_ready",
        "project_ready",
        "blockers",
        "metadata_gap_codes",
        "recommended_actions",
    ]
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def markdown_counter(counter: dict[str, int]) -> str:
    if not counter:
        return "- none\n"
    return "".join(f"- `{key}`: {value}\n" for key, value in sorted(counter.items()))


def render_markdown_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    selection = report["selection"]
    source = report["source_registry"]
    lines = [
        f"# {selection['title']}",
        "",
        f"- Pilot id: `{selection['pilot_id']}`",
        f"- Pilot kind: `{selection['kind']}`",
        f"- Registry: `{source.get('registry_id')}`",
        f"- Archive: `{source.get('archive_id')}`",
        f"- Generated: `{report['generated_at']}`",
        "",
        "## Scope",
        "",
        f"- Selected assets: {summary['selected_asset_count']}",
        f"- Selected bytes: {summary['selected_bytes_human']}",
        f"- Volume candidates: {summary['volume_candidate_count']}",
        f"- Checksum records: {summary['checksum_record_count']}",
        f"- Metadata-ready assets: {summary['metadata_ready_count']}",
        f"- Conversion-ready assets: {summary['conversion_ready_count']}",
        f"- Project-ready assets: {summary['project_ready_count']}",
        f"- Review-required assets: {summary['review_required_count']}",
        "",
        "## Findings",
        "",
    ]

    if report["findings"]:
        lines.extend(f"- **{finding['severity']} / {finding['code']}**: {finding['summary']}" for finding in report["findings"])
    else:
        lines.append("- No blocking findings were generated by this report.")

    lines.extend(
        [
            "",
            "## Metadata Gaps",
            "",
            markdown_counter(summary["metadata_gap_counts"]).rstrip(),
            "",
            "## Blockers",
            "",
            markdown_counter(summary["blocker_counts"]).rstrip(),
            "",
            "## Formats",
            "",
            markdown_counter(summary["format_counts"]).rstrip(),
            "",
            "## Next Steps",
            "",
        ]
    )
    lines.extend(f"- {step}" for step in report["next_steps"])
    lines.extend(["", "## Selected Assets", ""])
    for asset in report["assets"][:25]:
        detail = asset["dimensions"] or "dimensions unknown"
        lines.append(
            f"- `{asset['relative_path']}`: {asset['format'] or 'unknown'}, {detail}, "
            f"{asset['size_human']}, blockers `{asset['blockers'] or 'none'}`"
        )
    if len(report["assets"]) > 25:
        lines.append(f"- ... {len(report['assets']) - 25} more assets in `pilot-assets.csv`")
    lines.append("")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate local pilot reports from private archive registry outputs.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    report = subparsers.add_parser("report", help="Generate a pilot report for a selected registry subset.")
    report.add_argument("registry_dir", type=Path, help="Directory containing private-registry.json and assets JSONL.")
    report.add_argument("--output-dir", type=Path, required=True, help="Directory where pilot report artifacts are written.")
    report.add_argument("--pilot-id", required=True, help="Stable pilot id, for example pilot-a-published.")
    report.add_argument("--title", help="Human-readable report title. Defaults to the pilot id.")
    report.add_argument("--kind", choices=sorted(PILOT_KINDS), default="custom", help="Pilot kind.")
    report.add_argument("--asset-id", action="append", default=[], help="Select a registry asset id. Can be repeated.")
    report.add_argument("--path-prefix", action="append", default=[], help="Select assets with this relative-path prefix. Can be repeated.")
    report.add_argument("--query", action="append", default=[], help="Case-insensitive search term. Repeated terms must all match.")
    report.add_argument("--all", action="store_true", help="Select all registry assets.")
    report.add_argument("--volume-candidates-only", action="store_true", help="Restrict selection to volume candidates.")
    report.add_argument("--limit", type=int, help="Maximum number of selected assets to include.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.monotonic()

    if args.command == "report":
        selection = PilotSelection(
            pilot_id=safe_slug(args.pilot_id),
            title=args.title or args.pilot_id,
            kind=args.kind,
            asset_ids=args.asset_id,
            path_prefixes=args.path_prefix,
            queries=args.query,
            all_assets=args.all,
            volume_candidates_only=args.volume_candidates_only,
            limit=max(1, args.limit) if args.limit is not None else None,
        )
        report = build_report(args.registry_dir, args.output_dir, selection)
        elapsed = time.monotonic() - started
        print(
            json.dumps(
                {
                    "status": "ok",
                    "pilot_id": report["selection"]["pilot_id"],
                    "selected_asset_count": report["summary"]["selected_asset_count"],
                    "volume_candidate_count": report["summary"]["volume_candidate_count"],
                    "project_ready_count": report["summary"]["project_ready_count"],
                    "review_required_count": report["summary"]["review_required_count"],
                    "output_dir": report["output_dir"],
                    "elapsed_seconds": round(elapsed, 3),
                },
                sort_keys=True,
            )
        )
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
