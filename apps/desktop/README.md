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
