# Archive Beachhead Runbook

This runbook is the operator boundary for the first LBNL archive inventory. It is intentionally conservative: the source is treated as immutable, scanner state lives outside the source tree, and a completed summary is not accepted until the final checkpoint reports `completed`.

## 1. Authority Gate

Do not mount, copy, upload, convert, or scan until the operator has:

- a named data owner and technical contact
- written approval for a read-only inventory
- an agreed archive id that will remain stable across reruns
- a record of whether checksums, local derivatives, and cloud backup are allowed
- a destination for manifests and scan state that is outside the archive root

Record those decisions in `authority-record.json` and `AUTHORITY.md` beside, not inside, the archive.

## 2. Mount And Output Layout

Prefer a read-only source mount when the storage system supports it. Put scanner output on a separate local SSD when possible so checksum reads do not contend with SQLite and manifest writes.

Suggested layout:

```text
/Volumes/lbnl-archive/                 # source; read-only if possible
/Volumes/caos-state/lbnl-beachhead/   # manifests, progress, SQLite state
```

The scanner rejects an output directory inside the source root. It also takes an exclusive `scan.lock`, so two operators cannot write the same output directory concurrently.

Budget output capacity from file count, not source bytes. Until the first inventory provides a real count, reserve at least 2–5 KiB per anticipated file plus operational headroom. Ten million files can therefore require tens of gigabytes of manifests and indexes even though no image bytes are copied.

## 3. Preflight

Run preflight before every new or resumed job:

```bash
python3 workers/ingestion/archive_scanner.py scan /Volumes/lbnl-archive \
  --output-dir /Volumes/caos-state/lbnl-beachhead \
  --archive-id lbnl-beachhead \
  --preflight-only
```

For a fixity run, include the exact resume flags that will be used:

```bash
python3 workers/ingestion/archive_scanner.py scan /Volumes/lbnl-archive \
  --output-dir /Volumes/caos-state/lbnl-beachhead \
  --archive-id lbnl-beachhead \
  --checksum sha256 \
  --resume-checksums \
  --preflight-only
```

Do not proceed unless `status` is `ready`. Resolve every blocker. Warnings require an explicit operator judgment in the run log.

## 4. Fast Inventory First

Run the metadata inventory without checksums first. This exposes file count, formats, unreadable paths, and likely volume candidates before committing to days of source reads.

```bash
python3 workers/ingestion/archive_scanner.py scan /Volumes/lbnl-archive \
  --output-dir /Volumes/caos-state/lbnl-beachhead \
  --archive-id lbnl-beachhead \
  --progress-interval-files 1000 \
  --progress-interval-seconds 30
```

Monitor from another shell:

```bash
python3 -m json.tool /Volumes/caos-state/lbnl-beachhead/scan-checkpoint.json
tail -n 20 /Volumes/caos-state/lbnl-beachhead/scan-progress.jsonl
```

`scan-progress.jsonl` is append-only across attempts. Use `run_id` to distinguish attempts. Primary result artifacts are written as `.inprogress` files and replace the last complete artifacts only after a successful traversal.

Stop and investigate if:

- unreadable paths rise unexpectedly
- the source mount disconnects or changes identity
- throughput collapses for a sustained period
- the output filesystem approaches its capacity limit
- the archive is observed changing during the run

## 5. Validate Inventory

An inventory is accepted only when:

- `scan-checkpoint.json.phase` is `completed`
- `inventory-summary.json.file_count` matches the final checkpoint
- no `.inprogress` artifacts remain
- `scan-errors.csv` has been reviewed
- extension, largest-file, metadata-gap, and volume-candidate summaries are plausible
- the source root and archive id in the summary are the approved values

The persistent `scan-state.sqlite` is operational state and must remain with the manifests. It stores checksum reuse identity on disk rather than in process memory.

## 6. Staged Fixity

Run SHA-256 only after the fast inventory is accepted. The job may be stopped and rerun with the same source root, archive id, and output directory:

```bash
python3 workers/ingestion/archive_scanner.py scan /Volumes/lbnl-archive \
  --output-dir /Volumes/caos-state/lbnl-beachhead \
  --archive-id lbnl-beachhead \
  --checksum sha256 \
  --resume-checksums \
  --progress-interval-files 1000 \
  --progress-interval-seconds 30
```

Resume reuse requires matching path, algorithm, byte size, modified time, device, and inode. A changed archive id or source root is rejected. The traversal begins at the root on each attempt so additions and removals are reconciled, but unchanged file bytes are not rehashed.

## 7. Registry And Worksets

After a completed scan:

```bash
python3 workers/ingestion/archive_registry.py import-scan \
  /Volumes/caos-state/lbnl-beachhead \
  --output-dir /Volumes/caos-state/lbnl-registry \
  --registry-id lbnl-beachhead-registry
```

Registry import uses a disposable SQLite join index and streams final JSONL/CSV artifacts. Review rights and scientific status through an overlay before promoting bounded worksets. Never promote the whole archive as one workset.

The promoter enforces a 10,000-asset safety cap. That is an emergency ceiling, not a recommended pilot size; the first three worksets should normally contain tens of assets or fewer.

## 8. Copy Verification And Restore

CAOS currently verifies completed source and target scanner outputs; it does not perform the copy. Use institutionally approved copy tooling, scan both sides, and then run:

```bash
python3 workers/ingestion/archive_scanner.py compare-scans \
  /Volumes/caos-state/lbnl-beachhead-source \
  /Volumes/caos-state/lbnl-beachhead-target \
  --output-dir /Volumes/caos-state/lbnl-copy-verification \
  --require-checksums
```

The comparison spills manifests to SQLite instead of loading both estates into RAM. A backup is not accepted until the report passes and a selected restore has been read, rescanned, and checksum-verified.

## Known Boundaries

- A restarted scan re-enumerates the directory tree; checksum bytes are reusable, but the filesystem traversal cursor is not resumed in the middle of a directory.
- Copy orchestration, provider-native checksum verification, retention configuration, and restore automation remain external.
- HDF5 metadata is signature-only, BigTIFF is unsupported, and proprietary microscope formats need real-archive fixtures.
- The generic private-workset conversion factory is not yet implemented; existing automated conversion is the bounded public TIFF pilot pipeline.
