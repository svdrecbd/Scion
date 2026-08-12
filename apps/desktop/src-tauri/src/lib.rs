use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    env, fs,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    Emitter, RunEvent,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

type SidecarChildSlot = Arc<Mutex<Option<CommandChild>>>;
const PRIVATE_REGISTRY_SQLITE_INDEX_VERSION: i64 = 1;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateWorksetFile {
    path: String,
    workset_contents: String,
    assets_contents: String,
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
    index_backend: String,
    index_path: String,
    index_rebuilt: bool,
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
    let home =
        env::var_os("HOME").ok_or_else(|| "Could not resolve the home directory.".to_string())?;
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
    fs::read_to_string(path).map(Some).map_err(|error| {
        format!(
            "Could not read private registry artifact {}: {}",
            path.display(),
            error
        )
    })
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
        review_queue_contents: read_optional_sibling(
            &dir.join("private-registry-review-queue.csv"),
        )?,
        volume_candidates_contents: read_optional_sibling(
            &dir.join("private-registry-volume-candidates.csv"),
        )?,
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

fn read_private_workset_file(path: PathBuf) -> Result<PrivateWorksetFile, String> {
    let workset_contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read CAOS workset summary: {}", error))?;
    let dir = path
        .parent()
        .ok_or_else(|| "Could not resolve CAOS workset directory.".to_string())?;
    let assets_path = dir.join("workset-assets.jsonl");
    let assets_contents = fs::read_to_string(&assets_path)
        .map_err(|error| format!("Could not read CAOS workset assets: {}", error))?;
    Ok(PrivateWorksetFile {
        path: path.to_string_lossy().into_owned(),
        workset_contents,
        assets_contents,
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

#[cfg(test)]
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

#[cfg(test)]
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

fn asset_matches_queue_filter(
    asset: &Value,
    queue_filter: &str,
    matched_keys: &HashSet<String>,
) -> bool {
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

fn private_registry_sqlite_index_path(registry_path: &Path) -> Result<PathBuf, String> {
    let dir = registry_path
        .parent()
        .ok_or_else(|| "Could not resolve private registry directory.".to_string())?;
    Ok(dir.join("private-registry-index.sqlite"))
}

#[derive(Debug, Clone)]
struct PrivateRegistryAssetsSignature {
    path: String,
    size_bytes: i64,
    modified_ms: i64,
}

fn system_time_ms(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn private_registry_assets_signature(
    assets_path: &Path,
) -> Result<PrivateRegistryAssetsSignature, String> {
    let metadata = fs::metadata(assets_path).map_err(|error| {
        format!(
            "Could not inspect private registry assets {}: {}",
            assets_path.display(),
            error
        )
    })?;
    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
    Ok(PrivateRegistryAssetsSignature {
        path: assets_path.to_string_lossy().into_owned(),
        size_bytes: metadata.len() as i64,
        modified_ms: system_time_ms(modified),
    })
}

fn sqlite_error(context: &str, error: rusqlite::Error) -> String {
    format!("{context}: {error}")
}

fn sqlite_meta_value(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM private_registry_index_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

fn private_registry_sqlite_index_current(
    conn: &Connection,
    signature: &PrivateRegistryAssetsSignature,
) -> Result<bool, String> {
    let meta = |key: &str| sqlite_meta_value(conn, key);
    let version = match meta("index_version") {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let Some(version) = version else {
        return Ok(false);
    };
    if version.parse::<i64>().unwrap_or_default() != PRIVATE_REGISTRY_SQLITE_INDEX_VERSION {
        return Ok(false);
    }

    let assets_path = meta("assets_path")
        .map_err(|error| sqlite_error("Could not read registry index metadata", error))?;
    let assets_size = meta("assets_size_bytes")
        .map_err(|error| sqlite_error("Could not read registry index metadata", error))?;
    let assets_modified = meta("assets_modified_ms")
        .map_err(|error| sqlite_error("Could not read registry index metadata", error))?;

    Ok(assets_path.as_deref() == Some(signature.path.as_str())
        && assets_size
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            == Some(signature.size_bytes)
        && assets_modified
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            == Some(signature.modified_ms))
}

fn rebuild_private_registry_sqlite_index(
    conn: &mut Connection,
    assets_path: &Path,
    signature: &PrivateRegistryAssetsSignature,
) -> Result<(), String> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        DROP TABLE IF EXISTS private_registry_asset_fts;
        DROP TABLE IF EXISTS private_registry_asset_match_keys;
        DROP TABLE IF EXISTS private_registry_assets;
        DROP TABLE IF EXISTS private_registry_index_meta;
        CREATE TABLE private_registry_index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE private_registry_assets (
            row_number INTEGER PRIMARY KEY,
            asset_id TEXT NOT NULL,
            search_text TEXT NOT NULL,
            is_project_ready INTEGER NOT NULL,
            is_conversion_queue INTEGER NOT NULL,
            is_review INTEGER NOT NULL,
            queue_ready INTEGER NOT NULL,
            queue_review INTEGER NOT NULL,
            asset_json TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE private_registry_asset_fts
            USING fts5(search_text, content='private_registry_assets', content_rowid='row_number');
        CREATE TABLE private_registry_asset_match_keys (
            row_number INTEGER NOT NULL,
            match_key TEXT NOT NULL
        );
        CREATE INDEX private_registry_assets_project_ready_idx
            ON private_registry_assets(is_project_ready, row_number);
        CREATE INDEX private_registry_assets_conversion_queue_idx
            ON private_registry_assets(is_conversion_queue, row_number);
        CREATE INDEX private_registry_assets_review_idx
            ON private_registry_assets(is_review, row_number);
        CREATE INDEX private_registry_asset_match_keys_idx
            ON private_registry_asset_match_keys(match_key, row_number);
        ",
    )
    .map_err(|error| sqlite_error("Could not initialize private registry SQLite index", error))?;

    let file = File::open(assets_path)
        .map_err(|error| format!("Could not read private registry assets: {}", error))?;
    let reader = BufReader::new(file);
    let tx = conn.transaction().map_err(|error| {
        sqlite_error("Could not start private registry index transaction", error)
    })?;

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
        let row_number = (index + 1) as i64;
        let search_text = asset_search_text(&asset);
        let asset_id = nested_string(&asset, &["asset_id"]);
        let queue_ready = asset_matches_queue_filter(&asset, "ready", &HashSet::new());
        let queue_review = asset_matches_queue_filter(&asset, "review", &HashSet::new());

        tx.execute(
            "
            INSERT INTO private_registry_assets (
                row_number,
                asset_id,
                search_text,
                is_project_ready,
                is_conversion_queue,
                is_review,
                queue_ready,
                queue_review,
                asset_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                row_number,
                asset_id,
                search_text,
                asset_is_project_ready(&asset) as i64,
                asset_is_conversion_queue(&asset) as i64,
                asset_is_review(&asset) as i64,
                queue_ready as i64,
                queue_review as i64,
                line
            ],
        )
        .map_err(|error| {
            sqlite_error("Could not insert private registry asset index row", error)
        })?;
        tx.execute(
            "INSERT INTO private_registry_asset_fts(rowid, search_text) VALUES (?1, ?2)",
            params![row_number, search_text],
        )
        .map_err(|error| sqlite_error("Could not insert private registry FTS row", error))?;
        for match_key in asset_match_keys(&asset) {
            tx.execute(
                "INSERT INTO private_registry_asset_match_keys(row_number, match_key) VALUES (?1, ?2)",
                params![row_number, match_key],
            )
            .map_err(|error| sqlite_error("Could not insert private registry match key", error))?;
        }
    }

    let meta_values = [
        (
            "index_version",
            PRIVATE_REGISTRY_SQLITE_INDEX_VERSION.to_string(),
        ),
        ("assets_path", signature.path.clone()),
        ("assets_size_bytes", signature.size_bytes.to_string()),
        ("assets_modified_ms", signature.modified_ms.to_string()),
    ];
    for (key, value) in meta_values {
        tx.execute(
            "INSERT INTO private_registry_index_meta(key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|error| sqlite_error("Could not write private registry index metadata", error))?;
    }

    tx.commit()
        .map_err(|error| sqlite_error("Could not commit private registry SQLite index", error))
}

fn open_private_registry_sqlite_index(
    registry_path: &Path,
) -> Result<(Connection, PathBuf, bool), String> {
    let assets_path = private_registry_assets_path(registry_path)?;
    let index_path = private_registry_sqlite_index_path(registry_path)?;
    let signature = private_registry_assets_signature(&assets_path)?;
    let mut conn = Connection::open(&index_path)
        .map_err(|error| sqlite_error("Could not open private registry SQLite index", error))?;
    let current = private_registry_sqlite_index_current(&conn, &signature)?;
    if current {
        return Ok((conn, index_path, false));
    }
    rebuild_private_registry_sqlite_index(&mut conn, &assets_path, &signature)?;
    Ok((conn, index_path, true))
}

fn fts_terms_for_query_token(token: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    for ch in token.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            current.push(ch);
        } else if current.len() >= 2 {
            terms.push(format!("{}*", current));
            current.clear();
        } else {
            current.clear();
        }
    }
    if current.len() >= 2 {
        terms.push(format!("{}*", current));
    }
    terms
}

fn fts_query_for_tokens(tokens: &[String]) -> Option<String> {
    let terms: Vec<String> = tokens
        .iter()
        .flat_map(|token| fts_terms_for_query_token(token))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

fn create_temp_matched_keys(conn: &Connection, matched_keys: &[String]) -> Result<(), String> {
    conn.execute_batch(
        "
        DROP TABLE IF EXISTS temp_private_registry_matched_keys;
        CREATE TEMP TABLE temp_private_registry_matched_keys (
            match_key TEXT PRIMARY KEY
        ) WITHOUT ROWID;
        ",
    )
    .map_err(|error| {
        sqlite_error(
            "Could not prepare private registry matched-key filter",
            error,
        )
    })?;
    let mut statement = conn
        .prepare("INSERT OR IGNORE INTO temp_private_registry_matched_keys(match_key) VALUES (?1)")
        .map_err(|error| sqlite_error("Could not prepare matched-key insert", error))?;
    for key in matched_keys {
        statement
            .execute(params![key])
            .map_err(|error| sqlite_error("Could not insert matched-key filter", error))?;
    }
    Ok(())
}

fn registry_sql_section_clause(section: &str) -> Result<&'static str, String> {
    match section {
        "project_ready" => Ok("a.is_project_ready = 1"),
        "conversion_queue" => Ok("a.is_conversion_queue = 1"),
        "review" => Ok("a.is_review = 1"),
        "all" => Ok("1 = 1"),
        _ => Err(format!("Unsupported private registry section: {section}")),
    }
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

    fn project_ready_fixture_asset() -> Value {
        let mut asset = fixture_asset();
        asset["asset_id"] = json!("asset-ready");
        asset["relative_path"] = json!("uwizeye-2021b-empiar-10672/derived/ome-zarr/cell.ome.zarr");
        asset["name"] = json!("cell.ome.zarr");
        asset["extension"] = json!(".zarr");
        asset["metadata"]["format"] = json!("ome-zarr");
        asset["readiness"]["project_ready"] = json!(true);
        asset["status"]["asset_status"] = json!("project_ready");
        asset["status"]["allowed_operations"]["can_view_in_caos"] = json!(true);
        asset
    }

    fn temp_registry_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "caos-private-registry-{name}-{}-{}",
            std::process::id(),
            system_time_ms(SystemTime::now())
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_registry_assets(dir: &Path, assets: &[Value]) -> PathBuf {
        fs::write(
            dir.join("private-registry.json"),
            "{\"schema\":\"cell-anatomy-private-archive-registry\"}\n",
        )
        .unwrap();
        let contents = assets
            .iter()
            .map(|asset| serde_json::to_string(asset).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(dir.join("private-registry-assets.jsonl"), contents).unwrap();
        dir.join("private-registry.json")
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

    #[test]
    fn sqlite_registry_index_queries_conversion_queue_text_and_matched_keys() {
        let dir = temp_registry_dir("query");
        let registry_path =
            write_registry_assets(&dir, &[fixture_asset(), project_ready_fixture_asset()]);

        let result = query_private_registry_index(PrivateRegistryIndexQuery {
            registry_path: registry_path.to_string_lossy().into_owned(),
            section: "conversion_queue".to_string(),
            query: "mocaer uint16".to_string(),
            queue_filter: "all".to_string(),
            offset: 0,
            limit: 10,
            matched_keys: None,
        })
        .unwrap();
        assert_eq!(result.total_count, 1);
        assert!(result.assets_contents.contains("\"asset_id\":\"asset-1\""));
        assert_eq!(result.index_backend, "sqlite-fts");
        assert!(PathBuf::from(&result.index_path).exists());
        assert!(result.index_rebuilt);

        let matched = query_private_registry_index(PrivateRegistryIndexQuery {
            registry_path: registry_path.to_string_lossy().into_owned(),
            section: "conversion_queue".to_string(),
            query: "".to_string(),
            queue_filter: "matched".to_string(),
            offset: 0,
            limit: 10,
            matched_keys: Some(vec!["mocaer-2023-empiar-11399\ndata/cell.tif".to_string()]),
        })
        .unwrap();
        assert_eq!(matched.total_count, 1);
        assert!(matched.assets_contents.contains("\"asset_id\":\"asset-1\""));
        assert!(!matched.index_rebuilt);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sqlite_registry_index_rebuilds_when_assets_jsonl_changes() {
        let dir = temp_registry_dir("rebuild");
        let registry_path = write_registry_assets(&dir, &[fixture_asset()]);

        let first = query_private_registry_index(PrivateRegistryIndexQuery {
            registry_path: registry_path.to_string_lossy().into_owned(),
            section: "project_ready".to_string(),
            query: "".to_string(),
            queue_filter: "all".to_string(),
            offset: 0,
            limit: 10,
            matched_keys: None,
        })
        .unwrap();
        assert_eq!(first.total_count, 0);
        assert!(first.index_rebuilt);

        write_registry_assets(&dir, &[fixture_asset(), project_ready_fixture_asset()]);
        let second = query_private_registry_index(PrivateRegistryIndexQuery {
            registry_path: registry_path.to_string_lossy().into_owned(),
            section: "project_ready".to_string(),
            query: "ome-zarr".to_string(),
            queue_filter: "all".to_string(),
            offset: 0,
            limit: 10,
            matched_keys: None,
        })
        .unwrap();
        assert_eq!(second.total_count, 1);
        assert!(second
            .assets_contents
            .contains("\"asset_id\":\"asset-ready\""));
        assert!(second.index_rebuilt);

        let _ = fs::remove_dir_all(dir);
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
fn open_private_workset_file() -> Result<Option<PrivateWorksetFile>, String> {
    let path = rfd::FileDialog::new()
        .add_filter("CAOS Workset", &["json"])
        .set_file_name("workset.json")
        .pick_file();
    path.map(read_private_workset_file).transpose()
}

#[tauri::command]
fn query_private_registry_index(
    request: PrivateRegistryIndexQuery,
) -> Result<PrivateRegistryIndexQueryResult, String> {
    let registry_path = PathBuf::from(&request.registry_path);
    let tokens: Vec<String> = request
        .query
        .to_lowercase()
        .split_whitespace()
        .map(ToString::to_string)
        .collect();
    let matched_keys = request.matched_keys.clone().unwrap_or_default();
    let limit = request.limit.clamp(1, 100);
    let (conn, index_path, index_rebuilt) = open_private_registry_sqlite_index(&registry_path)?;

    if request.section == "conversion_queue" && request.queue_filter == "matched" {
        create_temp_matched_keys(&conn, &matched_keys)?;
    }

    let mut from_sql = "private_registry_assets a".to_string();
    let mut where_clauses = vec![registry_sql_section_clause(&request.section)?.to_string()];
    let mut bind_values: Vec<SqlValue> = Vec::new();

    if let Some(fts_query) = fts_query_for_tokens(&tokens) {
        from_sql.push_str(
            " JOIN private_registry_asset_fts ON private_registry_asset_fts.rowid = a.row_number",
        );
        where_clauses.push("private_registry_asset_fts MATCH ?".to_string());
        bind_values.push(SqlValue::Text(fts_query));
    }

    if request.section == "conversion_queue" {
        match request.queue_filter.as_str() {
            "ready" => where_clauses.push("a.queue_ready = 1".to_string()),
            "review" => where_clauses.push("a.queue_review = 1".to_string()),
            "matched" => where_clauses.push(
                "EXISTS (
                    SELECT 1
                    FROM private_registry_asset_match_keys amk
                    JOIN temp_private_registry_matched_keys mk
                        ON mk.match_key = amk.match_key
                    WHERE amk.row_number = a.row_number
                )"
                .to_string(),
            ),
            "all" => {}
            other => {
                return Err(format!(
                    "Unsupported private registry queue filter: {other}"
                ))
            }
        }
    }

    for token in &tokens {
        where_clauses.push("instr(a.search_text, ?) > 0".to_string());
        bind_values.push(SqlValue::Text(token.clone()));
    }

    let where_sql = where_clauses.join(" AND ");
    let count_sql = format!("SELECT COUNT(*) FROM {from_sql} WHERE {where_sql}");
    let total_count: i64 = conn
        .query_row(&count_sql, params_from_iter(bind_values.clone()), |row| {
            row.get(0)
        })
        .map_err(|error| sqlite_error("Could not count private registry index rows", error))?;

    let select_sql = format!(
        "SELECT a.asset_json FROM {from_sql} WHERE {where_sql} ORDER BY a.row_number LIMIT {} OFFSET {}",
        limit,
        request.offset
    );
    let mut statement = conn
        .prepare(&select_sql)
        .map_err(|error| sqlite_error("Could not prepare private registry index query", error))?;
    let selected_lines: Vec<String> = statement
        .query_map(params_from_iter(bind_values), |row| row.get::<_, String>(0))
        .map_err(|error| sqlite_error("Could not query private registry index", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("Could not read private registry index row", error))?;

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
        total_count: total_count as usize,
        assets_contents,
        index_backend: "sqlite-fts".to_string(),
        index_path: index_path.to_string_lossy().into_owned(),
        index_rebuilt,
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
            &menu_item(app, "open-private-workset", "Open Workset...", None)?,
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
            open_private_workset_file,
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
