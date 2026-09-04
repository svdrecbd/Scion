# CAOS Workbench

CAOS is the Cell Anatomy Operating System: a local-first workbench for inspecting, validating, comparing, and packaging whole-cell volumetric imaging data. The public Atlas remains the discovery and account surface. The desktop Workbench remains the place where large local volumes, derived views, annotations, and project state are operated on without pretending that account sync exists before the account email-code path is production-ready.

## Product Constraints

- Ship account-ready, not account-free. Project state must carry durable account-compatible identifiers and schema versions, but the Workbench must not offer a handoff flow until email-code delivery and device pairing are dependable.
- Preserve data parity. Every project reference must point back to a concrete dataset slug, asset path, volume shape, dtype, validation status, and fingerprint input.
- Keep bloat low. Prefer explicit local state, URL state, and JSON project files over broad client-side frameworks or hidden stores.
- Make expert workflows natural. CAOS can expose dense controls and state matrices because the target user is technical and the software is expected to become critical niche infrastructure.
- Avoid cheap tricks. If a feature cannot maintain integrity across local, Atlas, and future account state, keep it visible as dormant or excluded rather than simulating it.

## Scale Modes

The Workbench should support two connected operating modes.

**Dataset / Repo Mode** is the inner loop for bounded, coherent worksets: a public-data repo, a known experiment folder, a validated OME-Zarr set, or another package small enough to inspect and derive directly. This mode supports conversion, slice caching, measurement, annotation, figure export, and publication bundles.

**Archive Estate Mode** is the outer loop for massive mixed lab archives, including the revised 90 TB LBNL beachhead. In this mode, the Workbench and companion ingestion tools should inventory, checksum, index, triage, verify copies, and promote selected assets into bounded worksets. The whole archive should never be treated as an interactive volume collection.

The bridge between modes is promotion: a selected archive asset or group of assets receives registry provenance, status, fixity, and intended-use metadata before it enters Dataset / Repo Mode. The ingestion layer emits bounded `workset.json` packages for this bridge, and the native Workbench can open those worksets into the existing registry/review/conversion panels instead of treating a full archive estate as a project.

## Current Account Boundary

The backend already contains account, session, device pairing, and saved-state groundwork. CAOS should treat that as dormant infrastructure until the email-code system is settled. The desktop UI can be account-aware, but the only acceptable shipping behavior right now is local project export/import plus clear account readiness metadata.

## Atlas Handoff

The public Atlas and local Workbench now share a versioned `cell-anatomy-caos-handoff` contract. A dataset detail page downloads a metadata-only JSON handoff containing the complete Atlas record, public repository locators, intended operations, an initial project name/note, explicit data requirements, and a deterministic SHA-256 fingerprint over stable dataset identity and provenance fields.

Workbench import verifies the schema and fingerprint before applying context. A matching loaded dataset can be resolved by exact dataset id, study id, or repository accession. When no derivative is available, the handoff remains durable pending context rather than pretending that the volume was transferred. It can be paired with local data later and is included in Workbench bundle exports. Handoffs never contain raw image bytes, authorize automatic download, or bypass local compatibility and provenance checks.

The packaged Tauri application also creates a fresh in-memory token for each volume-engine launch. The sidecar requires that token on loopback requests, while standalone browser development remains available when no token is configured. This closes the previous unauthenticated cross-origin loopback boundary without turning local data into an account-backed service.

## Project File Contract

CAOS project files use the `cell-anatomy-caos-project` schema with a numeric schema version. A project snapshot contains:

- project metadata: id, name, created timestamp, updated timestamp
- active view: dataset slug, asset path, slices, contrast, colormap, render mode, and 3D camera values
- volume references: source identifiers, source paths, output paths, source hash if available, source size, format, dtype, shape, chunking, voxel scale, validation status, byte size, and optional private archive status
- typed Workbench state: measurements, ROIs, completed local jobs, and JSON export metadata
- integrity block: active volume fingerprint, full volume fingerprint list, volume count, generator identity, and generated timestamp

The initial schema intentionally supports single-active-volume projects. Multi-volume comparisons and account-backed projects should extend the schema without changing the meaning of existing fields.

Validation is strict at import and export boundaries:

- the active dataset/asset must be present in the project volume manifest
- the active view slices must be inside the referenced volume shape
- measurements and ROIs must reference a manifest volume and keep all points inside its bounds
- completed local jobs must reference a manifest volume and keep JSON-serializable result payloads
- the active volume fingerprint must match the manifest fields: dataset slug, asset path, source SHA or `no-sha256`, source size, shape, chunks, dtype, and format
- private archive status is preserved but excluded from the source-data fingerprint, because rights and triage can change without changing the pixels
- malformed JSON, unsupported schema versions, duplicate volume references, bad timestamps, and invalid extension payloads are rejected before Workbench state is mutated

