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

Set `CELL_ANATOMY_PUBLIC_DATA_ROOT` to point the engine at a local mirrored public-data root. Set `CELL_ANATOMY_VOLUME_ENGINE_PORT` if the default `8080` sidecar port is already in use.

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
