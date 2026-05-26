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

## Account pairing

Workbench can pair to an Atlas account without storing the browser session cookie. It requests a one-time pairing code from the API, opens Atlas at `/account?pair=...`, then stores the returned device token locally after approval.

Useful local env knobs:

```bash
VITE_SCION_API_BASE_URL=http://127.0.0.1:8000/api
VITE_SCION_ATLAS_BASE_URL=http://127.0.0.1:3000
```

If direct Workbench API calls fail in development, confirm the API `SCION_CORS_ORIGINS` includes `http://127.0.0.1:5173`.
