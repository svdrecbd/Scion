# Cell Anatomy Workbench

Native desktop shell for local volumetric inspection. The public web app stays in `apps/web`; this package owns the Tauri window and talks to the local Rust volume engine at `127.0.0.1:8080`.

## Development

```bash
npm install
npm run tauri:dev
```

The Tauri app launches the bundled `volume-engine` sidecar. For engine-only debugging:

```bash
cargo run --release --manifest-path ../../workers/volume-engine/Cargo.toml
```

`npm run tauri:dev` and `npm run tauri:build` rebuild the release sidecar for the current Rust host triple before Tauri starts or packages the app. Run `npm run sidecar:build` directly when validating the native bundle boundary; do not assume the existing binary matches current Rust source.

Set `CELL_ANATOMY_PUBLIC_DATA_ROOT` to point the engine at a local mirrored public-data root. Set `CELL_ANATOMY_VOLUME_ENGINE_PORT` if the default `8080` sidecar port is already in use.

The packaged Workbench generates a fresh loopback authentication token at launch, passes it to the sidecar through `CELL_ANATOMY_VOLUME_ENGINE_TOKEN`, and attaches it to every local engine request. A standalone engine remains unauthenticated when that variable is absent for browser-based development. Do not expose the sidecar beyond `127.0.0.1`.

## Atlas handoff

Every public Atlas dataset detail page can download a `cell-anatomy-caos-handoff` JSON file. Open it with `File > Open Atlas Handoff...` or the Atlas Handoff control in Workbench notes. The Workbench validates the schema and SHA-256 record fingerprint, keeps the record as durable pending context when data is unavailable, and resolves a loaded derivative by dataset, study, or repository accession when possible. Handoffs never include raw pixels or authorize automatic download. Active handoff context is included in Workbench bundle exports.

The Jobs tab reads `/api/volume/index-queue`, starts single conversion and slice-cache jobs through `/api/volume/index-jobs`, and can request dry-run batch conversion plans through `/api/volume/index-batch-plan`. Batch plans are bounded by total and per-dataset caps, can be exported as checkpoint JSON, and can be started as persisted local runs through `/api/volume/index-batch-runs` with bounded concurrency, cancel, and resume. Selected matched private-registry conversion rows can also build the same persisted batch-run plan shape.

Private registry browsing in the native app builds a disposable `private-registry-index.sqlite` cache beside `private-registry.json` and uses SQLite/FTS for bounded project-ready, conversion-queue, and review pages. The portable source artifacts remain `private-registry.json` and `private-registry-assets.jsonl`.

Promoted worksets from `archive_registry.py promote-workset` can be opened with `File > Open Workset...` or the Jobs tab Workset button. The Workbench reads `workset.json` plus sibling `workset-assets.jsonl`, normalizes promoted assets into the same review/conversion panels, and includes the active workset metadata in Workbench bundle exports. A project-ready row that resolves to exactly one loaded Workbench volume can create and save a new CAOS project directly; the project volume records the originating registry asset and optional workset identifiers. Missing or ambiguous loaded-volume matches are blocked instead of producing an incomplete project.

## Account pairing

Workbench can pair to an Atlas account without storing the browser session cookie. It requests a one-time pairing code from the API, opens Atlas at `/account?pair=...`, then stores the returned device token locally after approval.

Useful local env knobs:

```bash
VITE_SCION_API_BASE_URL=http://127.0.0.1:8000/api
VITE_SCION_ATLAS_BASE_URL=http://127.0.0.1:3000
```

If direct Workbench API calls fail in development, confirm the API `SCION_CORS_ORIGINS` includes `http://127.0.0.1:5173`.