## Local Registry

The desktop Workbench can open a local registry generated by `workers/ingestion/archive_registry.py import-scan` or `archive_registry.py import-public-data`. Use `File > Open Private Registry...` or the Registry button in the Jobs tab and select `private-registry.json`.

The desktop Workbench can also open a bounded workset generated by `archive_registry.py promote-workset`. Use `File > Open Workset...` or the Workset button in the Jobs tab and select `workset.json`. The Workbench reads sibling `workset-assets.jsonl`, normalizes promoted assets into the existing registry asset model, shows only the selected workset scope, and registers the workset with the local volume engine. That registration persists in the local Workbench state directory, so a sidecar restart does not orphan an interrupted batch run.

The Workbench reads sibling artifacts from the same directory:

- `private-registry-assets.jsonl`
- `private-registry-search-index.jsonl`
- `private-registry-review-queue.csv`
- `private-registry-volume-candidates.csv`

The current UI displays registry/workset counts, project-ready volumes, conversion-queue source assets, and review pressure. In the native desktop build, full registry browsing uses a persisted SQLite/FTS cache beside `private-registry.json` and returns only visible result pages to React. The cache is rebuilt automatically when `private-registry-assets.jsonl` changes. Workset browsing is intentionally in-memory because worksets are already bounded selected subsets. Registry and workset rows can be searched by path, format, dtype, status, and metadata gap text; conversion rows can be filtered to all, metadata-ready, review-required, or sidecar-matched assets. Public-data OME-Zarr derivatives imported through `import-public-data` can be represented as `project_ready` when validation passed, metadata is complete, and a composite store checksum exists. Promoted private TIFF and supported integer-MRC assets that pass permission, fixity, and metadata gates can now run through `private_workset_derivative.py`; it emits an immutable, validated OME-Zarr derivative with source/output checksums and resumable chunk provenance. Completed private derivatives are added to `workbench-data` and use the existing slice and 3D endpoints. Project-ready registry rows can focus a matching loaded Workbench derivative when the volume engine already has that derivative in `workbench-data`, or create and save a clean CAOS project around that volume without manually reconstructing the view. Project creation requires one unambiguous provenance, checksum, or path match and preserves registry asset plus optional workset identifiers in the project volume manifest; unloaded and ambiguous matches are blocked. Raw source assets remain conversion candidates until they have a Workbench-loadable derivative. When a conversion-queue row matches the sidecar index queue by dataset slug and relative asset path, the Workbench can start the existing local conversion job from the registry row or select multiple matched rows into a bounded persisted batch run. The Jobs tab can also request a dry-run batch conversion plan with total and per-dataset caps, skip active/completed jobs, optionally include failed/cancelled jobs for retry, export the plan checkpoint JSON, and start a persisted batch run with configurable concurrency. Batch runs are checkpointed under the local Workbench state directory and can be cancelled or resumed after interruption. Workbench bundle export includes the registry summary, active workset metadata when present, bounded review context, latest batch-plan checkpoint, and recent batch-run status so pilot reports can cite the exact local registry/workset state used during work.

The Jobs tab starts either a point-guided 3D region candidate or the older global-threshold plumbing baseline for the active intensity volume. A point ROI provides the seed; CAOS grows only the 6-connected component within a recorded intensity tolerance, physical radius, and foreground safety cap. This is a practical annotation accelerator, not a claim of model reliability. Outputs are immutable OME-Zarr label volumes with exact source/output checksums, resumable chunks, seed/growth provenance, foreground/bounding-box QC, and an explicit human-review/non-clinical status. A validated candidate appears in the asset selector as a label volume and uses binary contrast automatically. External tooth or cell models join the same path through `segmentation_pipeline.py register`, which requires binary uint8 labels, exact source shape/chunk alignment, and a model id plus version. Reliability gates still require corrected ground truth, annotated train/validation/test cohorts, leakage controls, per-structure metrics, calibration/failure analysis, and signed review decisions before any model can be promoted beyond `unreviewed_candidate`.

