use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    env,
    fs,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    Emitter, RunEvent,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

type SidecarChildSlot = Arc<Mutex<Option<CommandChild>>>;

#[tauri::command]
fn select_local_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct CaosProjectFile {
    path: String,
    contents: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateRegistryFile {
    path: String,
    summary_contents: String,
    assets_contents: String,
    search_contents: Option<String>,
    review_queue_contents: Option<String>,
    volume_candidates_contents: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateRegistryIndexFile {
    path: String,
    summary_contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrivateRegistryIndexQuery {
    registry_path: String,
    section: String,
    query: String,
    queue_filter: String,
    offset: usize,
    limit: usize,
    matched_keys: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateRegistryIndexQueryResult {
    registry_path: String,
    section: String,
    query: String,
    queue_filter: String,
    offset: usize,
    limit: usize,
    total_count: usize,
    assets_contents: String,
}

#[derive(Serialize)]
struct SavedCaosProjectFile {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveCaosProjectRequest {
    path: Option<String>,
    contents: String,
    default_filename: Option<String>,
    force_dialog: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedViewSnapshotFiles {
    png_path: String,
    metadata_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveViewSnapshotRequest {
    default_filename: String,
    png_data_url: String,
    metadata: String,
}

fn normalize_project_save_path(path: PathBuf) -> PathBuf {
    if path.extension().is_some() {
        return path;
    }
    let mut next = path;
    next.set_extension("json");
    next
}

fn safe_file_name(value: &str, fallback: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .filter(|file_name| !file_name.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn downloads_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME").ok_or_else(|| "Could not resolve the home directory.".to_string())?;
    Ok(PathBuf::from(home).join("Downloads"))
}

fn metadata_path_for_png(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("workbench-view");
    path.with_file_name(format!("{stem}.view.json"))
}

fn decode_png_data_url(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value
        .split_once(',')
        .map(|(_, encoded)| encoded)
        .unwrap_or(value)
        .trim();
    general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Could not decode exported PNG data: {error}"))
}

fn read_project_file(path: PathBuf) -> Result<CaosProjectFile, String> {
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read CAOS project file: {}", error))?;
    Ok(CaosProjectFile {
        path: path.to_string_lossy().into_owned(),
        contents,
    })
}

fn read_optional_sibling(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("Could not read private registry artifact {}: {}", path.display(), error))
}

fn read_private_registry_file(path: PathBuf) -> Result<PrivateRegistryFile, String> {
    let summary_contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read private registry summary: {}", error))?;
    let dir = path
        .parent()
        .ok_or_else(|| "Could not resolve private registry directory.".to_string())?;
    let assets_path = dir.join("private-registry-assets.jsonl");
    let assets_contents = fs::read_to_string(&assets_path)
        .map_err(|error| format!("Could not read private registry assets: {}", error))?;

    Ok(PrivateRegistryFile {
        path: path.to_string_lossy().into_owned(),
        summary_contents,
        assets_contents,
        search_contents: read_optional_sibling(&dir.join("private-registry-search-index.jsonl"))?,
        review_queue_contents: read_optional_sibling(&dir.join("private-registry-review-queue.csv"))?,
        volume_candidates_contents: read_optional_sibling(&dir.join("private-registry-volume-candidates.csv"))?,
    })
}

fn read_private_registry_index_file(path: PathBuf) -> Result<PrivateRegistryIndexFile, String> {
    let summary_contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read private registry summary: {}", error))?;
    Ok(PrivateRegistryIndexFile {
        path: path.to_string_lossy().into_owned(),
        summary_contents,
    })
}

fn nested_value<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn nested_string(value: &Value, path: &[&str]) -> String {
    nested_value(value, path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn nested_bool(value: &Value, path: &[&str]) -> bool {
    nested_value(value, path)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn nested_string_array(value: &Value, path: &[&str]) -> Vec<String> {
    nested_value(value, path)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_registry_path(value: &str) -> String {
    let mut normalized = value.replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    normalized.trim_matches('/').to_string()
}

fn asset_review_blocker_count(asset: &Value) -> usize {
    nested_string_array(asset, &["readiness", "blockers"])
        .into_iter()
        .filter(|blocker| blocker != "blocked_permission")
        .count()
}

fn asset_gap_count(asset: &Value) -> usize {
    nested_value(asset, &["review", "gap_codes"])
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_else(|| {
            nested_value(asset, &["review", "gap_count"])
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize
        })
}

fn asset_is_project_ready(asset: &Value) -> bool {
    nested_bool(asset, &["readiness", "project_ready"])
}

fn asset_is_conversion_queue(asset: &Value) -> bool {
    !asset_is_project_ready(asset)
        && nested_bool(asset, &["status", "allowed_operations", "can_convert"])
        && nested_bool(asset, &["readiness", "metadata_ready"])
        && nested_bool(asset, &["readiness", "has_checksum"])
}

fn asset_is_review(asset: &Value) -> bool {
    nested_bool(asset, &["status", "review_required"])
        || asset_gap_count(asset) > 0
        || !nested_string_array(asset, &["readiness", "blockers"]).is_empty()
        || !nested_string(asset, &["checksum", "duplicate_of"]).is_empty()
}

fn asset_matches_section(asset: &Value, section: &str) -> bool {
    match section {
        "project_ready" => asset_is_project_ready(asset),
        "conversion_queue" => asset_is_conversion_queue(asset),
        "review" => asset_is_review(asset),
        "all" => true,
        _ => false,
    }
}

fn asset_search_text(asset: &Value) -> String {
    let mut parts = vec![
        nested_string(asset, &["asset_id"]),
        nested_string(asset, &["archive_id"]),
        nested_string(asset, &["relative_path"]),
        nested_string(asset, &["name"]),
        nested_string(asset, &["extension"]),
        nested_string(asset, &["likely_role"]),
        nested_string(asset, &["metadata", "status"]),
        nested_string(asset, &["metadata", "format"]),
        nested_string(asset, &["metadata", "dtype"]),
        nested_string(asset, &["metadata", "metadata_source"]),
        nested_string(asset, &["status", "asset_status"]),
        nested_string(asset, &["status", "publication_status"]),
        nested_string(asset, &["status", "triage_status"]),
        nested_string(asset, &["status", "rights_status"]),
        nested_string(asset, &["status", "classification_status"]),
    ];
    parts.extend(nested_string_array(asset, &["review", "gap_codes"]));
    parts.extend(nested_string_array(asset, &["review", "gap_severities"]));
    parts.extend(nested_string_array(asset, &["readiness", "blockers"]));
    parts.join(" ").to_lowercase()
}

fn asset_matches_query(asset: &Value, tokens: &[String]) -> bool {
    if tokens.is_empty() {
        return true;
    }
    let text = asset_search_text(asset);
    tokens.iter().all(|token| text.contains(token))
}

fn asset_match_keys(asset: &Value) -> Vec<String> {
    let archive_id = nested_string(asset, &["archive_id"]);
    let paths = [
        nested_string(asset, &["relative_path"]),
        nested_string(asset, &["source", "relative_path"]),
    ];
    let mut keys = Vec::new();
    for raw_path in paths {
        let path = normalize_registry_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        if parts.len() > 1 {
            let dataset_slug = parts[0];
            let dataset_relative = parts[1..].join("/");
            if !dataset_relative.is_empty() {
                keys.push(format!("{dataset_slug}\n{dataset_relative}"));
            }
            keys.push(format!("{dataset_slug}\n{path}"));
        }
        if !archive_id.is_empty() {
            keys.push(format!("{archive_id}\n{path}"));
        }
    }
    keys
}

fn asset_matches_matched_keys(asset: &Value, matched_keys: &HashSet<String>) -> bool {
    if matched_keys.is_empty() {
        return false;
    }
    asset_match_keys(asset)
        .iter()
        .any(|key| matched_keys.contains(key))
}

fn asset_matches_queue_filter(asset: &Value, queue_filter: &str, matched_keys: &HashSet<String>) -> bool {
    match queue_filter {
        "ready" => {
            asset_review_blocker_count(asset) == 0
                && !nested_bool(asset, &["status", "review_required"])
                && asset_gap_count(asset) == 0
        }
        "review" => {
            asset_review_blocker_count(asset) > 0
                || nested_bool(asset, &["status", "review_required"])
                || asset_gap_count(asset) > 0
        }
        "matched" => asset_matches_matched_keys(asset, matched_keys),
        _ => true,
    }
}

fn private_registry_assets_path(registry_path: &Path) -> Result<PathBuf, String> {
    let dir = registry_path
        .parent()
        .ok_or_else(|| "Could not resolve private registry directory.".to_string())?;
    Ok(dir.join("private-registry-assets.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_asset() -> Value {
        json!({
            "asset_id": "asset-1",
            "archive_id": "scion-public-data-local",
            "relative_path": "mocaer-2023-empiar-11399/data/cell.tif",
            "name": "cell.tif",
            "extension": ".tif",
            "likely_role": "volume_source",
            "source": {
                "relative_path": "mocaer-2023-empiar-11399/data/cell.tif"
            },
            "checksum": {
                "duplicate_of": ""
            },
            "metadata": {
                "status": "extracted",
                "format": "tiff",
                "dtype": "uint16",
                "metadata_source": "public_data_conversion_readiness_manifest"
            },
            "status": {
                "asset_status": "conversion_candidate",
                "publication_status": "public",
                "triage_status": "candidate",
                "rights_status": "public",
                "classification_status": "source",
                "review_required": false,
                "allowed_operations": {
                    "can_convert": true
                }
            },
            "review": {
                "gap_codes": [],
                "gap_severities": []
            },
            "readiness": {
                "metadata_ready": true,
                "has_checksum": true,
                "project_ready": false,
                "blockers": ["blocked_permission"]
            }
        })
    }

    #[test]
    fn conversion_queue_ignores_permission_blocker_for_ready_filter() {
        let asset = fixture_asset();
        assert!(asset_is_conversion_queue(&asset));
        assert!(asset_matches_section(&asset, "conversion_queue"));
        assert!(asset_matches_queue_filter(&asset, "ready", &HashSet::new()));
    }

    #[test]
    fn query_and_matched_filters_use_registry_path_keys() {
        let asset = fixture_asset();
        let tokens = vec!["mocaer".to_string(), "uint16".to_string()];
        let mut matched = HashSet::new();
        matched.insert("mocaer-2023-empiar-11399\ndata/cell.tif".to_string());

        assert!(asset_matches_query(&asset, &tokens));
        assert!(asset_matches_queue_filter(&asset, "matched", &matched));
    }
}

#[tauri::command]
fn open_caos_project_file() -> Result<Option<CaosProjectFile>, String> {
    let path = rfd::FileDialog::new()
        .add_filter("CAOS Project", &["json", "caos"])
        .pick_file();
    path.map(read_project_file).transpose()
}

#[tauri::command]
fn open_private_registry_file() -> Result<Option<PrivateRegistryFile>, String> {
    let path = rfd::FileDialog::new()
        .add_filter("CAOS Private Registry", &["json"])
        .set_file_name("private-registry.json")
        .pick_file();
    path.map(read_private_registry_file).transpose()
}

#[tauri::command]
fn open_private_registry_index_file() -> Result<Option<PrivateRegistryIndexFile>, String> {
    let path = rfd::FileDialog::new()
        .add_filter("CAOS Private Registry", &["json"])
        .set_file_name("private-registry.json")
        .pick_file();
    path.map(read_private_registry_index_file).transpose()
}

#[tauri::command]
fn query_private_registry_index(
    request: PrivateRegistryIndexQuery,
) -> Result<PrivateRegistryIndexQueryResult, String> {
    let registry_path = PathBuf::from(&request.registry_path);
    let assets_path = private_registry_assets_path(&registry_path)?;
    let file = File::open(&assets_path)
        .map_err(|error| format!("Could not read private registry assets: {}", error))?;
    let reader = BufReader::new(file);
    let tokens: Vec<String> = request
        .query
        .to_lowercase()
        .split_whitespace()
        .map(ToString::to_string)
        .collect();
    let matched_keys: HashSet<String> = request
        .matched_keys
        .unwrap_or_default()
        .into_iter()
        .collect();
    let limit = request.limit.clamp(1, 100);
    let mut total_count = 0usize;
    let mut selected_lines: Vec<String> = Vec::new();

    for (index, line) in reader.lines().enumerate() {
        let line = line.map_err(|error| {
            format!(
                "Could not read private registry asset row {}: {}",
                index + 1,
                error
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let asset: Value = serde_json::from_str(&line).map_err(|error| {
            format!(
                "Could not parse private registry asset row {}: {}",
                index + 1,
                error
            )
        })?;
        if !asset_matches_section(&asset, &request.section) {
            continue;
        }
        if request.section == "conversion_queue"
            && !asset_matches_queue_filter(&asset, &request.queue_filter, &matched_keys)
        {
            continue;
        }
        if !asset_matches_query(&asset, &tokens) {
            continue;
        }

        if total_count >= request.offset && selected_lines.len() < limit {
            selected_lines.push(line);
        }
        total_count += 1;
    }

    let assets_contents = if selected_lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", selected_lines.join("\n"))
    };

    Ok(PrivateRegistryIndexQueryResult {
        registry_path: request.registry_path,
        section: request.section,
        query: request.query,
        queue_filter: request.queue_filter,
        offset: request.offset,
        limit,
        total_count,
        assets_contents,
    })
}

#[tauri::command]
fn read_caos_project_file(path: String) -> Result<CaosProjectFile, String> {
    read_project_file(PathBuf::from(path))
}

#[tauri::command]
fn save_caos_project_file(
    request: SaveCaosProjectRequest,
) -> Result<Option<SavedCaosProjectFile>, String> {
    let target = if !request.force_dialog {
        request
            .path
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
    } else {
        None
    };

    let path = match target {
        Some(path) => path,
        None => {
            let mut dialog = rfd::FileDialog::new().add_filter("CAOS Project", &["json", "caos"]);
            if let Some(default_filename) = request.default_filename {
                dialog = dialog.set_file_name(default_filename);
            }
            match dialog.save_file() {
                Some(path) => normalize_project_save_path(path),
                None => return Ok(None),
            }
        }
    };

    fs::write(&path, request.contents)
        .map_err(|error| format!("Could not save CAOS project file: {}", error))?;
    Ok(Some(SavedCaosProjectFile {
        path: path.to_string_lossy().into_owned(),
    }))
}

#[tauri::command]
fn save_view_snapshot_files(
    request: SaveViewSnapshotRequest,
) -> Result<SavedViewSnapshotFiles, String> {
    let mut filename = safe_file_name(&request.default_filename, "workbench-view.png");
    if !filename.to_lowercase().ends_with(".png") {
        filename.push_str(".png");
    }

    let dir = downloads_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not prepare Downloads directory: {error}"))?;

    let png_path = dir.join(filename);
    let metadata_path = metadata_path_for_png(&png_path);
    let png_bytes = decode_png_data_url(&request.png_data_url)?;

    fs::write(&png_path, png_bytes)
        .map_err(|error| format!("Could not write exported view PNG: {error}"))?;
    fs::write(&metadata_path, request.metadata)
        .map_err(|error| format!("Could not write exported view metadata: {error}"))?;

    Ok(SavedViewSnapshotFiles {
        png_path: png_path.to_string_lossy().into_owned(),
        metadata_path: metadata_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn confirm_discard_project_changes(project_name: Option<String>) -> bool {
    let name = project_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "this CAOS project".to_string());
    matches!(
        rfd::MessageDialog::new()
            .set_title("Unsaved CAOS Project")
            .set_description(format!(
                "{} has unsaved changes. Discard them and continue?",
                name
            ))
            .set_buttons(rfd::MessageButtons::YesNo)
            .show(),
        rfd::MessageDialogResult::Yes
    )
}

fn menu_item<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, text);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

fn build_native_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &menu_item(
                app,
                "open-local",
                "Open Local Zarr Folder...",
                Some("CmdOrCtrl+O"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &menu_item(
                app,
                "open-caos",
                "Open CAOS Project...",
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &menu_item(
                app,
                "open-private-registry",
                "Open Private Registry...",
                None,
            )?,
            &menu_item(app, "save-caos", "Save CAOS Project", Some("CmdOrCtrl+S"))?,
            &menu_item(
                app,
                "save-caos-as",
                "Save CAOS Project As...",
                Some("CmdOrCtrl+Shift+S"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &menu_item(app, "save-view", "Save View Snapshot", None)?,
            &menu_item(app, "show-notes", "Show Notes", Some("CmdOrCtrl+L"))?,
            &PredefinedMenuItem::separator(app)?,
            &menu_item(
                app,
                "export-view",
                "Export View Snapshot...",
                Some("CmdOrCtrl+E"),
            )?,
            &menu_item(
                app,
                "export-bundle",
                "Export Workbench Bundle...",
                Some("CmdOrCtrl+Shift+E"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &menu_item(
                app,
                "copy-link",
                "Copy Coordinate Link",
                Some("CmdOrCtrl+Shift+C"),
            )?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &menu_item(
                app,
                "toggle-mirror",
                "Mirror Workbench Layout",
                Some("CmdOrCtrl+M"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let tools_menu = Submenu::with_items(
        app,
        "Tools",
        true,
        &[
            &menu_item(
                app,
                "toggle-measure",
                "Toggle Measurement",
                Some("CmdOrCtrl+Shift+M"),
            )?,
            &menu_item(app, "roi-point", "Point ROI", Some("CmdOrCtrl+1"))?,
            &menu_item(app, "roi-box", "Box ROI", Some("CmdOrCtrl+2"))?,
            &PredefinedMenuItem::separator(app)?,
            &menu_item(app, "run-jobs", "Open Jobs", Some("CmdOrCtrl+R"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(app, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &tools_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

fn replace_sidecar_child(child_slot: &SidecarChildSlot, child: CommandChild) {
    let previous_child = match child_slot.lock() {
        Ok(mut guard) => guard.replace(child),
        Err(poisoned) => poisoned.into_inner().replace(child),
    };

    if let Some(child) = previous_child {
        let pid = child.pid();
        if let Err(error) = child.kill() {
            eprintln!("Failed to stop previous volume-engine sidecar pid {pid}: {error}");
        }
    }
}

fn clear_sidecar_child(child_slot: &SidecarChildSlot) {
    match child_slot.lock() {
        Ok(mut guard) => {
            let _ = guard.take();
        }
        Err(poisoned) => {
            let _ = poisoned.into_inner().take();
        }
    }
}

fn kill_volume_engine_child(child_slot: &SidecarChildSlot) {
    let child = match child_slot.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };

    if let Some(child) = child {
        let pid = child.pid();
        match child.kill() {
            Ok(()) => println!("Stopped volume-engine sidecar process: pid {pid}"),
            Err(error) => eprintln!("Failed to stop volume-engine sidecar pid {pid}: {error}"),
        }
    }
}

fn spawn_volume_engine_supervisor<R: tauri::Runtime + 'static>(
    app: tauri::AppHandle<R>,
    child_slot: SidecarChildSlot,
    shutdown: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        while !shutdown.load(Ordering::SeqCst) {
            match app.shell().sidecar("volume-engine") {
                Ok(sidecar) => match sidecar.spawn() {
                    Ok((mut rx, child)) => {
                        let pid = child.pid();
                        println!(
                            "Successfully spawned volume-engine sidecar process: pid {}",
                            pid
                        );
                        replace_sidecar_child(&child_slot, child);
                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    let log_str = String::from_utf8_lossy(&line);
                                    println!("sidecar stdout: {}", log_str.trim());
                                }
                                CommandEvent::Stderr(line) => {
                                    let log_str = String::from_utf8_lossy(&line);
                                    eprintln!("sidecar stderr: {}", log_str.trim());
                                }
                                CommandEvent::Error(error) => {
                                    eprintln!("sidecar event error: {}", error);
                                }
                                CommandEvent::Terminated(payload) => {
                                    clear_sidecar_child(&child_slot);
                                    if shutdown.load(Ordering::SeqCst) {
                                        eprintln!(
                                            "volume-engine sidecar terminated during app shutdown: code {:?}, signal {:?}.",
                                            payload.code, payload.signal
                                        );
                                    } else {
                                        eprintln!(
                                            "volume-engine sidecar terminated: code {:?}, signal {:?}. Restarting shortly.",
                                            payload.code, payload.signal
                                        );
                                    }
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "Failed to spawn volume-engine sidecar child process: {:?}. Retrying shortly.",
                            error
                        );
                    }
                },
                Err(error) => {
                    eprintln!(
                        "Failed to locate volume-engine sidecar binary: {:?}. Retrying shortly.",
                        error
                    );
                }
            }

            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        kill_volume_engine_child(&child_slot);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_child = Arc::new(Mutex::new(None));
    let sidecar_shutdown = Arc::new(AtomicBool::new(false));
    let setup_sidecar_child = Arc::clone(&sidecar_child);
    let setup_sidecar_shutdown = Arc::clone(&sidecar_shutdown);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            select_local_directory,
            open_caos_project_file,
            open_private_registry_file,
            open_private_registry_index_file,
            query_private_registry_index,
            read_caos_project_file,
            save_caos_project_file,
            save_view_snapshot_files,
            confirm_discard_project_changes
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let menu = build_native_menu(&handle)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("caos-native-command", event.id().as_ref());
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            spawn_volume_engine_supervisor(
                handle,
                Arc::clone(&setup_sidecar_child),
                Arc::clone(&setup_sidecar_shutdown),
            );

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            sidecar_shutdown.store(true, Ordering::SeqCst);
            kill_volume_engine_child(&sidecar_child);
        }
        _ => {}
    });
}