The viewer has five navigable presentation states: `XY`, `XZ`, `YZ`, linked `ALL`, and a dedicated `3D` reconstruction. `Command+Left Arrow` and `Command+Right Arrow` cycle through those states. Direct buttons and keyboard transitions preserve the active axis and all three linked coordinates. When a segmentation label is active, its 2D planes display the aligned source microscopy rather than the binary mask and expose the same microscopy window used by the 3D renderer. Entering 3D transfers the exact active section and window, enables the section, leaves clipping as an explicit optional cutaway, and does not recenter the operator's position. Intensity volumes use the existing translucent density scout in 3D. Segmentation-label volumes expose explicit `Focus`, `Nearby`, and `Whole` reconstruction scopes: the candidate crop, an expanded fixed neighborhood, or the complete source extent. The UI reports the estimated percentage of source space represented, and the selected scope is retained in saved sessions and CAOS project view state. Scope-aware max-preserving reduction keeps the 3D context under the responsive component-grid budget. The active linked section is fetched independently through the native-resolution slice endpoint, so a coarse whole-specimen reconstruction does not degrade the scientific plane. Their default 3D presentation remains microscopy-first: WebGL front-to-back composites the source structure, suppresses empty bright section background, and uses segmentation only as a boundary annotation. Wheel/pinch, explicit buttons, and `Command++` / `Command+-` provide bounded 3D zoom; `Command+0` resets it. Three linked sliders move the `XY`, `XZ`, and `YZ` coordinates without changing the reconstruction crop or framing; `Shift+wheel` traverses the active plane. Optional clipping retains a fixed lower or upper dataset side rather than flipping when the camera crosses the plane. The engine can also return ranked 6-connected component IDs for a streamed label crop; the Workbench can isolate one component or show all of them. Component isolation is exact for disconnected regions in that label at the selected stream detail, not a claim that raw microscopy has been anatomically segmented. Levels above 64 Mi voxels are disabled, and the Rust endpoint independently rejects them before allocation. The former filled-label surface remains available as `Label QC`, a geometry diagnostic rather than the primary scientific view. Crop-edge fading suppresses false walls created by gradients at the streamed crop boundary. During rotation or zoom the renderer coalesces input, temporarily reduces pixel density and ray steps, and restores full-quality rendering when the gesture ends. These 3D presentations visualize the selected source and label derivatives; they do not create a new segmentation or imply clinical validation.

Two-dimensional scrubbing is a transient render operation, not a project-state transaction. Range inputs publish at most one preview per animation frame directly to the viewers; React/URL project state is committed only when interaction ends. Each affected plane uses a latest-frame request pump with one active request and one replaceable pending target, so sustained 60–120 Hz input cannot starve rendering by continually resetting a debounce or aborting useful work. Unaffected orthogonal planes update only their linked crosshairs. Viewers preserve the last completed frame, reuse allocated 2D textures with sub-image uploads, disable retained framebuffers, suppress histogram and annotation work during the gesture, and perform delayed directional prefetch only after interaction settles. The volume engine executes slice extraction on blocking workers and caches raw Zarr chunks behind a bounded shared LRU with per-path in-flight locks. Its default 1 GiB budget is configurable with `CELL_ANATOMY_CHUNK_CACHE_BYTES`; response headers expose slice time plus cumulative cache bytes, hits, and misses for local profiling.

This is the second scale boundary over local registry artifacts. It avoids loading every registry row into React and avoids repeated JSONL scans during interaction. The JSONL remains the portable source artifact; SQLite/FTS is a disposable local query cache with the same paged query contract while raw files stay external and immutable.

## Native Project Lifecycle

In the macOS Workbench, CAOS project files are first-class local files rather than browser downloads:

- `File > Open CAOS Project...` reads a project file from disk and validates it before applying state
- `File > Save CAOS Project` writes back to the current project path
- `File > Save CAOS Project As...` writes a new project file and updates the current path
- a project-ready registry/workset row can initialize a clean project and open the native save boundary in one action
- dirty-state tracking compares stable project state and ignores generated timestamps
- recent project paths are kept locally and can be reopened from the Workbench notes panel
- if a valid project references a volume that is not loaded, the project metadata and annotations are retained while the active view restore is deferred

## Workbench Layout

The current Workbench is the product surface. Layout options should transform that same UI instead of creating alternate clients or partial feature clones. Mirror mode is allowed as a horizontal layout preference for the existing viewer, controls, and ledger. It must not remove or replace any Workbench functionality.

## Near-Term Work

- Add label-over-source blending and manual correction while preserving the immutable candidate and recording edits as a new reviewed derivative.
- Establish tooth and cell annotation/evaluation manifests with held-out cohorts, Dice/IoU, boundary error, object-count error, and explicit promotion thresholds.
- Add deeper schema coverage for future multi-volume comparisons once the comparison workflow is real.
- Wire account-backed project storage only after email-code delivery and device pairing are production-ready.
- Keep local import compatibility strict: raw uncompressed 3D Zarr v2, uint8 or uint16, with explicit compatibility errors for unsupported arrays.
