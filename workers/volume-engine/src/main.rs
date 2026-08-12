use axum::{
    extract::{Path as AxumPath, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead as StdBufRead, BufReader as StdBufReader, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tower_http::cors::{Any, CorsLayer};

static CUSTOM_DATASETS: OnceLock<Mutex<Vec<serde_json::Value>>> = OnceLock::new();
static LOCAL_ID_COUNTER: AtomicU64 = AtomicU64::new(1);
const VOLUME_ENGINE_TOKEN_HEADER: &str = "x-caos-volume-token";
const MAX_PRIVATE_WORKSET_ASSETS: usize = 10_000;
fn get_custom_datasets() -> &'static Mutex<Vec<serde_json::Value>> {
    CUSTOM_DATASETS.get_or_init(|| Mutex::new(load_custom_dataset_registry()))
}

// Embed metadata CSVs for full self-contained offline capability
const STUDY_MANIFEST_CSV: &str = include_str!("../../../references/manifests/study_manifest.csv");
const CORPUS_LOCATOR_CSV: &str = include_str!("../../../references/manifests/corpus_locator.csv");
const PUBLIC_DATA_ASSETS_CSV: &str =
    include_str!("../../../references/manifests/public_data_assets.csv");

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    index_jobs: Arc<Mutex<BTreeMap<String, IndexJobRecord>>>,
    index_batch_runs: Arc<Mutex<BTreeMap<String, IndexBatchRunRecord>>>,
    private_worksets: Arc<Mutex<BTreeMap<String, PathBuf>>>,
}

#[derive(Clone)]
struct VolumeEngineAuth {
    token: Option<String>,
}

fn volume_engine_request_authorized(expected: Option<&str>, provided: Option<&str>) -> bool {
    match expected {
        None => true,
        Some(expected) => provided
            .map(|provided| provided.as_bytes() == expected.as_bytes())
            .unwrap_or(false),
    }
}

async fn require_volume_engine_auth(
    State(auth): State<VolumeEngineAuth>,
    request: Request,
    next: Next,
) -> Response {
    if request.method() == Method::OPTIONS {
        return next.run(request).await;
    }
    let provided = request
        .headers()
        .get(VOLUME_ENGINE_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    if volume_engine_request_authorized(auth.token.as_deref(), provided) {
        return next.run(request).await;
    }
    json_response(
        StatusCode::UNAUTHORIZED,
        serde_json::json!({ "error": "Volume engine authentication is required." }),
    )
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct IndexJobRecord {
    id: String,
    kind: String,
    dataset_slug: String,
    asset_relative_path: String,
    status: String,
    created_at_ms: u64,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    exit_code: Option<i32>,
    pid: Option<u32>,
    command: Vec<String>,
    command_display: String,
    log: Vec<String>,
    error: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct StartIndexJobRequest {
    kind: String,
    dataset_slug: String,
    asset_relative_path: String,
}

#[derive(Deserialize, Debug)]
struct RegisterPrivateWorksetRequest {
    workset_path: String,
}

#[derive(Deserialize, Debug, Clone)]
struct IndexBatchPlanRequest {
    kind: String,
    dataset_slug: Option<String>,
    total_limit: Option<usize>,
    per_dataset_limit: Option<usize>,
    retry_failed: Option<bool>,
    skip_completed: Option<bool>,
}

#[derive(Deserialize, Debug, Clone)]
struct StartIndexBatchRunRequest {
    plan: Value,
    concurrency: Option<usize>,
}

#[derive(Deserialize, Debug, Clone)]
struct ResumeIndexBatchRunRequest {
    retry_failed: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct IndexBatchRunSummary {
    total: usize,
    pending: usize,
    queued: usize,
    running: usize,
    completed: usize,
    failed: usize,
    cancelled: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct IndexBatchRunItem {
    kind: String,
    dataset_slug: String,
    dataset_title: String,
    asset_relative_path: String,
    command_display: String,
    status: String,
    job_id: Option<String>,
    existing_job_status: Option<String>,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct IndexBatchRunRecord {
    id: String,
    plan_id: String,
    kind: String,
    root: Option<String>,
    status: String,
    concurrency: usize,
    created_at_ms: u64,
    updated_at_ms: u64,
    finished_at_ms: Option<u64>,
    checkpoint_path: String,
    summary: IndexBatchRunSummary,
    items: Vec<IndexBatchRunItem>,
    log: Vec<String>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DatasetRecord {
    pub dataset_id: String,
    pub title: String,
    pub paper_title: String,
    pub year: i64,
    pub source: String,
    pub source_type: String,
    pub public_data_status: String,
    pub species: String,
    pub cell_type: String,
    pub tissue_or_system: Option<String>,
    pub comparator_class: Option<String>,
    pub comparator_detail: Option<String>,
    pub modality: String,
    pub modality_family: String,
    pub lateral_resolution_nm: Option<f64>,
    pub axial_resolution_nm: Option<f64>,
    pub isotropic: Option<bool>,
    pub organelles: Vec<String>,
    pub organelle_pairs: Vec<String>,
    pub metric_families: Vec<String>,
    pub sample_size: Option<i64>,
    pub sample_size_bucket: String,
    pub metadata_completeness_score: f64,
    pub whole_cell_boundary_confirmed: String,
    pub notes: Option<String>,
    pub included_status: String,
    pub source_study_id: Option<String>,
    pub publication_pmid: Option<String>,
    pub source_publication_url: Option<String>,
    pub public_locator_urls: Vec<String>,
}

#[derive(Deserialize, Default, Clone)]
struct DatasetFilters {
    query: Option<String>,
    year: Option<i64>,
    cell_type: Option<String>,
    organelle: Option<String>,
    #[serde(rename = "pair")]
    organelle_pair: Option<String>,
    modality: Option<String>,
    #[serde(rename = "family")]
    modality_family: Option<String>,
    #[serde(rename = "metric")]
    metric_family: Option<String>,
    comparator_class: Option<String>,
    #[serde(rename = "status")]
    public_data_status: Option<String>,
    #[serde(rename = "public")]
    public_data_only: Option<bool>,
    #[serde(rename = "borderline")]
    include_borderline: Option<bool>,
    limit: Option<usize>,
}

// ==========================================
// VOLUMETRIC SLICING / DOWNSAMPLING CORE
// ==========================================

#[derive(Deserialize)]
struct SliceParams {
    dataset: String,
    asset: String,
    axis: String,
    slice: usize,
}

#[derive(Deserialize, Debug)]
struct Zarray {
    shape: Vec<usize>,
    chunks: Vec<usize>,
    dtype: String,
    compressor: Option<Value>,
    filters: Option<Value>,
    order: Option<String>,
    zarr_format: Option<u8>,
    dimension_separator: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct DerivativeEntry {
    source_relative_path: String,
    output_path: String,
    shape_zyx: Vec<usize>,
    chunks_zyx: Vec<usize>,
    dtype: String,
    physical_voxel_size_nm: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct DerivativeManifest {
    derivatives: Vec<DerivativeEntry>,
}

fn get_workbench_state_dir() -> PathBuf {
    if let Ok(root) = std::env::var("CELL_ANATOMY_WORKBENCH_STATE_DIR") {
        return PathBuf::from(root);
    }
    if let Ok(root) = std::env::var("SCION_WORKBENCH_STATE_DIR") {
        return PathBuf::from(root);
    }
    if let Some(home) = home::home_dir() {
        return home
            .join("Library")
            .join("Application Support")
            .join("Cell Anatomy Workbench");
    }
    PathBuf::from(".cell-anatomy-workbench")
}

fn get_custom_dataset_registry_path() -> PathBuf {
    get_workbench_state_dir().join("local-datasets.json")
}

fn get_private_workset_registry_path() -> PathBuf {
    get_workbench_state_dir().join("private-worksets.json")
}

fn get_index_batch_runs_dir() -> PathBuf {
    get_workbench_state_dir().join("index-batch-runs")
}

fn get_index_batch_run_path(run_id: &str) -> PathBuf {
    get_index_batch_runs_dir().join(format!("{}.json", run_id))
}

fn dataset_output_path_exists(dataset: &Value) -> bool {
    dataset
        .get("derivatives")
        .and_then(|d| d.as_array())
        .and_then(|derivatives| derivatives.first())
        .and_then(|derivative| derivative.get("output_path"))
        .and_then(|path| path.as_str())
        .map(|path| PathBuf::from(path).exists())
        .unwrap_or(false)
}

fn load_custom_dataset_registry() -> Vec<Value> {
    let registry_path = get_custom_dataset_registry_path();
    let file = match File::open(&registry_path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };

    let parsed = match serde_json::from_reader::<_, Vec<Value>>(file) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!(
                "Failed to parse local dataset registry {:?}: {}",
                registry_path, err
            );
            return Vec::new();
        }
    };

    parsed
        .into_iter()
        .filter(dataset_output_path_exists)
        .collect()
}

fn persist_custom_dataset_registry(datasets: &[Value]) -> Result<(), String> {
    let registry_path = get_custom_dataset_registry_path();
    let parent = registry_path
        .parent()
        .ok_or_else(|| "Local dataset registry path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create registry directory {:?}: {}", parent, err))?;

    let mut file = File::create(&registry_path)
        .map_err(|err| format!("Failed to create registry {:?}: {}", registry_path, err))?;
    let payload = serde_json::to_string_pretty(datasets)
        .map_err(|err| format!("Failed to serialize local dataset registry: {}", err))?;
    file.write_all(payload.as_bytes())
        .map_err(|err| format!("Failed to write registry {:?}: {}", registry_path, err))
}

fn load_private_workset_registry() -> BTreeMap<String, PathBuf> {
    let registry_path = get_private_workset_registry_path();
    let file = match File::open(&registry_path) {
        Ok(file) => file,
        Err(_) => return BTreeMap::new(),
    };
    let stored = match serde_json::from_reader::<_, BTreeMap<String, PathBuf>>(file) {
        Ok(stored) => stored,
        Err(error) => {
            eprintln!(
                "Failed to parse private workset registry {:?}: {}",
                registry_path, error
            );
            return BTreeMap::new();
        }
    };
    let mut loaded = BTreeMap::new();
    for path in stored.into_values() {
        let Ok(path) = canonical_workset_path(&path.to_string_lossy()) else {
            continue;
        };
        let Ok(dataset) = private_workset_dataset_payload(&path) else {
            continue;
        };
        let slug = value_str(&dataset, "slug");
        if !slug.is_empty() {
            loaded.insert(slug.to_string(), path);
        }
    }
    loaded
}

fn persist_private_workset_registry(worksets: &BTreeMap<String, PathBuf>) -> Result<(), String> {
    let registry_path = get_private_workset_registry_path();
    let parent = registry_path
        .parent()
        .ok_or_else(|| "Private workset registry path has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create private workset registry directory {:?}: {}",
            parent, error
        )
    })?;
    let staging =
        registry_path.with_file_name(format!(".private-worksets.json.tmp-{}", std::process::id()));
    let payload = serde_json::to_string_pretty(worksets)
        .map_err(|error| format!("Failed to serialize private workset registry: {}", error))?;
    let mut file = File::create(&staging)
        .map_err(|error| format!("Failed to create registry {:?}: {}", staging, error))?;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("Failed to write registry {:?}: {}", staging, error))?;
    fs::rename(&staging, &registry_path).map_err(|error| {
        let _ = fs::remove_file(&staging);
        format!(
            "Failed to replace private workset registry {:?}: {}",
            registry_path, error
        )
    })
}

fn read_json_value(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    serde_json::from_reader::<_, Value>(file).ok()
}

fn value_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(|item| item.as_str()).unwrap_or("")
}

fn shell_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn relative_pilot_asset_path(dataset_dir: &Path, asset: &Value) -> String {
    let mirrored = asset.get("mirrored_asset").unwrap_or(&Value::Null);
    let source = asset.get("source_asset").unwrap_or(&Value::Null);
    let local_path = value_str(mirrored, "local_path");
    if !local_path.is_empty() {
        let local = PathBuf::from(local_path);
        if let Ok(relative) = local.strip_prefix(dataset_dir.join("data")) {
            return relative.to_string_lossy().into_owned();
        }
    }
    value_str(source, "repository_path").to_string()
}

fn find_manifest_asset<'a>(
    manifest: &'a Value,
    key: &str,
    relative_path: &str,
) -> Option<&'a Value> {
    manifest
        .get(key)
        .and_then(|items| items.as_array())
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("relative_path").and_then(|value| value.as_str()) == Some(relative_path)
            })
        })
}

fn find_derivative<'a>(derivatives: &'a [Value], relative_path: &str) -> Option<&'a Value> {
    derivatives.iter().find(|item| {
        item.get("source_relative_path")
            .and_then(|value| value.as_str())
            == Some(relative_path)
    })
}

fn empty_index_queue_totals() -> Value {
    serde_json::json!({
        "datasets": 0,
        "assets": 0,
        "indexed": 0,
        "ready_for_conversion": 0,
        "ready_for_slice_cache": 0,
        "slice_cache_indexed": 0,
        "blocked": 0,
        "sidecars": 0
    })
}

fn pilot_index_queue_payload() -> Value {
    let root = get_public_data_root();
    let mut datasets = Vec::new();
    let mut totals = empty_index_queue_totals();

    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => {
            return serde_json::json!({
                "root": root.to_string_lossy(),
                "root_exists": root.exists(),
                "summary": totals,
                "datasets": []
            });
        }
    };

    for entry in entries.flatten() {
        let dataset_dir = entry.path();
        if !dataset_dir.is_dir() {
            continue;
        }
        let metadata_dir = dataset_dir.join("metadata");
        let state_path = metadata_dir.join("asset-state-manifest.json");
        if !state_path.exists() {
            continue;
        }

        let state = match read_json_value(&state_path) {
            Some(value) => value,
            None => continue,
        };
        let readiness = read_json_value(&metadata_dir.join("conversion-readiness-manifest.json"))
            .unwrap_or_else(|| serde_json::json!({}));
        let derivative_manifest = read_json_value(&metadata_dir.join("derivative-manifest.json"))
            .unwrap_or_else(|| serde_json::json!({ "derivatives": [] }));
        let derivatives = derivative_manifest
            .get("derivatives")
            .and_then(|items| items.as_array())
            .cloned()
            .unwrap_or_default();
        let dataset = state
            .get("dataset")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let slug = dataset_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string();

        let mut assets_out = Vec::new();
        let assets = state
            .get("assets")
            .and_then(|items| items.as_array())
            .cloned()
            .unwrap_or_default();

        for asset in assets {
            let mirrored = asset
                .get("mirrored_asset")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let volume = asset
                .get("validated_volume")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let streamable = asset
                .get("streamable_derivative")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let slice_cache = asset
                .get("browser_slice_cache")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let relative_path = relative_pilot_asset_path(&dataset_dir, &asset);
            let derivative = find_derivative(&derivatives, &relative_path).cloned();
            let ready_conversion =
                find_manifest_asset(&readiness, "ready_assets", &relative_path).cloned();
            let slice_supported = ready_conversion
                .as_ref()
                .and_then(|ready| ready.get("format").and_then(|format| format.as_str()))
                .map(|format| matches!(format, "TIFF" | "MRC" | "TIFF_SERIES"))
                .unwrap_or(false);
            let slice_cached = value_str(&slice_cache, "state") == "ready";
            let format = value_str(&mirrored, "format").to_string();
            let volume_state = value_str(&volume, "state").to_string();
            let indexed = derivative.is_some();
            let converter_supported = ready_conversion
                .as_ref()
                .and_then(|ready| ready.get("format").and_then(|format| format.as_str()))
                == Some("TIFF");
            let status = if indexed {
                "indexed"
            } else if converter_supported {
                "ready_for_conversion"
            } else if slice_cached {
                "slice_cache_indexed"
            } else if slice_supported {
                "slice_cache_ready"
            } else if volume_state == "not_applicable" {
                "sidecar"
            } else {
                "needs_review"
            };

            if let Some(value) = totals.get_mut("assets").and_then(|value| value.as_i64()) {
                totals["assets"] = serde_json::json!(value + 1);
            }
            let counter = match status {
                "indexed" => "indexed",
                "ready_for_conversion" => "ready_for_conversion",
                "slice_cache_ready" => "ready_for_slice_cache",
                "slice_cache_indexed" => "slice_cache_indexed",
                "sidecar" => "sidecars",
                _ => "blocked",
            };
            let current = totals
                .get(counter)
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            totals[counter] = serde_json::json!(current + 1);

            let convert_command = if converter_supported && !indexed {
                Some(format!(
                    "python3 workers/ingestion/public_data_pilot.py convert {} --root {} --asset {}",
                    shell_quote(&slug),
                    shell_quote(&root.to_string_lossy()),
                    shell_quote(&relative_path)
                ))
            } else {
                None
            };
            let slice_command = if slice_supported && !slice_cached && !indexed {
                Some(format!(
                    "python3 workers/ingestion/public_data_pilot.py slices {} --root {} --asset {}",
                    shell_quote(&slug),
                    shell_quote(&root.to_string_lossy()),
                    shell_quote(&relative_path)
                ))
            } else {
                None
            };

            assets_out.push(serde_json::json!({
                "relative_path": relative_path,
                "format": format,
                "size_bytes": mirrored.get("size_bytes").cloned().unwrap_or(Value::Null),
                "validated_state": volume_state,
                "streamable_state": if indexed { "indexed" } else { value_str(&streamable, "state") },
                "slice_cache_state": value_str(&slice_cache, "state"),
                "index_status": status,
                "dimensions": volume.get("dimensions").cloned().unwrap_or(Value::Null),
                "physical_voxel_size_nm": volume.get("physical_voxel_size_nm").cloned().unwrap_or(Value::Null),
                "warnings": volume.get("warnings").cloned().unwrap_or_else(|| serde_json::json!([])),
                "blockers": volume.get("blockers").cloned().unwrap_or_else(|| serde_json::json!([])),
                "review_notes": volume.get("review_notes").cloned().unwrap_or_else(|| serde_json::json!([])),
                "derivative": derivative,
                "convert_command": convert_command,
                "slice_command": slice_command
            }));
        }

        let dataset_total = totals
            .get("datasets")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        totals["datasets"] = serde_json::json!(dataset_total + 1);
        datasets.push(serde_json::json!({
            "slug": slug,
            "dataset": dataset,
            "readiness": readiness.get("summary").cloned().unwrap_or(Value::Null),
            "derivative_count": derivatives.len(),
            "assets": assets_out
        }));
    }

    serde_json::json!({
        "root": root.to_string_lossy(),
        "root_exists": root.exists(),
        "summary": totals,
        "datasets": datasets
    })
}

fn canonical_workset_path(raw: &str) -> Result<PathBuf, String> {
    let mut path = PathBuf::from(raw);
    if path.is_dir() {
        path = path.join("workset.json");
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve workset path {}: {}", raw, error))?;
    if path.file_name().and_then(|value| value.to_str()) != Some("workset.json") {
        return Err(
            "Private workset registration requires workset.json or its directory.".to_string(),
        );
    }
    Ok(path)
}

fn read_workset_jsonl_assets(path: &Path) -> Result<Vec<Value>, String> {
    let assets_path = path
        .parent()
        .ok_or_else(|| "Could not resolve workset directory.".to_string())?
        .join("workset-assets.jsonl");
    let file = File::open(&assets_path)
        .map_err(|error| format!("Could not open {:?}: {}", assets_path, error))?;
    let mut assets = Vec::new();
    let mut seen_asset_ids = BTreeSet::new();
    for (index, line) in StdBufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| format!("Could not read {:?}: {}", assets_path, error))?;
        if line.trim().is_empty() {
            continue;
        }
        let asset: Value = serde_json::from_str(&line).map_err(|error| {
            format!(
                "Invalid workset asset JSON at {:?}:{}: {}",
                assets_path,
                index + 1,
                error
            )
        })?;
        if value_str(&asset, "schema") != "cell-anatomy-archive-workset-asset"
            || asset.get("schema_version").and_then(|value| value.as_u64()) != Some(1)
            || value_str(&asset, "asset_id").is_empty()
            || value_str(&asset, "relative_path").is_empty()
        {
            return Err(format!(
                "Unsupported or incomplete workset asset at {:?}:{}.",
                assets_path,
                index + 1
            ));
        }
        if !seen_asset_ids.insert(value_str(&asset, "asset_id").to_string()) {
            return Err(format!(
                "Duplicate workset asset id at {:?}:{}.",
                assets_path,
                index + 1
            ));
        }
        if assets.len() >= MAX_PRIVATE_WORKSET_ASSETS {
            return Err(format!(
                "Private worksets are capped at {} assets.",
                MAX_PRIVATE_WORKSET_ASSETS
            ));
        }
        assets.push(asset);
    }
    Ok(assets)
}

fn private_workset_slug(workset: &Value) -> Result<String, String> {
    let archive_id = workset
        .get("source_registry")
        .and_then(|value| value.get("archive_id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("archive");
    let workset_id = workset
        .get("workset_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Workset is missing workset_id.".to_string())?;
    Ok(format!("private-workset:{}:{}", archive_id, workset_id))
}

fn private_workset_derivatives(path: &Path) -> Result<Vec<Value>, String> {
    let manifest_path = match path.parent() {
        Some(parent) => parent.join("workset-derivatives.json"),
        None => return Ok(Vec::new()),
    };
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }
    let manifest = read_json_value(&manifest_path).ok_or_else(|| {
        format!(
            "Could not read private derivative manifest at {:?}.",
            manifest_path
        )
    })?;
    if value_str(&manifest, "schema") != "cell-anatomy-workset-derivative-manifest"
        || manifest
            .get("schema_version")
            .and_then(|value| value.as_u64())
            != Some(1)
    {
        return Err("Unsupported private derivative manifest schema.".to_string());
    }
    let derivatives = manifest
        .get("derivatives")
        .and_then(|value| value.as_array())
        .cloned()
        .ok_or_else(|| "Private derivative manifest is missing derivatives.".to_string())?;
    let workset_dir = path
        .parent()
        .ok_or_else(|| "Could not resolve workset directory.".to_string())?;
    let allowed_root = workset_dir
        .join("derivatives")
        .canonicalize()
        .map_err(|error| format!("Could not resolve private derivatives directory: {}", error))?;
    for derivative in &derivatives {
        if value_str(derivative, "schema") != "cell-anatomy-workset-derivative"
            || derivative
                .get("schema_version")
                .and_then(|value| value.as_u64())
                != Some(1)
        {
            return Err("Unsupported private derivative schema.".to_string());
        }
        let output_path = PathBuf::from(value_str(derivative, "output_path"));
        let canonical = output_path.canonicalize().map_err(|error| {
            format!(
                "Could not resolve private derivative {:?}: {}",
                output_path, error
            )
        })?;
        if !canonical.is_dir() || canonical.strip_prefix(&allowed_root).is_err() {
            return Err(format!(
                "Private derivative path escapes its workset: {:?}.",
                output_path
            ));
        }
    }
    Ok(derivatives)
}

fn private_workset_dataset_payload(path: &Path) -> Result<Value, String> {
    let workset = read_json_value(path)
        .ok_or_else(|| format!("Could not read private workset summary at {:?}.", path))?;
    if value_str(&workset, "schema") != "cell-anatomy-archive-workset"
        || workset
            .get("schema_version")
            .and_then(|value| value.as_u64())
            != Some(1)
    {
        return Err("Unsupported private workset schema.".to_string());
    }
    let slug = private_workset_slug(&workset)?;
    let assets = read_workset_jsonl_assets(path)?;
    let derivatives = private_workset_derivatives(path)?;
    let mut assets_out = Vec::new();
    let mut indexed = 0usize;
    let mut ready = 0usize;
    let mut blocked = 0usize;
    let mut viewable_derivatives = Vec::new();

    for asset in assets {
        let asset_id = value_str(&asset, "asset_id");
        let relative_path = value_str(&asset, "relative_path");
        let metadata = asset.get("metadata").cloned().unwrap_or(Value::Null);
        let readiness = asset.get("readiness").cloned().unwrap_or(Value::Null);
        let status = asset.get("status").cloned().unwrap_or(Value::Null);
        let promotion = asset.get("promotion").cloned().unwrap_or(Value::Null);
        let format = value_str(&metadata, "format").to_ascii_uppercase();
        let dtype = value_str(&metadata, "dtype");
        let existing = derivatives
            .iter()
            .find(|item| value_str(item, "asset_id") == asset_id);
        let can_convert = status
            .get("allowed_operations")
            .and_then(|value| value.get("can_convert"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let can_view = status
            .get("allowed_operations")
            .and_then(|value| value.get("can_view_in_caos"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let conversion_ready = readiness
            .get("conversion_ready")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let no_blockers = readiness
            .get("blockers")
            .and_then(|value| value.as_array())
            .map(|values| values.is_empty())
            .unwrap_or(true);
        let conversion_blocked = promotion
            .get("blocked_operations")
            .and_then(|value| value.as_array())
            .map(|values| values.iter().any(|value| value.as_str() == Some("convert")))
            .unwrap_or(false);
        let supported = match format.as_str() {
            "TIFF" => matches!(dtype, "uint8" | "uint16"),
            "MRC" => matches!(dtype, "int8" | "int16" | "uint16"),
            _ => false,
        };
        let converter_available =
            can_convert && conversion_ready && no_blockers && !conversion_blocked && supported;
        let index_status = if existing.is_some() {
            indexed += 1;
            if can_view {
                if let Some(derivative) = existing.cloned() {
                    viewable_derivatives.push(derivative);
                }
            }
            "indexed"
        } else if converter_available {
            ready += 1;
            "ready_for_conversion"
        } else {
            blocked += 1;
            "needs_review"
        };
        let convert_command = (converter_available && existing.is_none()).then(|| {
            format!(
                "python3 workers/ingestion/private_workset_derivative.py convert --workset {} --asset-id {}",
                shell_quote(&path.to_string_lossy()),
                shell_quote(asset_id)
            )
        });
        assets_out.push(serde_json::json!({
            "relative_path": relative_path,
            "asset_id": asset_id,
            "format": format,
            "size_bytes": asset.get("size_bytes").cloned().unwrap_or(Value::Null),
            "validated_state": if conversion_ready { "validated" } else { "needs_review" },
            "streamable_state": if existing.is_some() { "indexed" } else { "" },
            "slice_cache_state": "",
            "index_status": index_status,
            "dimensions": metadata.get("dimensions").cloned().unwrap_or(Value::Null),
            "physical_voxel_size_nm": metadata.get("voxel_size_nm").cloned().unwrap_or(Value::Null),
            "warnings": [],
            "blockers": readiness.get("blockers").cloned().unwrap_or_else(|| serde_json::json!([])),
            "review_notes": asset.get("review").and_then(|value| value.get("recommended_actions")).cloned().unwrap_or_else(|| serde_json::json!([])),
            "derivative": if can_view { existing.cloned() } else { None },
            "convert_command": convert_command,
            "slice_command": Value::Null,
            "queue_source": "private-workset",
            "workset_path": path.to_string_lossy()
        }));
    }

    let title = workset
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| workset.get("workset_id").and_then(|value| value.as_str()))
        .unwrap_or(&slug);
    let archive_id = workset
        .get("source_registry")
        .and_then(|value| value.get("archive_id"))
        .and_then(|value| value.as_str())
        .unwrap_or("archive");
    let workset_id = value_str(&workset, "workset_id");
    Ok(serde_json::json!({
        "slug": slug,
        "archive_id": archive_id,
        "workset_id": workset_id,
        "dataset": {
            "source": "Private Workset",
            "entry_id": value_str(&workset, "workset_id"),
            "title": title,
            "experiment_type": "Promoted archive workset"
        },
        "readiness": {
            "total_assets": assets_out.len(),
            "ready_assets": ready,
            "blocked_assets": blocked,
            "status": if ready > 0 || indexed > 0 { "ready" } else { "blocked" }
        },
        "derivative_count": indexed,
        "assets": assets_out,
        "derivatives": viewable_derivatives,
        "findings": workset.get("findings").cloned().unwrap_or_else(|| serde_json::json!([])),
        "queue_source": "private-workset",
        "workset_path": path.to_string_lossy()
    }))
}

fn increment_index_total(totals: &mut Value, key: &str, amount: u64) {
    let current = totals
        .get(key)
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    totals[key] = serde_json::json!(current + amount);
}

fn combined_index_queue_payload(private_worksets: &Arc<Mutex<BTreeMap<String, PathBuf>>>) -> Value {
    let public = pilot_index_queue_payload();
    let mut datasets = public
        .get("datasets")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut totals = public
        .get("summary")
        .cloned()
        .unwrap_or_else(empty_index_queue_totals);
    let paths = private_worksets
        .lock()
        .map(|worksets| worksets.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for path in paths {
        let Ok(dataset) = private_workset_dataset_payload(&path) else {
            continue;
        };
        let readiness = dataset.get("readiness").cloned().unwrap_or(Value::Null);
        increment_index_total(&mut totals, "datasets", 1);
        increment_index_total(
            &mut totals,
            "assets",
            readiness
                .get("total_assets")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
        );
        increment_index_total(
            &mut totals,
            "indexed",
            dataset
                .get("derivative_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
        );
        increment_index_total(
            &mut totals,
            "ready_for_conversion",
            readiness
                .get("ready_assets")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
        );
        increment_index_total(
            &mut totals,
            "blocked",
            readiness
                .get("blocked_assets")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
        );
        datasets.retain(|existing| value_str(existing, "slug") != value_str(&dataset, "slug"));
        datasets.push(dataset);
    }
    let public_root_exists = public
        .get("root_exists")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    serde_json::json!({
        "root": public.get("root").cloned().unwrap_or(Value::String(String::new())),
        "root_exists": public_root_exists || !datasets.is_empty(),
        "summary": totals,
        "datasets": datasets
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn unique_local_id(prefix: &str) -> String {
    format!(
        "{}_{}_{}",
        prefix,
        now_ms(),
        LOCAL_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn json_response(status: StatusCode, payload: Value) -> axum::response::Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&payload).unwrap(),
    )
        .into_response()
}

fn get_repo_root() -> PathBuf {
    for key in ["CELL_ANATOMY_REPO_ROOT", "SCION_REPO_ROOT"] {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from(value);
            if path.exists() {
                return path;
            }
        }
    }

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("workers/ingestion/public_data_pilot.py").exists() {
        return cwd;
    }
    for ancestor in cwd.ancestors() {
        if ancestor
            .join("workers/ingestion/public_data_pilot.py")
            .exists()
        {
            return ancestor.to_path_buf();
        }
    }
    cwd
}

fn normalize_index_job_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "convert" => Some("convert"),
        "slice" | "slices" | "slice-cache" | "slice_cache" => Some("slices"),
        _ => None,
    }
}

fn resolve_index_job_command(
    request: &StartIndexJobRequest,
    private_worksets: &Arc<Mutex<BTreeMap<String, PathBuf>>>,
) -> Result<(String, Vec<String>, String, PathBuf), String> {
    let kind = normalize_index_job_kind(&request.kind)
        .ok_or_else(|| "Unsupported index job kind. Use convert or slices.".to_string())?;
    let queue = combined_index_queue_payload(private_worksets);
    if !queue
        .get("root_exists")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Err(format!(
            "Public data root not found: {}",
            queue
                .get("root")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        ));
    }

    let datasets = queue
        .get("datasets")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Index queue payload did not include datasets.".to_string())?;
    let dataset = datasets
        .iter()
        .find(|dataset| value_str(dataset, "slug") == request.dataset_slug)
        .ok_or_else(|| format!("Dataset not found in index queue: {}", request.dataset_slug))?;
    let assets = dataset
        .get("assets")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Dataset has no asset list in the index queue.".to_string())?;
    let asset = assets
        .iter()
        .find(|asset| value_str(asset, "relative_path") == request.asset_relative_path)
        .ok_or_else(|| {
            format!(
                "Asset not found in index queue: {}",
                request.asset_relative_path
            )
        })?;

    let command_key = if kind == "convert" {
        "convert_command"
    } else {
        "slice_command"
    };
    let command_available = asset
        .get(command_key)
        .and_then(|value| value.as_str())
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    if !command_available {
        return Err(format!(
            "{} is not currently available for {} ({})",
            if kind == "convert" {
                "Conversion"
            } else {
                "Slice-cache generation"
            },
            request.asset_relative_path,
            value_str(asset, "index_status")
        ));
    }

    let repo_root = get_repo_root();
    let script_path = repo_root.join("workers/ingestion/public_data_pilot.py");
    if !script_path.exists() {
        return Err(format!(
            "Pilot ingestion script not found at {}. Set CELL_ANATOMY_REPO_ROOT to the repository root.",
            script_path.to_string_lossy()
        ));
    }

    let queue_source = value_str(dataset, "queue_source");
    let (command, command_display) = if queue_source == "private-workset" {
        if kind != "convert" {
            return Err("Private worksets currently support conversion jobs only.".to_string());
        }
        let private_script = repo_root.join("workers/ingestion/private_workset_derivative.py");
        if !private_script.exists() {
            return Err(format!(
                "Private workset derivative script not found at {}.",
                private_script.to_string_lossy()
            ));
        }
        let workset_path = value_str(dataset, "workset_path").to_string();
        let asset_id = value_str(asset, "asset_id").to_string();
        if workset_path.is_empty() || asset_id.is_empty() {
            return Err(
                "Private workset queue entry is missing workset_path or asset_id.".to_string(),
            );
        }
        (
            vec![
                "python3".to_string(),
                private_script.to_string_lossy().to_string(),
                "convert".to_string(),
                "--workset".to_string(),
                workset_path.clone(),
                "--asset-id".to_string(),
                asset_id.clone(),
            ],
            format!(
                "python3 workers/ingestion/private_workset_derivative.py convert --workset {} --asset-id {}",
                shell_quote(&workset_path),
                shell_quote(&asset_id)
            ),
        )
    } else {
        let root = queue
            .get("root")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        (
            vec![
                "python3".to_string(),
                script_path.to_string_lossy().to_string(),
                kind.to_string(),
                request.dataset_slug.clone(),
                "--root".to_string(),
                root.clone(),
                "--asset".to_string(),
                request.asset_relative_path.clone(),
            ],
            format!(
                "python3 workers/ingestion/public_data_pilot.py {} {} --root {} --asset {}",
                kind,
                shell_quote(&request.dataset_slug),
                shell_quote(&root),
                shell_quote(&request.asset_relative_path)
            ),
        )
    };

    Ok((kind.to_string(), command, command_display, repo_root))
}

fn latest_index_job_status(
    jobs: &BTreeMap<String, IndexJobRecord>,
    kind: &str,
    dataset_slug: &str,
    asset_relative_path: &str,
) -> Option<String> {
    jobs.values()
        .filter(|job| {
            job.kind == kind
                && job.dataset_slug == dataset_slug
                && job.asset_relative_path == asset_relative_path
        })
        .max_by_key(|job| job.created_at_ms)
        .map(|job| job.status.clone())
}

fn is_active_index_status(status: &str) -> bool {
    matches!(status, "queued" | "running" | "cancel_requested")
}

fn command_key_for_index_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "convert" => Some("convert_command"),
        "slices" => Some("slice_command"),
        _ => None,
    }
}

fn build_index_batch_plan(
    queue: &Value,
    jobs: &BTreeMap<String, IndexJobRecord>,
    request: &IndexBatchPlanRequest,
) -> Result<Value, String> {
    let kind = normalize_index_job_kind(&request.kind)
        .ok_or_else(|| "Unsupported index job kind. Use convert or slices.".to_string())?;
    let command_key = command_key_for_index_kind(kind)
        .ok_or_else(|| "Unsupported index job kind. Use convert or slices.".to_string())?;
    if !queue
        .get("root_exists")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Err(format!(
            "Public data root not found: {}",
            queue
                .get("root")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        ));
    }

    let total_limit = request.total_limit.unwrap_or(5).clamp(1, 50);
    let per_dataset_limit = request
        .per_dataset_limit
        .unwrap_or(total_limit)
        .clamp(1, total_limit);
    let retry_failed = request.retry_failed.unwrap_or(false);
    let skip_completed = request.skip_completed.unwrap_or(true);
    let dataset_filter = request
        .dataset_slug
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let datasets = queue
        .get("datasets")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Index queue payload did not include datasets.".to_string())?;
    let mut sorted_datasets: Vec<&Value> = datasets.iter().collect();
    sorted_datasets.sort_by(|left, right| value_str(left, "slug").cmp(value_str(right, "slug")));

    let mut candidate_count = 0usize;
    let mut skipped_active = 0usize;
    let mut skipped_completed = 0usize;
    let mut skipped_previous_failed = 0usize;
    let mut skipped_limit = 0usize;
    let mut planned_items = Vec::new();
    let mut dataset_counts: BTreeMap<String, usize> = BTreeMap::new();

    for dataset in sorted_datasets {
        let slug = value_str(dataset, "slug").to_string();
        if let Some(filter) = dataset_filter {
            if slug != filter {
                continue;
            }
        }
        let dataset_title = dataset
            .get("dataset")
            .and_then(|metadata| metadata.get("title"))
            .and_then(|value| value.as_str())
            .unwrap_or(&slug)
            .to_string();
        let assets = dataset
            .get("assets")
            .and_then(|value| value.as_array())
            .ok_or_else(|| format!("Dataset {} has no asset list in the index queue.", slug))?;

        for asset in assets {
            let command_display = asset
                .get(command_key)
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty());
            let Some(command_display) = command_display else {
                continue;
            };
            candidate_count += 1;

            let asset_relative_path = value_str(asset, "relative_path").to_string();
            let existing_status = latest_index_job_status(jobs, kind, &slug, &asset_relative_path);
            if existing_status
                .as_deref()
                .map(is_active_index_status)
                .unwrap_or(false)
            {
                skipped_active += 1;
                continue;
            }
            if skip_completed && existing_status.as_deref() == Some("completed") {
                skipped_completed += 1;
                continue;
            }
            if matches!(existing_status.as_deref(), Some("failed" | "cancelled")) && !retry_failed {
                skipped_previous_failed += 1;
                continue;
            }
            let dataset_count = dataset_counts.get(&slug).copied().unwrap_or(0);
            if planned_items.len() >= total_limit || dataset_count >= per_dataset_limit {
                skipped_limit += 1;
                continue;
            }

            dataset_counts.insert(slug.clone(), dataset_count + 1);
            planned_items.push(serde_json::json!({
                "kind": kind,
                "dataset_slug": slug,
                "dataset_title": dataset_title,
                "asset_relative_path": asset_relative_path,
                "format": asset.get("format").cloned().unwrap_or(Value::Null),
                "size_bytes": asset.get("size_bytes").cloned().unwrap_or(Value::Null),
                "dimensions": asset.get("dimensions").cloned().unwrap_or(Value::Null),
                "index_status": value_str(asset, "index_status"),
                "existing_job_status": existing_status,
                "command_display": command_display,
                "start_request": {
                    "kind": kind,
                    "dataset_slug": value_str(dataset, "slug"),
                    "asset_relative_path": value_str(asset, "relative_path")
                }
            }));
        }
    }

    let plan_id = format!("index_batch_plan_{}", now_ms());
    Ok(serde_json::json!({
        "plan_id": plan_id,
        "created_at_ms": now_ms(),
        "root": queue.get("root").cloned().unwrap_or(Value::Null),
        "kind": kind,
        "dataset_slug": dataset_filter,
        "total_limit": total_limit,
        "per_dataset_limit": per_dataset_limit,
        "retry_failed": retry_failed,
        "skip_completed": skip_completed,
        "summary": {
            "candidate_count": candidate_count,
            "planned_count": planned_items.len(),
            "skipped_active": skipped_active,
            "skipped_completed": skipped_completed,
            "skipped_previous_failed": skipped_previous_failed,
            "skipped_limit": skipped_limit,
            "datasets": dataset_counts.len()
        },
        "items": planned_items,
        "checkpoint": {
            "schema": "cell-anatomy-index-batch-plan",
            "schema_version": 1,
            "plan_id": plan_id,
            "kind": kind,
            "dataset_slug": dataset_filter,
            "total_limit": total_limit,
            "per_dataset_limit": per_dataset_limit,
            "retry_failed": retry_failed,
            "skip_completed": skip_completed,
            "planned_keys": planned_items.iter().map(|item| {
                serde_json::json!({
                    "dataset_slug": item.get("dataset_slug").cloned().unwrap_or(Value::Null),
                    "asset_relative_path": item.get("asset_relative_path").cloned().unwrap_or(Value::Null)
                })
            }).collect::<Vec<_>>()
        }
    }))
}

fn summarize_index_batch_items(items: &[IndexBatchRunItem]) -> IndexBatchRunSummary {
    let mut summary = IndexBatchRunSummary {
        total: items.len(),
        pending: 0,
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
    };

    for item in items {
        match item.status.as_str() {
            "pending" => summary.pending += 1,
            "queued" => summary.queued += 1,
            "running" | "cancel_requested" => summary.running += 1,
            "completed" => summary.completed += 1,
            "failed" => summary.failed += 1,
            "cancelled" => summary.cancelled += 1,
            _ => summary.pending += 1,
        }
    }

    summary
}

fn is_active_batch_run_status(status: &str) -> bool {
    matches!(status, "queued" | "running" | "cancel_requested")
}

fn is_terminal_batch_run_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn persist_index_batch_run(record: &IndexBatchRunRecord) -> Result<(), String> {
    let path = PathBuf::from(&record.checkpoint_path);
    let parent = path
        .parent()
        .ok_or_else(|| "Index batch checkpoint path has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|err| {
        format!(
            "Failed to create batch checkpoint directory {:?}: {}",
            parent, err
        )
    })?;
    let mut file = File::create(&path)
        .map_err(|err| format!("Failed to create batch checkpoint {:?}: {}", path, err))?;
    let payload = serde_json::to_string_pretty(record)
        .map_err(|err| format!("Failed to serialize batch checkpoint: {}", err))?;
    file.write_all(payload.as_bytes())
        .map_err(|err| format!("Failed to write batch checkpoint {:?}: {}", path, err))
}

fn load_index_batch_runs() -> BTreeMap<String, IndexBatchRunRecord> {
    let dir = get_index_batch_runs_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return BTreeMap::new(),
    };
    let mut runs = BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(err) => {
                eprintln!("Failed to open batch checkpoint {:?}: {}", path, err);
                continue;
            }
        };
        let mut record = match serde_json::from_reader::<_, IndexBatchRunRecord>(file) {
            Ok(record) => record,
            Err(err) => {
                eprintln!("Failed to parse batch checkpoint {:?}: {}", path, err);
                continue;
            }
        };
        if record.checkpoint_path.trim().is_empty() {
            record.checkpoint_path = path.to_string_lossy().into_owned();
        }
        if is_active_batch_run_status(&record.status) {
            let loaded_at = now_ms();
            record.status = "paused".to_string();
            record.updated_at_ms = loaded_at;
            record.finished_at_ms = None;
            record.log.push(
                "Loaded persisted checkpoint; resume to continue interrupted work.".to_string(),
            );
            for item in &mut record.items {
                if is_active_index_status(&item.status) {
                    item.status = "pending".to_string();
                    item.job_id = None;
                    item.started_at_ms = None;
                    item.finished_at_ms = None;
                    item.error =
                        Some("Interrupted before completion; resume required.".to_string());
                }
            }
            record.summary = summarize_index_batch_items(&record.items);
            if let Err(err) = persist_index_batch_run(&record) {
                eprintln!(
                    "Failed to persist paused batch checkpoint {:?}: {}",
                    path, err
                );
            }
        }
        runs.insert(record.id.clone(), record);
    }
    runs
}

fn batch_plan_item_start_request(item: &Value) -> Result<StartIndexJobRequest, String> {
    let start_request = item.get("start_request").unwrap_or(item);
    let kind = start_request
        .get("kind")
        .and_then(|value| value.as_str())
        .or_else(|| item.get("kind").and_then(|value| value.as_str()))
        .ok_or_else(|| "Batch plan item is missing kind.".to_string())?;
    let kind = normalize_index_job_kind(kind).ok_or_else(|| {
        "Batch plan item has unsupported kind. Use convert or slices.".to_string()
    })?;
    let dataset_slug = start_request
        .get("dataset_slug")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Batch plan item is missing dataset_slug.".to_string())?;
    let asset_relative_path = start_request
        .get("asset_relative_path")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Batch plan item is missing asset_relative_path.".to_string())?;

    Ok(StartIndexJobRequest {
        kind: kind.to_string(),
        dataset_slug: dataset_slug.to_string(),
        asset_relative_path: asset_relative_path.to_string(),
    })
}

fn build_index_batch_run_from_plan(
    plan: &Value,
    concurrency: Option<usize>,
) -> Result<IndexBatchRunRecord, String> {
    let plan_id = plan
        .get("plan_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Batch run request is missing plan_id.".to_string())?
        .to_string();
    let kind = plan
        .get("kind")
        .and_then(|value| value.as_str())
        .and_then(normalize_index_job_kind)
        .ok_or_else(|| {
            "Batch run request has unsupported kind. Use convert or slices.".to_string()
        })?;
    let root = plan
        .get("root")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let items = plan
        .get("items")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Batch run request is missing plan items.".to_string())?;
    if items.is_empty() {
        return Err("Batch run request has no plan items.".to_string());
    }

    let mut run_items = Vec::with_capacity(items.len());
    for item in items {
        let request = batch_plan_item_start_request(item)?;
        if request.kind != kind {
            return Err("Batch run plan mixes job kinds; build one run per kind.".to_string());
        }
        run_items.push(IndexBatchRunItem {
            kind: request.kind,
            dataset_slug: request.dataset_slug,
            dataset_title: item
                .get("dataset_title")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            asset_relative_path: request.asset_relative_path,
            command_display: item
                .get("command_display")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            status: "pending".to_string(),
            job_id: None,
            existing_job_status: item
                .get("existing_job_status")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
            started_at_ms: None,
            finished_at_ms: None,
            error: None,
        });
    }

    let run_id = unique_local_id("index_batch_run");
    let created_at_ms = now_ms();
    let mut record = IndexBatchRunRecord {
        id: run_id.clone(),
        plan_id,
        kind: kind.to_string(),
        root,
        status: "queued".to_string(),
        concurrency: concurrency.unwrap_or(1).clamp(1, 8),
        created_at_ms,
        updated_at_ms: created_at_ms,
        finished_at_ms: None,
        checkpoint_path: get_index_batch_run_path(&run_id)
            .to_string_lossy()
            .into_owned(),
        summary: IndexBatchRunSummary {
            total: 0,
            pending: 0,
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
        },
        items: run_items,
        log: Vec::new(),
        error: None,
    };
    record.summary = summarize_index_batch_items(&record.items);
    record.log.push(format!(
        "Queued persisted batch run with {} item{} at concurrency {}.",
        record.summary.total,
        if record.summary.total == 1 { "" } else { "s" },
        record.concurrency
    ));
    Ok(record)
}

fn reconcile_index_batch_items(
    record: &mut IndexBatchRunRecord,
    jobs: &BTreeMap<String, IndexJobRecord>,
) {
    for item in &mut record.items {
        if !is_active_index_status(&item.status) {
            continue;
        }
        let Some(job_id) = item.job_id.as_ref() else {
            continue;
        };
        let Some(job) = jobs.get(job_id) else {
            continue;
        };
        item.status = job.status.clone();
        item.started_at_ms = job.started_at_ms.or(item.started_at_ms);
        if !is_active_index_status(&job.status) {
            item.finished_at_ms = job.finished_at_ms.or_else(|| Some(now_ms()));
            item.error = job.error.clone();
        }
    }
}

fn prepare_index_batch_resume(
    record: &mut IndexBatchRunRecord,
    retry_failed: bool,
) -> Result<(), String> {
    if is_active_batch_run_status(&record.status) {
        return Err(format!("Cannot resume a {} batch run.", record.status));
    }

    let mut pending_count = 0usize;
    for item in &mut record.items {
        let should_resume = matches!(
            item.status.as_str(),
            "pending" | "queued" | "running" | "cancel_requested"
        ) || (retry_failed
            && matches!(item.status.as_str(), "failed" | "cancelled"));
        if should_resume {
            item.status = "pending".to_string();
            item.job_id = None;
            item.started_at_ms = None;
            item.finished_at_ms = None;
            item.error = None;
            pending_count += 1;
        }
    }

    if pending_count == 0 {
        return Err("Batch run has no pending items to resume.".to_string());
    }

    let resumed_at = now_ms();
    record.status = "queued".to_string();
    record.updated_at_ms = resumed_at;
    record.finished_at_ms = None;
    record.error = None;
    record.summary = summarize_index_batch_items(&record.items);
    record.log.push(format!(
        "Resume requested for {} item{}{}.",
        pending_count,
        if pending_count == 1 { "" } else { "s" },
        if retry_failed {
            " including failed or cancelled work"
        } else {
            ""
        }
    ));
    Ok(())
}

fn append_index_job_log(
    jobs: &Arc<Mutex<BTreeMap<String, IndexJobRecord>>>,
    job_id: &str,
    line: String,
) {
    if line.trim().is_empty() {
        return;
    }
    if let Ok(mut guard) = jobs.lock() {
        if let Some(job) = guard.get_mut(job_id) {
            job.log.push(line);
            if job.log.len() > 300 {
                let drop_count = job.log.len() - 300;
                job.log.drain(0..drop_count);
            }
        }
    }
}

fn update_index_job<F>(
    jobs: &Arc<Mutex<BTreeMap<String, IndexJobRecord>>>,
    job_id: &str,
    mut updater: F,
) where
    F: FnMut(&mut IndexJobRecord),
{
    if let Ok(mut guard) = jobs.lock() {
        if let Some(job) = guard.get_mut(job_id) {
            updater(job);
        }
    }
}

fn start_index_job(
    state: &AppState,
    request: StartIndexJobRequest,
) -> Result<IndexJobRecord, String> {
    let (kind, command, command_display, repo_root) =
        resolve_index_job_command(&request, &state.private_worksets)?;
    let id = unique_local_id("index_job");
    let record = IndexJobRecord {
        id: id.clone(),
        kind,
        dataset_slug: request.dataset_slug,
        asset_relative_path: request.asset_relative_path,
        status: "queued".to_string(),
        created_at_ms: now_ms(),
        started_at_ms: None,
        finished_at_ms: None,
        exit_code: None,
        pid: None,
        command: command.clone(),
        command_display,
        log: vec!["Queued local index job.".to_string()],
        error: None,
    };

    {
        let mut guard = state
            .index_jobs
            .lock()
            .map_err(|_| "Index job registry is unavailable.".to_string())?;
        guard.insert(id.clone(), record.clone());
    }

    let jobs = state.index_jobs.clone();
    tokio::spawn(async move {
        run_index_job(jobs, id, command, repo_root).await;
    });

    Ok(record)
}

fn mark_index_job_cancel_requested(
    jobs: &Arc<Mutex<BTreeMap<String, IndexJobRecord>>>,
    job_id: &str,
) -> Result<Option<u32>, String> {
    let mut guard = jobs
        .lock()
        .map_err(|_| "Index job registry is unavailable.".to_string())?;
    let job = guard
        .get_mut(job_id)
        .ok_or_else(|| "Index job not found.".to_string())?;
    match job.status.as_str() {
        "queued" | "running" => {
            job.status = "cancel_requested".to_string();
            job.log.push("Cancellation requested.".to_string());
            Ok(job.pid)
        }
        "cancel_requested" => Ok(job.pid),
        _ => Err(format!("Cannot cancel a {} job.", job.status)),
    }
}

fn kill_process(pid: u32) {
    let _ = StdCommand::new("kill").arg(pid.to_string()).status();
}

async fn run_index_batch_runner(state: AppState, run_id: String) {
    loop {
        let (child_jobs_to_cancel, terminal) = {
            let jobs_snapshot = state
                .index_jobs
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or_default();
            let mut child_jobs_to_cancel = Vec::new();
            let mut runs = match state.index_batch_runs.lock() {
                Ok(runs) => runs,
                Err(_) => return,
            };
            let Some(record) = runs.get_mut(&run_id) else {
                return;
            };

            reconcile_index_batch_items(record, &jobs_snapshot);
            let checkpoint_at = now_ms();

            if record.status == "cancel_requested" {
                for item in &mut record.items {
                    match item.status.as_str() {
                        "pending" => {
                            item.status = "cancelled".to_string();
                            item.finished_at_ms = Some(checkpoint_at);
                        }
                        "queued" | "running" | "cancel_requested" => {
                            if let Some(job_id) = &item.job_id {
                                item.status = "cancel_requested".to_string();
                                child_jobs_to_cancel.push(job_id.clone());
                            } else {
                                item.status = "cancelled".to_string();
                                item.finished_at_ms = Some(checkpoint_at);
                            }
                        }
                        _ => {}
                    }
                }
            } else {
                record.status = "running".to_string();
                let mut active_count = record
                    .items
                    .iter()
                    .filter(|item| is_active_index_status(&item.status))
                    .count();
                while active_count < record.concurrency {
                    let Some(item_index) = record
                        .items
                        .iter()
                        .position(|item| item.status == "pending")
                    else {
                        break;
                    };

                    let request = {
                        let item = &record.items[item_index];
                        StartIndexJobRequest {
                            kind: item.kind.clone(),
                            dataset_slug: item.dataset_slug.clone(),
                            asset_relative_path: item.asset_relative_path.clone(),
                        }
                    };
                    match start_index_job(&state, request) {
                        Ok(job) => {
                            let item = &mut record.items[item_index];
                            item.status = job.status.clone();
                            item.job_id = Some(job.id.clone());
                            item.started_at_ms = Some(job.created_at_ms);
                            item.finished_at_ms = None;
                            item.error = None;
                            if item.command_display.trim().is_empty() {
                                item.command_display = job.command_display.clone();
                            }
                            record.log.push(format!(
                                "Started {} for {} as {}.",
                                item.kind, item.asset_relative_path, job.id
                            ));
                            active_count += 1;
                        }
                        Err(error) => {
                            let item = &mut record.items[item_index];
                            item.status = "failed".to_string();
                            item.finished_at_ms = Some(now_ms());
                            item.error = Some(error.clone());
                            record.log.push(format!(
                                "Failed to start {} for {}: {}",
                                item.kind, item.asset_relative_path, error
                            ));
                        }
                    }
                }
            }

            record.summary = summarize_index_batch_items(&record.items);
            record.updated_at_ms = now_ms();
            let unfinished =
                record.summary.pending + record.summary.queued + record.summary.running;
            if record.status == "cancel_requested" {
                if unfinished == 0 {
                    record.status = "cancelled".to_string();
                    record.finished_at_ms = Some(record.updated_at_ms);
                    record.log.push("Batch run cancelled.".to_string());
                }
            } else if unfinished == 0 {
                record.finished_at_ms = Some(record.updated_at_ms);
                if record.summary.failed > 0 {
                    record.status = "failed".to_string();
                    record.error = Some(format!(
                        "{} of {} batch item{} failed.",
                        record.summary.failed,
                        record.summary.total,
                        if record.summary.total == 1 { "" } else { "s" }
                    ));
                    record
                        .log
                        .push("Batch run finished with failed items.".to_string());
                } else if record.summary.cancelled > 0 {
                    record.status = "cancelled".to_string();
                    record
                        .log
                        .push("Batch run finished with cancelled items.".to_string());
                } else {
                    record.status = "completed".to_string();
                    record.log.push("Batch run completed.".to_string());
                }
            }

            let terminal = is_terminal_batch_run_status(&record.status);
            if let Err(err) = persist_index_batch_run(record) {
                eprintln!("Failed to persist batch run {}: {}", record.id, err);
            }
            (child_jobs_to_cancel, terminal)
        };

        for job_id in child_jobs_to_cancel {
            if let Ok(pid) = mark_index_job_cancel_requested(&state.index_jobs, &job_id) {
                if let Some(pid) = pid {
                    kill_process(pid);
                }
            }
        }

        if terminal {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
}

async fn read_process_lines<R>(
    jobs: Arc<Mutex<BTreeMap<String, IndexJobRecord>>>,
    job_id: String,
    source: &'static str,
    stream: R,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        append_index_job_log(&jobs, &job_id, format!("{}: {}", source, line));
    }
}

async fn run_index_job(
    jobs: Arc<Mutex<BTreeMap<String, IndexJobRecord>>>,
    job_id: String,
    command: Vec<String>,
    repo_root: PathBuf,
) {
    let should_cancel = {
        let guard = jobs.lock();
        guard
            .ok()
            .and_then(|guard| {
                guard
                    .get(&job_id)
                    .map(|job| job.status == "cancel_requested")
            })
            .unwrap_or(false)
    };
    if should_cancel {
        update_index_job(&jobs, &job_id, |job| {
            job.status = "cancelled".to_string();
            job.finished_at_ms = Some(now_ms());
            job.log.push("Cancelled before process start.".to_string());
        });
        return;
    }

    update_index_job(&jobs, &job_id, |job| {
        job.status = "running".to_string();
        job.started_at_ms = Some(now_ms());
        job.log.push(format!("Starting: {}", job.command_display));
    });

    let mut process = TokioCommand::new(&command[0]);
    process
        .args(&command[1..])
        .current_dir(repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            update_index_job(&jobs, &job_id, |job| {
                job.status = "failed".to_string();
                job.finished_at_ms = Some(now_ms());
                job.error = Some(error.to_string());
                job.log.push(format!("Failed to start process: {}", error));
            });
            return;
        }
    };

    update_index_job(&jobs, &job_id, |job| {
        job.pid = child.id();
        if let Some(pid) = child.id() {
            job.log.push(format!("Process started with pid {}.", pid));
        }
    });

    let stdout_task = child.stdout.take().map(|stdout| {
        tokio::spawn(read_process_lines(
            jobs.clone(),
            job_id.clone(),
            "stdout",
            stdout,
        ))
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        tokio::spawn(read_process_lines(
            jobs.clone(),
            job_id.clone(),
            "stderr",
            stderr,
        ))
    });

    let wait_result = child.wait().await;
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }

    update_index_job(&jobs, &job_id, |job| {
        let was_cancel_requested = job.status == "cancel_requested";
        job.finished_at_ms = Some(now_ms());
        job.pid = None;
        match &wait_result {
            Ok(status) => {
                job.exit_code = status.code();
                if was_cancel_requested {
                    job.status = "cancelled".to_string();
                    job.log.push("Process cancelled.".to_string());
                } else if status.success() {
                    job.status = "completed".to_string();
                    job.log.push("Process completed successfully.".to_string());
                } else {
                    job.status = "failed".to_string();
                    job.error = Some(format!("Process exited with status {}", status));
                    job.log
                        .push(format!("Process exited with status {}.", status));
                }
            }
            Err(error) => {
                job.status = if was_cancel_requested {
                    "cancelled".to_string()
                } else {
                    "failed".to_string()
                };
                job.error = Some(error.to_string());
                job.log.push(format!("Process wait failed: {}", error));
            }
        }
    });
}

fn stable_path_hash(path: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn slugify_path_component(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "local_zarr".to_string()
    } else {
        trimmed
    }
}

fn zarr_dtype_elem_size(dtype: &str) -> Option<usize> {
    match dtype {
        "|u1" | "uint8" => Some(1),
        "<u2" | "uint16" => Some(2),
        _ => None,
    }
}

fn resolve_local_zarr_array(path: &Path) -> Option<(PathBuf, String, PathBuf)> {
    let direct_zarray = path.join(".zarray");
    if direct_zarray.exists() {
        return Some((path.to_path_buf(), ".".to_string(), direct_zarray));
    }

    let multiscale_zarray = path.join("0").join(".zarray");
    if multiscale_zarray.exists() {
        return Some((path.to_path_buf(), "0".to_string(), multiscale_zarray));
    }

    None
}

fn read_zarray_file(zarray_path: &Path) -> Result<Zarray, String> {
    let file = File::open(zarray_path)
        .map_err(|err| format!("Failed to open .zarray {:?}: {}", zarray_path, err))?;
    serde_json::from_reader(file)
        .map_err(|err| format!("Failed to parse .zarray {:?}: {}", zarray_path, err))
}

fn zarray_has_no_filters(filters: &Option<Value>) -> bool {
    match filters {
        None | Some(Value::Null) => true,
        Some(Value::Array(values)) => values.is_empty(),
        _ => false,
    }
}

fn local_zarr_compatibility_report(
    path: &Path,
    array_path: Option<&str>,
    zarray: Option<&Zarray>,
    voxel_size_found: bool,
) -> Value {
    let mut checks = BTreeMap::new();
    checks.insert("path_exists".to_string(), path.exists());
    checks.insert("zarray_found".to_string(), zarray.is_some());

    if let Some(config) = zarray {
        checks.insert("shape_is_3d".to_string(), config.shape.len() == 3);
        checks.insert("chunks_are_3d".to_string(), config.chunks.len() == 3);
        checks.insert(
            "dtype_supported".to_string(),
            zarr_dtype_elem_size(&config.dtype).is_some(),
        );
        checks.insert(
            "uncompressed_chunks".to_string(),
            config
                .compressor
                .as_ref()
                .map_or(true, |compressor| compressor.is_null()),
        );
        checks.insert(
            "filters_supported".to_string(),
            zarray_has_no_filters(&config.filters),
        );
        checks.insert(
            "row_major_order".to_string(),
            config
                .order
                .as_deref()
                .map_or(true, |order| order.eq_ignore_ascii_case("C")),
        );
        checks.insert(
            "dot_chunk_keys".to_string(),
            config
                .dimension_separator
                .as_deref()
                .map_or(true, |separator| separator == "."),
        );
        checks.insert(
            "zarr_v2".to_string(),
            config.zarr_format.map_or(true, |format| format == 2),
        );
    } else {
        checks.insert("shape_is_3d".to_string(), false);
        checks.insert("chunks_are_3d".to_string(), false);
        checks.insert("dtype_supported".to_string(), false);
        checks.insert("uncompressed_chunks".to_string(), false);
        checks.insert("filters_supported".to_string(), false);
        checks.insert("row_major_order".to_string(), false);
        checks.insert("dot_chunk_keys".to_string(), false);
        checks.insert("zarr_v2".to_string(), false);
    }

    checks.insert("voxel_metadata_found".to_string(), voxel_size_found);

    let required = [
        "path_exists",
        "zarray_found",
        "shape_is_3d",
        "chunks_are_3d",
        "dtype_supported",
        "uncompressed_chunks",
        "filters_supported",
        "row_major_order",
        "dot_chunk_keys",
        "zarr_v2",
    ];
    let required_ok = required
        .iter()
        .all(|key| checks.get(*key).copied().unwrap_or(false));
    let status = if required_ok {
        if voxel_size_found {
            "ready"
        } else {
            "warning"
        }
    } else {
        "unsupported"
    };

    let summary = match status {
        "ready" => "Local Zarr is compatible with the current raw chunk reader.",
        "warning" => "Local Zarr is compatible, but voxel-size metadata was not found; measurements default to 1 nm voxels.",
        _ => "Local Zarr is not compatible with the current raw 3D Zarr reader.",
    };

    serde_json::json!({
        "status": status,
        "summary": summary,
        "array_path": array_path.unwrap_or(""),
        "checks": checks
    })
}

fn get_public_data_root() -> PathBuf {
    if let Ok(root) = std::env::var("CELL_ANATOMY_PUBLIC_DATA_ROOT") {
        return PathBuf::from(root);
    }
    if let Ok(root) = std::env::var("SCION_PUBLIC_DATA_ROOT") {
        return PathBuf::from(root);
    }
    if let Some(home) = home::home_dir() {
        let branded_root = home.join("Downloads").join("cell-anatomy-public-data");
        if branded_root.exists() {
            return branded_root;
        }
        let legacy_root = home.join("Downloads").join("scion-public-data");
        if legacy_root.exists() {
            return legacy_root;
        }
        return branded_root;
    }
    PathBuf::from("cell-anatomy-public-data")
}

fn locate_zarr_derivative(
    dataset: &str,
    asset_path: &str,
    private_worksets: &Arc<Mutex<BTreeMap<String, PathBuf>>>,
) -> Option<DerivativeEntry> {
    if dataset.starts_with("custom_") {
        let guard = get_custom_datasets().lock().unwrap();
        for val in guard.iter() {
            if let Some(slug) = val.get("slug").and_then(|s| s.as_str()) {
                if slug == dataset {
                    if let Some(derivatives) = val.get("derivatives").and_then(|d| d.as_array()) {
                        for d in derivatives {
                            if let Ok(entry) = serde_json::from_value::<DerivativeEntry>(d.clone())
                            {
                                if entry.source_relative_path == asset_path {
                                    return Some(entry);
                                }
                            }
                        }
                    }
                }
            }
        }
        return None;
    }
    let private_path = private_worksets
        .lock()
        .ok()
        .and_then(|worksets| worksets.get(dataset).cloned());
    if let Some(path) = private_path {
        let dataset = private_workset_dataset_payload(&path).ok()?;
        let derivatives = dataset.get("derivatives")?.as_array()?;
        return derivatives.into_iter().find_map(|value| {
            if value_str(&value, "source_relative_path") == asset_path {
                serde_json::from_value::<DerivativeEntry>(value.clone()).ok()
            } else {
                None
            }
        });
    }
    let root = get_public_data_root();
    let manifest_path = root
        .join(dataset)
        .join("metadata")
        .join("derivative-manifest.json");

    if !manifest_path.exists() {
        eprintln!("Manifest does not exist: {:?}", manifest_path);
        return None;
    }

    let file = File::open(manifest_path).ok()?;
    let manifest: DerivativeManifest = serde_json::from_reader(file).ok()?;
    manifest
        .derivatives
        .into_iter()
        .find(|d| d.source_relative_path == asset_path)
}

fn parse_zarray(zattrs_dir: &Path) -> Option<Zarray> {
    let zarray_path = zattrs_dir.join("0").join(".zarray");
    if zarray_path.exists() {
        let file = File::open(zarray_path).ok()?;
        let zarray: Zarray = serde_json::from_reader(file).ok()?;
        return Some(zarray);
    }
    let zarray_path_direct = zattrs_dir.join(".zarray");
    if zarray_path_direct.exists() {
        let file = File::open(zarray_path_direct).ok()?;
        let zarray: Zarray = serde_json::from_reader(file).ok()?;
        return Some(zarray);
    }
    None
}

async fn handle_slice(
    State(state): State<AppState>,
    Query(params): Query<SliceParams>,
) -> impl IntoResponse {
    let entry =
        match locate_zarr_derivative(&params.dataset, &params.asset, &state.private_worksets) {
            Some(e) => e,
            None => {
                return (StatusCode::NOT_FOUND, "Dataset or derivative not found").into_response()
            }
        };

    let zarr_dir = PathBuf::from(&entry.output_path);
    let zarr_config = match parse_zarray(&zarr_dir) {
        Some(c) => c,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse .zarray metadata",
            )
                .into_response()
        }
    };

    let shape = &zarr_config.shape;
    let chunks = &zarr_config.chunks;
    if shape.len() != 3 || chunks.len() != 3 {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid OME-Zarr array shape/chunks dimensions",
        )
            .into_response();
    }

    let (z_max, y_max, x_max) = (shape[0], shape[1], shape[2]);
    let (cz, cy, cx) = (chunks[0], chunks[1], chunks[2]);

    let elem_size = match zarr_config.dtype.as_str() {
        "|u1" | "uint8" => 1,
        "<u2" | "uint16" | ">u2" => 2,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                format!("Unsupported Zarr dtype: {}", zarr_config.dtype),
            )
                .into_response()
        }
    };

    let axis = params.axis.to_lowercase();
    let slice_idx = params.slice;

    let (out_height, out_width, slice_payload) = match axis.as_str() {
        "z" => {
            if slice_idx >= z_max {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("Slice index {} out of range [0, {}]", slice_idx, z_max - 1),
                )
                    .into_response();
            }
            let mut out_buffer = vec![0u8; y_max * x_max * elem_size];
            let zc = slice_idx / cz;
            let zo = slice_idx % cz;

            let y_chunks = (y_max + cy - 1) / cy;
            let x_chunks = (x_max + cx - 1) / cx;

            for yc in 0..y_chunks {
                for xc in 0..x_chunks {
                    let chunk_name = format!("{}.{}.{}", zc, yc, xc);
                    let mut chunk_file = zarr_dir.join("0").join(&chunk_name);
                    if !zarr_dir.join("0").exists() {
                        chunk_file = zarr_dir.join(&chunk_name);
                    }

                    let z_len = std::cmp::min(cz, z_max - zc * cz);
                    let y_len = std::cmp::min(cy, y_max - yc * cy);
                    let x_len = std::cmp::min(cx, x_max - xc * cx);
                    let chunk_bytes_expected = z_len * y_len * x_len * elem_size;

                    if chunk_file.exists() {
                        if let Ok(mut f) = File::open(chunk_file) {
                            let mut chunk_data = vec![0u8; chunk_bytes_expected];
                            if f.read_exact(&mut chunk_data).is_ok() {
                                let local_slice_start = zo * y_len * x_len * elem_size;
                                for ly in 0..y_len {
                                    let src_offset = local_slice_start + (ly * x_len * elem_size);
                                    let dest_y = (yc * cy) + ly;
                                    let dest_x = xc * cx;
                                    let dest_offset = ((dest_y * x_max) + dest_x) * elem_size;

                                    let len_to_copy = x_len * elem_size;
                                    out_buffer[dest_offset..(dest_offset + len_to_copy)]
                                        .copy_from_slice(
                                            &chunk_data[src_offset..(src_offset + len_to_copy)],
                                        );
                                }
                            }
                        }
                    }
                }
            }
            (y_max, x_max, out_buffer)
        }
        "y" => {
            if slice_idx >= y_max {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("Slice index {} out of range [0, {}]", slice_idx, y_max - 1),
                )
                    .into_response();
            }
            let mut out_buffer = vec![0u8; z_max * x_max * elem_size];
            let yc = slice_idx / cy;
            let yo = slice_idx % cy;

            let z_chunks = (z_max + cz - 1) / cz;
            let x_chunks = (x_max + cx - 1) / cx;

            for zc in 0..z_chunks {
                for xc in 0..x_chunks {
                    let chunk_name = format!("{}.{}.{}", zc, yc, xc);
                    let mut chunk_file = zarr_dir.join("0").join(&chunk_name);
                    if !zarr_dir.join("0").exists() {
                        chunk_file = zarr_dir.join(&chunk_name);
                    }

                    let z_len = std::cmp::min(cz, z_max - zc * cz);
                    let y_len = std::cmp::min(cy, y_max - yc * cy);
                    let x_len = std::cmp::min(cx, x_max - xc * cx);
                    let chunk_bytes_expected = z_len * y_len * x_len * elem_size;

                    if chunk_file.exists() {
                        if let Ok(mut f) = File::open(chunk_file) {
                            let mut chunk_data = vec![0u8; chunk_bytes_expected];
                            if f.read_exact(&mut chunk_data).is_ok() {
                                for lz in 0..z_len {
                                    let src_offset =
                                        ((lz * y_len * x_len) + (yo * x_len)) * elem_size;
                                    let dest_z = (zc * cz) + lz;
                                    let dest_x = xc * cx;
                                    let dest_offset = ((dest_z * x_max) + dest_x) * elem_size;

                                    let len_to_copy = x_len * elem_size;
                                    out_buffer[dest_offset..(dest_offset + len_to_copy)]
                                        .copy_from_slice(
                                            &chunk_data[src_offset..(src_offset + len_to_copy)],
                                        );
                                }
                            }
                        }
                    }
                }
            }
            (z_max, x_max, out_buffer)
        }
        "x" => {
            if slice_idx >= x_max {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("Slice index {} out of range [0, {}]", slice_idx, x_max - 1),
                )
                    .into_response();
            }
            let mut out_buffer = vec![0u8; z_max * y_max * elem_size];
            let xc = slice_idx / cx;
            let xo = slice_idx % cx;

            let z_chunks = (z_max + cz - 1) / cz;
            let y_chunks = (y_max + cy - 1) / cy;

            for zc in 0..z_chunks {
                for yc in 0..y_chunks {
                    let chunk_name = format!("{}.{}.{}", zc, yc, xc);
                    let mut chunk_file = zarr_dir.join("0").join(&chunk_name);
                    if !zarr_dir.join("0").exists() {
                        chunk_file = zarr_dir.join(&chunk_name);
                    }

                    let z_len = std::cmp::min(cz, z_max - zc * cz);
                    let y_len = std::cmp::min(cy, y_max - yc * cy);
                    let x_len = std::cmp::min(cx, x_max - xc * cx);
                    let chunk_bytes_expected = z_len * y_len * x_len * elem_size;

                    if chunk_file.exists() {
                        if let Ok(mut f) = File::open(chunk_file) {
                            let mut chunk_data = vec![0u8; chunk_bytes_expected];
                            if f.read_exact(&mut chunk_data).is_ok() {
                                for lz in 0..z_len {
                                    for ly in 0..y_len {
                                        let src_offset =
                                            ((lz * y_len * x_len) + (ly * x_len) + xo) * elem_size;
                                        let dest_z = (zc * cz) + lz;
                                        let dest_y = (yc * cy) + ly;
                                        let dest_offset = ((dest_z * y_max) + dest_y) * elem_size;

                                        out_buffer[dest_offset..(dest_offset + elem_size)]
                                            .copy_from_slice(
                                                &chunk_data[src_offset..(src_offset + elem_size)],
                                            );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            (z_max, y_max, out_buffer)
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                "Invalid axis parameter. Must be 'z', 'y', or 'x'",
            )
                .into_response()
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::HeaderName::from_static("x-width"),
        header::HeaderValue::from(out_width),
    );
    headers.insert(
        header::HeaderName::from_static("x-height"),
        header::HeaderValue::from(out_height),
    );
    headers.insert(
        header::HeaderName::from_static("x-dtype"),
        header::HeaderValue::from_str(&zarr_config.dtype)
            .unwrap_or(header::HeaderValue::from_static("uint8")),
    );
    if let Some(voxel_size_z) = entry.physical_voxel_size_nm.get("z") {
        headers.insert(
            header::HeaderName::from_static("x-voxel-size-z"),
            header::HeaderValue::from_str(&voxel_size_z.to_string()).unwrap(),
        );
    }
    if let Some(voxel_size_y) = entry.physical_voxel_size_nm.get("y") {
        headers.insert(
            header::HeaderName::from_static("x-voxel-size-y"),
            header::HeaderValue::from_str(&voxel_size_y.to_string()).unwrap(),
        );
    }
    if let Some(voxel_size_x) = entry.physical_voxel_size_nm.get("x") {
        headers.insert(
            header::HeaderName::from_static("x-voxel-size-x"),
            header::HeaderValue::from_str(&voxel_size_x.to_string()).unwrap(),
        );
    }

    (StatusCode::OK, headers, slice_payload).into_response()
}

async fn handle_health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct Volume3DParams {
    dataset: String,
    asset: String,
    downsample: Option<usize>,
}

async fn handle_volume_3d(
    State(state): State<AppState>,
    Query(params): Query<Volume3DParams>,
) -> impl IntoResponse {
    let downsample = params.downsample.unwrap_or(4);
    if downsample == 0 {
        return (StatusCode::BAD_REQUEST, "Downsample factor cannot be zero").into_response();
    }

    let entry =
        match locate_zarr_derivative(&params.dataset, &params.asset, &state.private_worksets) {
            Some(e) => e,
            None => {
                return (StatusCode::NOT_FOUND, "Dataset or derivative not found").into_response()
            }
        };

    let zarr_dir = PathBuf::from(&entry.output_path);
    let zarr_config = match parse_zarray(&zarr_dir) {
        Some(c) => c,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse .zarray metadata",
            )
                .into_response()
        }
    };

    let shape = &zarr_config.shape;
    let chunks = &zarr_config.chunks;
    if shape.len() != 3 || chunks.len() != 3 {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid OME-Zarr array shape/chunks dimensions",
        )
            .into_response();
    }

    let (z_max, y_max, x_max) = (shape[0], shape[1], shape[2]);
    let (cz, cy, cx) = (chunks[0], chunks[1], chunks[2]);

    let elem_size = match zarr_config.dtype.as_str() {
        "|u1" | "uint8" => 1,
        "<u2" | "uint16" | ">u2" => 2,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                format!("Unsupported Zarr dtype: {}", zarr_config.dtype),
            )
                .into_response()
        }
    };

    // Calculate downsampled dimensions
    let dz = (z_max + downsample - 1) / downsample;
    let dy = (y_max + downsample - 1) / downsample;
    let dx = (x_max + downsample - 1) / downsample;

    let mut out_buffer = vec![0u8; dz * dy * dx * elem_size];

    let z_chunks = (z_max + cz - 1) / cz;
    let y_chunks = (y_max + cy - 1) / cy;
    let x_chunks = (x_max + cx - 1) / cx;

    // Process chunk-by-chunk to read each chunk exactly once
    for zc in 0..z_chunks {
        let z_start = zc * cz;
        let z_end = std::cmp::min(z_start + cz, z_max);

        // Find first Z in this chunk matching stride
        let first_z = ((z_start + downsample - 1) / downsample) * downsample;
        if first_z >= z_end {
            continue;
        }

        for yc in 0..y_chunks {
            let y_start = yc * cy;
            let y_end = std::cmp::min(y_start + cy, y_max);

            // Find first Y in this chunk matching stride
            let first_y = ((y_start + downsample - 1) / downsample) * downsample;
            if first_y >= y_end {
                continue;
            }

            for xc in 0..x_chunks {
                let x_start = xc * cx;
                let x_end = std::cmp::min(x_start + cx, x_max);

                // Find first X in this chunk matching stride
                let first_x = ((x_start + downsample - 1) / downsample) * downsample;
                if first_x >= x_end {
                    continue;
                }

                let chunk_name = format!("{}.{}.{}", zc, yc, xc);
                let mut chunk_file = zarr_dir.join("0").join(&chunk_name);
                if !zarr_dir.join("0").exists() {
                    chunk_file = zarr_dir.join(&chunk_name);
                }

                let z_len = z_end - z_start;
                let y_len = y_end - y_start;
                let x_len = x_end - x_start;
                let chunk_bytes_expected = z_len * y_len * x_len * elem_size;

                if chunk_file.exists() {
                    if let Ok(mut f) = File::open(chunk_file) {
                        let mut chunk_data = vec![0u8; chunk_bytes_expected];
                        if f.read_exact(&mut chunk_data).is_ok() {
                            // Extract strided elements
                            let mut z = first_z;
                            while z < z_end {
                                let sz = z / downsample;
                                let zo = z - z_start;

                                let mut y = first_y;
                                while y < y_end {
                                    let sy = y / downsample;
                                    let yo = y - y_start;

                                    let mut x = first_x;
                                    while x < x_end {
                                        let sx = x / downsample;
                                        let xo = x - x_start;

                                        let src_offset =
                                            ((zo * y_len * x_len) + (yo * x_len) + xo) * elem_size;
                                        let dest_offset =
                                            ((sz * dy * dx) + (sy * dx) + sx) * elem_size;

                                        out_buffer[dest_offset..(dest_offset + elem_size)]
                                            .copy_from_slice(
                                                &chunk_data[src_offset..(src_offset + elem_size)],
                                            );

                                        x += downsample;
                                    }
                                    y += downsample;
                                }
                                z += downsample;
                            }
                        }
                    }
                }
            }
        }
    }

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::HeaderName::from_static("x-width"),
        header::HeaderValue::from(dx),
    );
    headers.insert(
        header::HeaderName::from_static("x-height"),
        header::HeaderValue::from(dy),
    );
    headers.insert(
        header::HeaderName::from_static("x-depth"),
        header::HeaderValue::from(dz),
    );
    headers.insert(
        header::HeaderName::from_static("x-dtype"),
        header::HeaderValue::from_str(&zarr_config.dtype)
            .unwrap_or(header::HeaderValue::from_static("uint8")),
    );
    if let Some(voxel_size_z) = entry.physical_voxel_size_nm.get("z") {
        headers.insert(
            header::HeaderName::from_static("x-voxel-size-z"),
            header::HeaderValue::from_str(&voxel_size_z.to_string()).unwrap(),
        );
    }
    if let Some(voxel_size_y) = entry.physical_voxel_size_nm.get("y") {
        headers.insert(
            header::HeaderName::from_static("x-voxel-size-y"),
            header::HeaderValue::from_str(&voxel_size_y.to_string()).unwrap(),
        );
    }
    if let Some(voxel_size_x) = entry.physical_voxel_size_nm.get("x") {
        headers.insert(
            header::HeaderName::from_static("x-voxel-size-x"),
            header::HeaderValue::from_str(&voxel_size_x.to_string()).unwrap(),
        );
    }

    (StatusCode::OK, headers, out_buffer).into_response()
}

fn parse_voxel_size_with_status(path: &Path) -> (Value, bool) {
    let mut zattrs_path = path.join(".zattrs");
    if !zattrs_path.exists() && path.ends_with("0") {
        if let Some(parent) = path.parent() {
            zattrs_path = parent.join(".zattrs");
        }
    }
    if zattrs_path.exists() {
        if let Ok(file) = File::open(zattrs_path) {
            if let Ok(zattrs) = serde_json::from_reader::<_, Value>(file) {
                if let Some(multiscales) = zattrs.get("multiscales").and_then(|m| m.as_array()) {
                    if let Some(first_ms) = multiscales.first() {
                        if let Some(datasets) = first_ms.get("datasets").and_then(|d| d.as_array())
                        {
                            if let Some(first_ds) = datasets.first() {
                                if let Some(transforms) = first_ds
                                    .get("coordinateTransformations")
                                    .and_then(|t| t.as_array())
                                {
                                    for t in transforms {
                                        if t.get("type").and_then(|ty| ty.as_str()) == Some("scale")
                                        {
                                            if let Some(scale) =
                                                t.get("scale").and_then(|s| s.as_array())
                                            {
                                                if scale.len() == 3 {
                                                    return (
                                                        serde_json::json!({
                                                            "z": scale[0],
                                                            "y": scale[1],
                                                            "x": scale[2]
                                                        }),
                                                        true,
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    (
        serde_json::json!({
            "z": 1.0,
            "y": 1.0,
            "x": 1.0
        }),
        false,
    )
}

#[derive(Deserialize)]
struct OpenLocalParams {
    path: String,
}

async fn handle_open_local(Query(params): Query<OpenLocalParams>) -> impl IntoResponse {
    let requested_path = PathBuf::from(&params.path);
    let path = fs::canonicalize(&requested_path).unwrap_or_else(|_| requested_path.clone());
    if !path.exists() {
        let compatibility = local_zarr_compatibility_report(&path, None, None, false);
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::to_string(&serde_json::json!({
                "success": false,
                "error": format!("Path does not exist: {}", params.path),
                "compatibility": compatibility
            }))
            .unwrap(),
        )
            .into_response();
    }

    let (zarr_root, array_path, zarray_path) = match resolve_local_zarr_array(&path) {
        Some(resolved) => resolved,
        None => {
            let compatibility = local_zarr_compatibility_report(&path, None, None, false);
            return (
                StatusCode::BAD_REQUEST,
                [(header::CONTENT_TYPE, "application/json")],
                serde_json::to_string(&serde_json::json!({
                    "success": false,
                    "error": "No .zarray file found at the root or within resolution group '0'",
                    "compatibility": compatibility
                }))
                .unwrap(),
            )
                .into_response();
        }
    };

    let zarr_config = match read_zarray_file(&zarray_path) {
        Ok(config) => config,
        Err(e) => {
            let compatibility =
                local_zarr_compatibility_report(&path, Some(&array_path), None, false);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CONTENT_TYPE, "application/json")],
                serde_json::to_string(&serde_json::json!({
                    "success": false,
                    "error": e,
                    "compatibility": compatibility
                }))
                .unwrap(),
            )
                .into_response();
        }
    };

    let (voxel_size, voxel_size_found) = parse_voxel_size_with_status(&zarr_root);
    let compatibility = local_zarr_compatibility_report(
        &zarr_root,
        Some(&array_path),
        Some(&zarr_config),
        voxel_size_found,
    );

    if compatibility
        .get("status")
        .and_then(|status| status.as_str())
        == Some("unsupported")
    {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::to_string(&serde_json::json!({
                "success": false,
                "error": compatibility
                    .get("summary")
                    .and_then(|summary| summary.as_str())
                    .unwrap_or("Local Zarr is not compatible with the current reader."),
                "compatibility": compatibility
            }))
            .unwrap(),
        )
            .into_response();
    }

    let folder_name = zarr_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();

    let output_path = zarr_root.to_string_lossy().into_owned();
    let slug = format!(
        "custom_{}_{:016x}",
        slugify_path_component(&folder_name),
        stable_path_hash(&output_path)
    );
    let title = format!("Local: {}", folder_name);

    let elem_size = zarr_dtype_elem_size(&zarr_config.dtype).unwrap_or(0);
    let byte_size = zarr_config
        .shape
        .iter()
        .try_fold(1usize, |acc, value| acc.checked_mul(*value))
        .and_then(|voxels| voxels.checked_mul(elem_size))
        .unwrap_or(0);

    let derivative = serde_json::json!({
        "source_relative_path": array_path,
        "source_local_path": output_path,
        "source_sha256": "",
        "source_size_bytes": byte_size,
        "output_path": output_path,
        "format": "zarr",
        "ome_ngff_version": "detected",
        "zarr_format": zarr_config.zarr_format.unwrap_or(2),
        "array_path": compatibility.get("array_path").cloned().unwrap_or(Value::String("".to_string())),
        "shape_zyx": zarr_config.shape,
        "chunks_zyx": zarr_config.chunks,
        "dtype": zarr_config.dtype,
        "byte_size": byte_size,
        "physical_voxel_size_nm": voxel_size,
        "validation": compatibility
    });

    let new_dataset = serde_json::json!({
        "slug": slug.clone(),
        "title": title,
        "source": "Local SSD",
        "entryId": "local",
        "experimentType": "Custom Zarr Volumetric",
        "derivatives": [derivative],
        "findings": []
    });

    let (persisted, persistence_error) = {
        let mut guard = get_custom_datasets().lock().unwrap();
        guard.retain(|dataset| {
            let existing_slug = dataset.get("slug").and_then(|value| value.as_str());
            let existing_path = dataset
                .get("derivatives")
                .and_then(|derivatives| derivatives.as_array())
                .and_then(|derivatives| derivatives.first())
                .and_then(|derivative| derivative.get("output_path"))
                .and_then(|value| value.as_str());
            existing_slug != Some(slug.as_str()) && existing_path != Some(output_path.as_str())
        });
        guard.push(new_dataset);
        match persist_custom_dataset_registry(&guard) {
            Ok(()) => (true, None),
            Err(err) => {
                eprintln!("Failed to persist local dataset registry: {}", err);
                (false, Some(err))
            }
        }
    };

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&serde_json::json!({
            "success": true,
            "slug": slug,
            "persisted": persisted,
            "registry_path": get_custom_dataset_registry_path().to_string_lossy(),
            "persistence_error": persistence_error
        }))
        .unwrap(),
    )
        .into_response()
}

async fn handle_index_queue(State(state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&combined_index_queue_payload(&state.private_worksets)).unwrap(),
    )
        .into_response()
}

async fn handle_register_private_workset(
    State(state): State<AppState>,
    axum::extract::Json(payload): axum::extract::Json<RegisterPrivateWorksetRequest>,
) -> impl IntoResponse {
    let path = match canonical_workset_path(&payload.workset_path) {
        Ok(path) => path,
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": error }),
            )
        }
    };
    let dataset = match private_workset_dataset_payload(&path) {
        Ok(dataset) => dataset,
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": error }),
            )
        }
    };
    let slug = value_str(&dataset, "slug").to_string();
    match state.private_worksets.lock() {
        Ok(mut worksets) => {
            let mut updated = worksets.clone();
            updated.insert(slug, path);
            if let Err(error) = persist_private_workset_registry(&updated) {
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({ "error": error }),
                );
            }
            *worksets = updated;
        }
        Err(_) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": "Private workset registry is unavailable." }),
            )
        }
    }
    json_response(
        StatusCode::OK,
        serde_json::json!({ "success": true, "dataset": dataset }),
    )
}

async fn handle_list_index_jobs(State(state): State<AppState>) -> impl IntoResponse {
    let mut jobs = state
        .index_jobs
        .lock()
        .map(|guard| guard.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    jobs.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    json_response(StatusCode::OK, serde_json::json!({ "jobs": jobs }))
}

async fn handle_start_index_job(
    State(state): State<AppState>,
    axum::extract::Json(payload): axum::extract::Json<StartIndexJobRequest>,
) -> impl IntoResponse {
    match start_index_job(&state, payload) {
        Ok(job) => json_response(StatusCode::ACCEPTED, serde_json::json!({ "job": job })),
        Err(error) => json_response(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": error }),
        ),
    }
}

async fn handle_index_batch_plan(
    State(state): State<AppState>,
    axum::extract::Json(payload): axum::extract::Json<IndexBatchPlanRequest>,
) -> impl IntoResponse {
    let queue = combined_index_queue_payload(&state.private_worksets);
    let jobs = state
        .index_jobs
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    match build_index_batch_plan(&queue, &jobs, &payload) {
        Ok(plan) => json_response(StatusCode::OK, plan),
        Err(error) => json_response(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": error }),
        ),
    }
}

async fn handle_list_index_batch_runs(State(state): State<AppState>) -> impl IntoResponse {
    let mut runs = state
        .index_batch_runs
        .lock()
        .map(|guard| guard.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    runs.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    json_response(StatusCode::OK, serde_json::json!({ "runs": runs }))
}

async fn handle_start_index_batch_run(
    State(state): State<AppState>,
    axum::extract::Json(payload): axum::extract::Json<StartIndexBatchRunRequest>,
) -> impl IntoResponse {
    let record = match build_index_batch_run_from_plan(&payload.plan, payload.concurrency) {
        Ok(record) => record,
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": error }),
            )
        }
    };
    if let Err(error) = persist_index_batch_run(&record) {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "error": error }),
        );
    }
    {
        let mut runs = match state.index_batch_runs.lock() {
            Ok(runs) => runs,
            Err(_) => {
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({ "error": "Index batch run registry is unavailable." }),
                )
            }
        };
        runs.insert(record.id.clone(), record.clone());
    }

    let run_id = record.id.clone();
    let runner_state = state.clone();
    tokio::spawn(async move {
        run_index_batch_runner(runner_state, run_id).await;
    });

    json_response(StatusCode::ACCEPTED, serde_json::json!({ "run": record }))
}

async fn handle_cancel_index_batch_run(
    AxumPath(run_id): AxumPath<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let mut child_jobs_to_cancel = Vec::new();
    let record = {
        let mut runs = match state.index_batch_runs.lock() {
            Ok(runs) => runs,
            Err(_) => {
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({ "error": "Index batch run registry is unavailable." }),
                )
            }
        };
        let record = match runs.get_mut(&run_id) {
            Some(record) => record,
            None => {
                return json_response(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "Index batch run not found." }),
                )
            }
        };
        if is_terminal_batch_run_status(&record.status) {
            return json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": format!("Cannot cancel a {} batch run.", record.status) }),
            );
        }

        let cancelled_at = now_ms();
        for item in &mut record.items {
            match item.status.as_str() {
                "pending" => {
                    item.status = "cancelled".to_string();
                    item.finished_at_ms = Some(cancelled_at);
                }
                "queued" | "running" | "cancel_requested" => {
                    if let Some(job_id) = &item.job_id {
                        item.status = "cancel_requested".to_string();
                        child_jobs_to_cancel.push(job_id.clone());
                    } else {
                        item.status = "cancelled".to_string();
                        item.finished_at_ms = Some(cancelled_at);
                    }
                }
                _ => {}
            }
        }
        record.status = "cancel_requested".to_string();
        record.updated_at_ms = cancelled_at;
        record.summary = summarize_index_batch_items(&record.items);
        if record.summary.running == 0 {
            record.status = "cancelled".to_string();
            record.finished_at_ms = Some(cancelled_at);
        }
        record.log.push("Batch cancellation requested.".to_string());
        if let Err(error) = persist_index_batch_run(record) {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": error }),
            );
        }
        record.clone()
    };

    for job_id in child_jobs_to_cancel {
        if let Ok(pid) = mark_index_job_cancel_requested(&state.index_jobs, &job_id) {
            if let Some(pid) = pid {
                kill_process(pid);
            }
        }
    }

    json_response(StatusCode::OK, serde_json::json!({ "run": record }))
}

async fn handle_resume_index_batch_run(
    AxumPath(run_id): AxumPath<String>,
    State(state): State<AppState>,
    axum::extract::Json(payload): axum::extract::Json<ResumeIndexBatchRunRequest>,
) -> impl IntoResponse {
    let record = {
        let mut runs = match state.index_batch_runs.lock() {
            Ok(runs) => runs,
            Err(_) => {
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({ "error": "Index batch run registry is unavailable." }),
                )
            }
        };
        let record = match runs.get_mut(&run_id) {
            Some(record) => record,
            None => {
                return json_response(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "Index batch run not found." }),
                )
            }
        };
        if let Err(error) =
            prepare_index_batch_resume(record, payload.retry_failed.unwrap_or(false))
        {
            return json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": error }),
            );
        }
        if let Err(error) = persist_index_batch_run(record) {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": error }),
            );
        }
        record.clone()
    };

    let runner_state = state.clone();
    let runner_id = record.id.clone();
    tokio::spawn(async move {
        run_index_batch_runner(runner_state, runner_id).await;
    });

    json_response(StatusCode::ACCEPTED, serde_json::json!({ "run": record }))
}

async fn handle_cancel_index_job(
    AxumPath(job_id): AxumPath<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let pid = match mark_index_job_cancel_requested(&state.index_jobs, &job_id) {
        Ok(pid) => pid,
        Err(error) if error == "Index job not found." => {
            return json_response(StatusCode::NOT_FOUND, serde_json::json!({ "error": error }))
        }
        Err(error) if error == "Index job registry is unavailable." => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": error }),
            )
        }
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": error }),
            )
        }
    };

    if let Some(pid) = pid {
        kill_process(pid);
    }
    let job = state
        .index_jobs
        .lock()
        .ok()
        .and_then(|guard| guard.get(&job_id).cloned());
    json_response(StatusCode::OK, serde_json::json!({ "job": job }))
}

async fn handle_retry_index_job(
    AxumPath(job_id): AxumPath<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let request = {
        let guard = match state.index_jobs.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({ "error": "Index job registry is unavailable." }),
                )
            }
        };
        let job = match guard.get(&job_id) {
            Some(job) => job,
            None => {
                return json_response(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "Index job not found." }),
                )
            }
        };
        StartIndexJobRequest {
            kind: job.kind.clone(),
            dataset_slug: job.dataset_slug.clone(),
            asset_relative_path: job.asset_relative_path.clone(),
        }
    };

    match start_index_job(&state, request) {
        Ok(job) => json_response(StatusCode::ACCEPTED, serde_json::json!({ "job": job })),
        Err(error) => json_response(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": error }),
        ),
    }
}

async fn handle_workbench_data(State(state): State<AppState>) -> impl IntoResponse {
    let mut packaged_datasets = Vec::new();

    {
        if let Ok(guard) = get_custom_datasets().lock() {
            packaged_datasets.extend(guard.clone());
        }
    }

    let private_paths = state
        .private_worksets
        .lock()
        .map(|worksets| worksets.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for path in private_paths {
        let Ok(dataset) = private_workset_dataset_payload(&path) else {
            continue;
        };
        let derivatives = dataset
            .get("derivatives")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        if derivatives.is_empty() {
            continue;
        }
        let metadata = dataset.get("dataset").cloned().unwrap_or(Value::Null);
        packaged_datasets
            .retain(|existing| value_str(existing, "slug") != value_str(&dataset, "slug"));
        packaged_datasets.push(serde_json::json!({
            "slug": value_str(&dataset, "slug"),
            "title": value_str(&metadata, "title"),
            "source": value_str(&metadata, "source"),
            "entryId": value_str(&metadata, "entry_id"),
            "experimentType": value_str(&metadata, "experiment_type"),
            "derivatives": derivatives,
            "findings": dataset.get("findings").cloned().unwrap_or_else(|| serde_json::json!([]))
        }));
    }

    let root = get_public_data_root();
    let index_path = root.join("pilot-index.json");
    if index_path.exists() {
        if let Ok(file) = File::open(&index_path) {
            if let Ok(index_val) = serde_json::from_reader::<_, Value>(file) {
                if let Some(datasets_arr) = index_val.get("datasets").and_then(|d| d.as_array()) {
                    for ds in datasets_arr {
                        let slug = match ds.get("slug").and_then(|s| s.as_str()) {
                            Some(s) => s,
                            None => continue,
                        };

                        // Load derivative manifest
                        let deriv_path = root
                            .join(slug)
                            .join("metadata")
                            .join("derivative-manifest.json");
                        let mut derivatives = Vec::new();
                        if deriv_path.exists() {
                            if let Ok(df) = File::open(&deriv_path) {
                                if let Ok(dm) = serde_json::from_reader::<_, Value>(df) {
                                    if let Some(deriv_arr) =
                                        dm.get("derivatives").and_then(|d| d.as_array())
                                    {
                                        derivatives = deriv_arr.clone();
                                    }
                                }
                            }
                        }

                        // Only include if we have at least one streamable spatial derivative
                        if derivatives.is_empty() {
                            continue;
                        }

                        // Load advisory findings
                        let advisory_path = root
                            .join(slug)
                            .join("metadata")
                            .join("advisory-findings.json");
                        let mut findings = Vec::new();
                        if advisory_path.exists() {
                            if let Ok(af) = File::open(&advisory_path) {
                                if let Ok(am) = serde_json::from_reader::<_, Value>(af) {
                                    if let Some(findings_arr) =
                                        am.get("findings").and_then(|f| f.as_array())
                                    {
                                        findings = findings_arr.clone();
                                    }
                                }
                            }
                        }

                        // Build packaged dataset entry
                        let dataset_meta = ds.get("dataset");
                        let title = dataset_meta
                            .and_then(|m| m.get("title"))
                            .and_then(|t| t.as_str())
                            .unwrap_or(slug);
                        let source = dataset_meta
                            .and_then(|m| m.get("source"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("");
                        let entry_id = dataset_meta
                            .and_then(|m| m.get("entry_id"))
                            .and_then(|e| e.as_str())
                            .unwrap_or("");
                        let experiment_type = dataset_meta
                            .and_then(|m| m.get("experiment_type"))
                            .and_then(|e| e.as_str())
                            .unwrap_or("");

                        packaged_datasets.push(serde_json::json!({
                            "slug": slug,
                            "title": title,
                            "source": source,
                            "entryId": entry_id,
                            "experimentType": experiment_type,
                            "derivatives": derivatives,
                            "findings": findings
                        }));
                    }
                }
            }
        }
    }

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&packaged_datasets).unwrap(),
    )
        .into_response()
}

// ==========================================
// SQLITE PARSING & SEEDING ENGINE
// ==========================================

fn derive_species(cell_type: &str, organism_type: &str) -> String {
    if cell_type.contains(',') {
        return cell_type.split(',').next().unwrap().trim().to_string();
    }
    let words: Vec<&str> = cell_type.split_whitespace().collect();
    if words.len() == 2 {
        let w0 = words[0];
        let w1 = words[1];
        let w0_first = w0.chars().next().unwrap_or('\0');
        let w1_first = w1.chars().next().unwrap_or('\0');
        if w0_first.is_uppercase() && w1_first.is_lowercase() {
            return cell_type.trim().to_string();
        }
        if w0.ends_with('.') {
            return cell_type.trim().to_string();
        }
    }
    let org = organism_type.trim();
    if !org.is_empty() {
        org.to_string()
    } else {
        cell_type.trim().to_string()
    }
}

fn normalize_modality_family(modality: &str) -> String {
    let lowered = modality.to_lowercase();
    if ["fib-sem", "sbf-sem", "sem", "electron", "cryo", "tem", "et"]
        .iter()
        .any(|&t| lowered.contains(t))
    {
        "EM".to_string()
    } else if ["sxt", "x-ray", "stxm", "hxt"]
        .iter()
        .any(|&t| lowered.contains(t))
    {
        "X-ray".to_string()
    } else if [
        "optical",
        "fluorescence",
        "phase contrast",
        "diffraction",
        "lls",
        "sim",
    ]
    .iter()
    .any(|&t| lowered.contains(t))
    {
        "optical".to_string()
    } else {
        "other".to_string()
    }
}

fn mean_numeric(value: &str) -> Option<f64> {
    let mut numbers = Vec::new();
    let mut current = String::new();
    for c in value.chars() {
        if c.is_ascii_digit() || c == '.' {
            current.push(c);
        } else {
            if !current.is_empty() {
                if let Ok(val) = current.parse::<f64>() {
                    numbers.push(val);
                }
                current.clear();
            }
        }
    }
    if !current.is_empty() {
        if let Ok(val) = current.parse::<f64>() {
            numbers.push(val);
        }
    }
    if numbers.is_empty() {
        None
    } else {
        let sum: f64 = numbers.iter().sum();
        Some(sum / numbers.len() as f64)
    }
}

fn split_terms(values: &[&str]) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for value in values {
        let parts = value.split(|c| c == ';' || c == ',');
        for part in parts {
            let term = part.trim().trim_matches('"').trim().to_lowercase();
            if term.is_empty() {
                continue;
            }
            if seen.insert(term.clone()) {
                terms.push(term);
            }
        }
    }
    terms
}

fn build_pairs(organelles: &[String]) -> Vec<String> {
    let mut sorted_unique: Vec<String> = organelles.iter().cloned().collect();
    sorted_unique.sort();
    sorted_unique.dedup();
    let mut pairs = Vec::new();
    for i in 0..sorted_unique.len() {
        for j in (i + 1)..sorted_unique.len() {
            pairs.push(format!("{}:{}", sorted_unique[i], sorted_unique[j]));
        }
    }
    pairs
}

fn normalize_metric_families(value: &str) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let parts = value.split(|c| c == ';' || c == ',');
    for part in parts {
        let lowered = part.trim().to_lowercase();
        if lowered.is_empty() {
            continue;
        }
        let metric = if lowered.contains("volume fraction") {
            "volume_fraction"
        } else if lowered.contains("surface area") {
            "surface_area"
        } else if lowered.contains("contact") || lowered.contains("association") {
            "contacts"
        } else if lowered.contains("position") || lowered.contains("distance") {
            "distance"
        } else if lowered.contains("dimension") {
            "dimensions"
        } else if lowered.contains("shape") {
            "shape"
        } else if lowered.contains("density") {
            "density"
        } else if lowered.contains("count") || lowered.contains('#') {
            "count"
        } else if lowered.contains("volume") {
            "volume"
        } else {
            "other"
        };
        if seen.insert(metric.to_string()) {
            normalized.push(metric.to_string());
        }
    }
    normalized
}

fn normalize_comparator(value: &str) -> (Option<String>, Option<String>) {
    let detail = value.trim();
    if detail.is_empty() {
        return (None, None);
    }
    let lowered = detail.to_lowercase();
    let class = if lowered.contains("cell cycle") {
        "cell cycle"
    } else if ["glucose", "metabolic", "fed", "fasted"]
        .iter()
        .any(|&t| lowered.contains(t))
    {
        "metabolic condition"
    } else if ["development", "stage", "differentiation", "young", "mature"]
        .iter()
        .any(|&t| lowered.contains(t))
    {
        "developmental stage"
    } else if ["methodology", "resolution", "modality"]
        .iter()
        .any(|&t| lowered.contains(t))
    {
        "methodology"
    } else if ["species", "cell type"]
        .iter()
        .any(|&t| lowered.contains(t))
    {
        "cell type"
    } else if ["stress", "infection", "treatment", "mutant", "mutation"]
        .iter()
        .any(|&t| lowered.contains(t))
    {
        "treatment"
    } else {
        "other"
    };
    (Some(class.to_string()), Some(detail.to_string()))
}

fn sample_size_bucket(sample_size: Option<i64>) -> String {
    match sample_size {
        None => "unknown".to_string(),
        Some(ss) => {
            if ss <= 1 {
                "1".to_string()
            } else if ss <= 10 {
                "2-10".to_string()
            } else if ss <= 50 {
                "11-50".to_string()
            } else {
                "51+".to_string()
            }
        }
    }
}

fn completeness_score(
    organelles: &[String],
    metrics: &[String],
    sample_size: Option<i64>,
    xy: Option<f64>,
    z: Option<f64>,
    public_status: &str,
) -> f64 {
    let mut score: f64 = 0.0;
    score += 0.2;
    score += 0.15;
    score += if xy.is_some() || z.is_some() {
        0.15
    } else {
        0.05
    };
    score += if !organelles.is_empty() { 0.2 } else { 0.0 };
    score += if !metrics.is_empty() { 0.1 } else { 0.0 };
    score += if sample_size.is_some() { 0.1 } else { 0.0 };
    score += if public_status != "none" { 0.1 } else { 0.05 };
    let final_score = score.min(1.0);
    (final_score * 100.0).round() / 100.0
}

fn publication_url(pmid: &str, study_slug: &str) -> String {
    let pmid_trimmed = pmid.trim();
    if !pmid_trimmed.is_empty() {
        format!("https://pubmed.ncbi.nlm.nih.gov/{}/", pmid_trimmed)
    } else {
        format!(
            "https://github.com/mmirvis/Cell-Anatomy-Scoping-Review/tree/main#{}",
            study_slug
        )
    }
}

fn seed_database(conn: &mut Connection) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute(
        "CREATE TABLE dataset_records (
            dataset_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            paper_title TEXT NOT NULL,
            year INTEGER NOT NULL,
            source TEXT NOT NULL,
            source_type TEXT NOT NULL,
            public_data_status TEXT NOT NULL,
            species TEXT NOT NULL,
            cell_type TEXT NOT NULL,
            tissue_or_system TEXT,
            comparator_class TEXT,
            comparator_detail TEXT,
            modality TEXT NOT NULL,
            modality_family TEXT NOT NULL,
            lateral_resolution_nm REAL,
            axial_resolution_nm REAL,
            isotropic BOOLEAN,
            organelles TEXT NOT NULL,
            organelle_pairs TEXT NOT NULL,
            metric_families TEXT NOT NULL,
            sample_size INTEGER,
            sample_size_bucket TEXT NOT NULL,
            metadata_completeness_score REAL NOT NULL,
            whole_cell_boundary_confirmed TEXT NOT NULL,
            notes TEXT,
            included_status TEXT NOT NULL,
            source_study_id TEXT,
            publication_pmid TEXT,
            source_publication_url TEXT,
            public_locator_urls TEXT NOT NULL
        )",
        [],
    )?;

    // Parse study_manifest.csv
    let mut studies_map = std::collections::HashMap::new();
    let mut study_reader = csv::Reader::from_reader(STUDY_MANIFEST_CSV.as_bytes());
    for result in study_reader.deserialize::<std::collections::HashMap<String, String>>() {
        let record = result?;
        if record.get("included_status").map(|s| s.as_str()) == Some("included") {
            if let Some(study_id) = record.get("study_id") {
                studies_map.insert(study_id.clone(), record);
            }
        }
    }

    // Parse public_data_assets.csv
    let mut public_assets_map = std::collections::HashMap::new();
    let mut public_reader = csv::Reader::from_reader(PUBLIC_DATA_ASSETS_CSV.as_bytes());
    for result in public_reader.deserialize::<std::collections::HashMap<String, String>>() {
        let record = result?;
        if let Some(study_id) = record.get("study_id") {
            public_assets_map.insert(study_id.clone(), record);
        }
    }

    // Parse corpus_locator.csv and seed
    let mut corpus_reader = csv::Reader::from_reader(CORPUS_LOCATOR_CSV.as_bytes());
    let mut count = 0;
    for result in corpus_reader.deserialize::<std::collections::HashMap<String, String>>() {
        let row = result?;

        let study_id = match row.get("study_id") {
            Some(id) => id,
            None => continue,
        };

        let study = match studies_map.get(study_id) {
            Some(s) => s,
            None => continue,
        };

        let public_asset = public_assets_map.get(study_id);

        let mut public_status = "none";
        if let Some(asset) = public_asset {
            let scope_note = asset
                .get("availability_scope_note")
                .cloned()
                .unwrap_or_default()
                .to_lowercase();
            public_status = if scope_note.contains("full dataset provided") {
                "complete"
            } else {
                "partial"
            };
        }

        let cell_type_raw = row.get("cell_type").cloned().unwrap_or_default();
        let organism_type_raw = row.get("organism_type").cloned().unwrap_or_default();
        let species = derive_species(&cell_type_raw, &organism_type_raw);
        let cell_type = cell_type_raw.trim().to_string();

        let quantifications = study.get("quantifications").cloned().unwrap_or_default();
        let metrics = normalize_metric_families(&quantifications);

        let comparators_conditions = study
            .get("comparators_conditions")
            .cloned()
            .unwrap_or_default();
        let (comparator_class, comparator_detail) = normalize_comparator(&comparators_conditions);

        let xy_nm = mean_numeric(&row.get("xy_nm").cloned().unwrap_or_default());
        let z_nm = mean_numeric(&row.get("z_nm").cloned().unwrap_or_default());

        let mut isotropic = None;
        if let (Some(xy), Some(z)) = (xy_nm, z_nm) {
            let max_val = xy.max(z);
            if max_val > 0.0 {
                isotropic = Some((xy - z).abs() / max_val <= 0.15);
            }
        }

        let min_sample_size_raw = row.get("min_sample_size").cloned().unwrap_or_default();
        let sample_size = min_sample_size_raw.parse::<i64>().ok();
        let s_bucket = sample_size_bucket(sample_size);

        let organelles_common = row.get("organelles_common").cloned().unwrap_or_default();
        let organelles_specialized = row
            .get("organelles_specialized")
            .cloned()
            .unwrap_or_default();
        let organelles = split_terms(&[&organelles_common, &organelles_specialized]);
        let organelle_pairs = build_pairs(&organelles);

        let c_score = completeness_score(
            &organelles,
            &metrics,
            sample_size,
            xy_nm,
            z_nm,
            public_status,
        );

        let mut note_parts = Vec::new();
        if public_status == "complete" {
            note_parts.push("Public data available.".to_string());
        } else if public_status == "partial" {
            note_parts.push("Some public data available.".to_string());
        }
        let sample_size_notes = row
            .get("sample_size_notes")
            .cloned()
            .unwrap_or_default()
            .trim()
            .to_string();
        if !sample_size_notes.is_empty() && sample_size_notes.len() <= 120 {
            note_parts.push(sample_size_notes);
        }
        let notes = if note_parts.is_empty() {
            None
        } else {
            Some(note_parts.join(" "))
        };

        let included_status = row
            .get("included_status")
            .cloned()
            .unwrap_or_else(|| "included".to_string());
        let pmid = study.get("pmid").cloned().unwrap_or_default();
        let publication_pmid = if pmid.trim().is_empty() {
            None
        } else {
            Some(pmid.trim().to_string())
        };
        let study_slug = row.get("study_slug").cloned().unwrap_or_default();
        let source_publication_url = Some(publication_url(&pmid, &study_slug));

        let public_locator_urls_raw = row.get("public_locator_urls").cloned().unwrap_or_default();
        let public_locator_urls: Vec<String> = public_locator_urls_raw
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let title = format!(
            "{} whole-cell dataset ({})",
            cell_type,
            row.get("imaging_modality").cloned().unwrap_or_default()
        );
        let paper_title = study.get("title").cloned().unwrap_or_default();
        let year = row
            .get("year")
            .and_then(|y| y.parse::<i64>().ok())
            .unwrap_or(0);
        let source = if !row
            .get("journal_published")
            .cloned()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            row.get("journal_published").cloned().unwrap_or_default()
        } else {
            study_id.clone()
        };

        conn.execute(
            "INSERT INTO dataset_records (
                dataset_id, title, paper_title, year, source, source_type,
                public_data_status, species, cell_type, tissue_or_system,
                comparator_class, comparator_detail, modality, modality_family,
                lateral_resolution_nm, axial_resolution_nm, isotropic,
                organelles, organelle_pairs, metric_families, sample_size,
                sample_size_bucket, metadata_completeness_score,
                whole_cell_boundary_confirmed, notes, included_status,
                source_study_id, publication_pmid, source_publication_url,
                public_locator_urls
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                row.get("dataset_locator_id").cloned().unwrap_or_default(),
                title,
                paper_title,
                year,
                source,
                "paper",
                public_status,
                species,
                cell_type,
                Option::<String>::None,
                comparator_class,
                comparator_detail,
                row.get("imaging_modality").cloned().unwrap_or_default(),
                normalize_modality_family(&row.get("imaging_modality").cloned().unwrap_or_default()),
                xy_nm,
                z_nm,
                isotropic,
                serde_json::to_string(&organelles)?,
                serde_json::to_string(&organelle_pairs)?,
                serde_json::to_string(&metrics)?,
                sample_size,
                s_bucket,
                c_score,
                "yes",
                notes,
                included_status,
                study_id,
                publication_pmid,
                source_publication_url,
                serde_json::to_string(&public_locator_urls)?
            ]
        )?;
        count += 1;
    }
    println!("Seeded {} dataset records in SQLite successfully", count);
    Ok(())
}

// ==========================================
// RUST SIDE CAR METADATA ROUTE HANDLERS
// ==========================================

fn query_records(
    conn: &Connection,
    filters: &DatasetFilters,
    apply_limit: bool,
) -> Result<Vec<DatasetRecord>, rusqlite::Error> {
    let mut sql = "SELECT 
        dataset_id, title, paper_title, year, source, source_type, 
        public_data_status, species, cell_type, tissue_or_system, 
        comparator_class, comparator_detail, modality, modality_family, 
        lateral_resolution_nm, axial_resolution_nm, isotropic, 
        organelles, organelle_pairs, metric_families, sample_size, 
        sample_size_bucket, metadata_completeness_score, 
        whole_cell_boundary_confirmed, notes, included_status, 
        source_study_id, publication_pmid, source_publication_url, 
        public_locator_urls
    FROM dataset_records WHERE 1=1"
        .to_string();

    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    let include_borderline = filters.include_borderline.unwrap_or(false);
    if include_borderline {
        sql.push_str(" AND included_status IN ('included', 'borderline')");
    } else {
        sql.push_str(" AND included_status = 'included'");
    }

    if let Some(ref q) = filters.query {
        if !q.trim().is_empty() {
            sql.push_str(
                " AND (
                title LIKE ? OR 
                paper_title LIKE ? OR 
                source_study_id LIKE ? OR 
                publication_pmid LIKE ? OR 
                source LIKE ? OR 
                species LIKE ? OR 
                cell_type LIKE ? OR 
                notes LIKE ?
            )",
            );
            let pattern = format!("%{}%", q);
            for _ in 0..8 {
                params.push(Box::new(pattern.clone()));
            }
        }
    }

    if let Some(yr) = filters.year {
        sql.push_str(" AND year = ?");
        params.push(Box::new(yr));
    }

    if let Some(ref ct) = filters.cell_type {
        if !ct.trim().is_empty() {
            sql.push_str(" AND cell_type LIKE ?");
            params.push(Box::new(format!("%{}%", ct)));
        }
    }

    if let Some(ref org) = filters.organelle {
        if !org.trim().is_empty() {
            sql.push_str(
                " AND EXISTS (SELECT 1 FROM json_each(organelles) WHERE LOWER(value) = LOWER(?))",
            );
            params.push(Box::new(org.clone()));
        }
    }

    if let Some(ref pair) = filters.organelle_pair {
        if !pair.trim().is_empty() {
            sql.push_str(" AND EXISTS (SELECT 1 FROM json_each(organelle_pairs) WHERE LOWER(value) = LOWER(?))");
            params.push(Box::new(pair.clone()));
        }
    }

    if let Some(ref mod_val) = filters.modality {
        if !mod_val.trim().is_empty() {
            sql.push_str(" AND modality LIKE ?");
            params.push(Box::new(format!("%{}%", mod_val)));
        }
    }

    if let Some(ref fam) = filters.modality_family {
        if !fam.trim().is_empty() {
            sql.push_str(" AND modality_family LIKE ?");
            params.push(Box::new(format!("%{}%", fam)));
        }
    }

    if let Some(ref met) = filters.metric_family {
        if !met.trim().is_empty() {
            sql.push_str(" AND EXISTS (SELECT 1 FROM json_each(metric_families) WHERE LOWER(value) = LOWER(?))");
            params.push(Box::new(met.clone()));
        }
    }

    if let Some(ref comp) = filters.comparator_class {
        if !comp.trim().is_empty() {
            sql.push_str(" AND LOWER(comparator_class) = LOWER(?)");
            params.push(Box::new(comp.clone()));
        }
    }

    if let Some(ref stat) = filters.public_data_status {
        if !stat.trim().is_empty() {
            sql.push_str(" AND public_data_status = ?");
            params.push(Box::new(stat.clone()));
        }
    }

    if let Some(true) = filters.public_data_only {
        sql.push_str(" AND public_data_status != 'none'");
    }

    sql.push_str(" ORDER BY year DESC, dataset_id ASC");

    if apply_limit {
        let limit_val = filters.limit.unwrap_or(200).min(500);
        sql.push_str(&format!(" LIMIT {}", limit_val));
    }

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let organelles_str: String = row.get(17)?;
        let organelle_pairs_str: String = row.get(18)?;
        let metric_families_str: String = row.get(19)?;
        let public_locator_urls_str: String = row.get(29)?;

        let organelles: Vec<String> = serde_json::from_str(&organelles_str).unwrap_or_default();
        let organelle_pairs: Vec<String> =
            serde_json::from_str(&organelle_pairs_str).unwrap_or_default();
        let metric_families: Vec<String> =
            serde_json::from_str(&metric_families_str).unwrap_or_default();
        let public_locator_urls: Vec<String> =
            serde_json::from_str(&public_locator_urls_str).unwrap_or_default();

        Ok(DatasetRecord {
            dataset_id: row.get(0)?,
            title: row.get(1)?,
            paper_title: row.get(2)?,
            year: row.get(3)?,
            source: row.get(4)?,
            source_type: row.get(5)?,
            public_data_status: row.get(6)?,
            species: row.get(7)?,
            cell_type: row.get(8)?,
            tissue_or_system: row.get(9)?,
            comparator_class: row.get(10)?,
            comparator_detail: row.get(11)?,
            modality: row.get(12)?,
            modality_family: row.get(13)?,
            lateral_resolution_nm: row.get(14)?,
            axial_resolution_nm: row.get(15)?,
            isotropic: row.get(16)?,
            organelles,
            organelle_pairs,
            metric_families,
            sample_size: row.get(20)?,
            sample_size_bucket: row.get(21)?,
            metadata_completeness_score: row.get(22)?,
            whole_cell_boundary_confirmed: row.get(23)?,
            notes: row.get(24)?,
            included_status: row.get(25)?,
            source_study_id: row.get(26)?,
            publication_pmid: row.get(27)?,
            source_publication_url: row.get(28)?,
            public_locator_urls,
        })
    })?;

    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

async fn handle_search(
    State(state): State<AppState>,
    Query(filters): Query<DatasetFilters>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let all_records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let total = all_records.len();
    let limit_val = filters.limit.unwrap_or(200).min(500);
    let results: Vec<DatasetRecord> = all_records.iter().take(limit_val).cloned().collect();

    // Compute commonalities over all_records
    let mut organelles = std::collections::HashMap::new();
    let mut organelle_pairs = std::collections::HashMap::new();
    let mut metric_families = std::collections::HashMap::new();
    let mut modalities = std::collections::HashMap::new();
    let mut cell_types = std::collections::HashMap::new();

    for r in &all_records {
        for o in &r.organelles {
            *organelles.entry(o.clone()).or_insert(0) += 1;
        }
        for op in &r.organelle_pairs {
            *organelle_pairs.entry(op.clone()).or_insert(0) += 1;
        }
        for m in &r.metric_families {
            *metric_families.entry(m.clone()).or_insert(0) += 1;
        }
        *modalities.entry(r.modality.clone()).or_insert(0) += 1;
        *cell_types.entry(r.cell_type.clone()).or_insert(0) += 1;
    }

    let get_top = |map: std::collections::HashMap<String, i32>, limit: usize| -> Vec<String> {
        let mut v: Vec<(String, i32)> = map.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v.into_iter().take(limit).map(|(k, _)| k).collect()
    };

    let commonalities = serde_json::json!({
        "top_organelles": get_top(organelles, 5),
        "top_organelle_pairs": get_top(organelle_pairs, 5),
        "top_metric_families": get_top(metric_families, 5),
        "top_modalities": get_top(modalities, 5),
        "top_cell_types": get_top(cell_types, 5),
    });

    let response = serde_json::json!({
        "total": total,
        "results": results,
        "commonalities": commonalities,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

#[derive(Deserialize)]
struct ExportParams {
    #[serde(default = "default_export_format")]
    format: String,
    #[serde(flatten)]
    filters: DatasetFilters,
}
fn default_export_format() -> String {
    "csv".to_string()
}

async fn handle_export(
    State(state): State<AppState>,
    Query(params): Query<ExportParams>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &params.filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    if params.format == "json" {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::to_string(&records).unwrap(),
        )
            .into_response();
    }

    if params.format == "bibtex" {
        let mut bib = String::new();
        for d in &records {
            let slug = d.dataset_id.replace('-', "");
            bib.push_str(&format!("@article{{{}, \n", slug));
            bib.push_str(&format!("  title = {{{}}},\n", d.paper_title));
            let author = d
                .source_study_id
                .as_deref()
                .unwrap_or(&d.source)
                .replace("et al.", "")
                .replace("et al", "")
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            bib.push_str(&format!(
                "  author = {{{}}},\n",
                if author.is_empty() {
                    &d.source
                } else {
                    &author
                }
            ));
            bib.push_str(&format!("  journal = {{{}}},\n", d.source));
            bib.push_str(&format!("  year = {{{}}},\n", d.year));
            if let Some(ref pmid) = d.publication_pmid {
                bib.push_str(&format!("  pmid = {{{}}},\n", pmid));
            }
            bib.push_str(&format!(
                "  note = {{Indexed in the Cell Anatomy Corpus: {}}}\n",
                d.title
            ));
            bib.push_str("}\n\n");
        }
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/plain"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=cell_anatomy_corpus_export.bib",
                ),
            ],
            bib,
        )
            .into_response();
    }

    let mut writer = csv::Writer::from_writer(Vec::new());
    let _ = writer.write_record([
        "Dataset ID",
        "Title",
        "Paper Title",
        "Study",
        "PMID",
        "Year",
        "Journal",
        "Species",
        "Cell Type",
        "Modality",
        "Res XY (nm)",
        "Res Z (nm)",
        "Organelles",
        "Metrics",
        "Public Data Status",
        "Included Status",
        "Publication URL",
        "Public Data URLs",
        "Notes",
    ]);

    for d in &records {
        let xy_str = d
            .lateral_resolution_nm
            .map(|x| x.to_string())
            .unwrap_or_default();
        let z_str = d
            .axial_resolution_nm
            .map(|z| z.to_string())
            .unwrap_or_default();
        let _ = writer.write_record([
            &d.dataset_id,
            &d.title,
            &d.paper_title,
            d.source_study_id.as_deref().unwrap_or(""),
            d.publication_pmid.as_deref().unwrap_or(""),
            &d.year.to_string(),
            &d.source,
            &d.species,
            &d.cell_type,
            &d.modality,
            &xy_str,
            &z_str,
            &d.organelles.join("; "),
            &d.metric_families.join("; "),
            &d.public_data_status,
            &d.included_status,
            d.source_publication_url.as_deref().unwrap_or(""),
            &d.public_locator_urls.join("; "),
            d.notes.as_deref().unwrap_or(""),
        ]);
    }

    let csv_bytes = writer.into_inner().unwrap_or_default();
    let csv_string = String::from_utf8(csv_bytes).unwrap_or_default();

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=cell_anatomy_corpus_export.csv",
            ),
        ],
        csv_string,
    )
        .into_response()
}

async fn handle_facets(State(state): State<AppState>) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(
        &conn,
        &DatasetFilters {
            include_borderline: Some(false),
            ..Default::default()
        },
        false,
    ) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut cell_types = std::collections::HashMap::new();
    let mut modalities = std::collections::HashMap::new();
    let mut organelles = std::collections::HashMap::new();
    let mut metric_families = std::collections::HashMap::new();
    let mut comparator_classes = std::collections::HashMap::new();

    for r in records {
        *cell_types.entry(r.cell_type).or_insert(0) += 1;
        *modalities.entry(r.modality).or_insert(0) += 1;
        for o in r.organelles {
            *organelles.entry(o).or_insert(0) += 1;
        }
        for m in r.metric_families {
            *metric_families.entry(m).or_insert(0) += 1;
        }
        if let Some(comp) = r.comparator_class {
            if !comp.trim().is_empty() {
                *comparator_classes.entry(comp).or_insert(0) += 1;
            }
        }
    }

    let sort_and_format = |map: std::collections::HashMap<String, i32>| {
        let mut v: Vec<serde_json::Value> = map
            .into_iter()
            .map(|(k, count)| serde_json::json!({ "value": k, "count": count }))
            .collect();
        v.sort_by(|a, b| {
            let ac = a["count"].as_i64().unwrap_or(0);
            let bc = b["count"].as_i64().unwrap_or(0);
            bc.cmp(&ac).then_with(|| {
                a["value"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(&b["value"].as_str().unwrap_or(""))
            })
        });
        v
    };

    let response = serde_json::json!({
        "cell_types": sort_and_format(cell_types),
        "modalities": sort_and_format(modalities),
        "organelles": sort_and_format(organelles),
        "metric_families": sort_and_format(metric_families),
        "comparator_classes": sort_and_format(comparator_classes),
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

#[derive(Deserialize)]
struct CrossTabParams {
    row: String,
    col: String,
}

fn get_field_value(record: &DatasetRecord, field: &str) -> String {
    let val = match field {
        "cell_type" => record.cell_type.clone(),
        "public_data_status" => record.public_data_status.clone(),
        "modality_family" => record.modality_family.clone(),
        "modality" => record.modality.clone(),
        "species" => record.species.clone(),
        "comparator_class" => record
            .comparator_class
            .clone()
            .unwrap_or("none".to_string()),
        "sample_size_bucket" => record.sample_size_bucket.clone(),
        _ => "none".to_string(),
    };
    if val.trim().is_empty() {
        "none".to_string()
    } else {
        val
    }
}

async fn handle_cross_tab(
    State(state): State<AppState>,
    Query(params): Query<CrossTabParams>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(
        &conn,
        &DatasetFilters {
            include_borderline: Some(true),
            ..Default::default()
        },
        false,
    ) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut counts = std::collections::HashMap::new();
    let mut row_totals = std::collections::HashMap::new();
    let mut col_totals = std::collections::HashMap::new();

    for r in records {
        let r_val = get_field_value(&r, &params.row);
        let c_val = get_field_value(&r, &params.col);
        *counts.entry((r_val.clone(), c_val.clone())).or_insert(0) += 1;
        *row_totals.entry(r_val).or_insert(0) += 1;
        *col_totals.entry(c_val).or_insert(0) += 1;
    }

    let mut rows: Vec<String> = row_totals.keys().cloned().collect();
    rows.sort();
    let mut cols: Vec<String> = col_totals.keys().cloned().collect();
    cols.sort();

    let mut table = serde_json::Map::new();
    for r in &rows {
        let mut row_map = serde_json::Map::new();
        for c in &cols {
            let count = counts.get(&(r.clone(), c.clone())).unwrap_or(&0);
            row_map.insert(c.clone(), serde_json::json!(count));
        }
        table.insert(r.clone(), serde_json::Value::Object(row_map));
    }

    let response = serde_json::json!({
        "table": table,
        "row_totals": row_totals,
        "col_totals": col_totals,
        "rows": rows,
        "cols": cols,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

async fn handle_frontier(
    State(state): State<AppState>,
    Query(filters): Query<DatasetFilters>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let frontier: Vec<serde_json::Value> = records
        .into_iter()
        .filter(|r| r.lateral_resolution_nm.is_some() && r.sample_size.is_some())
        .map(|r| {
            serde_json::json!({
                "id": r.dataset_id,
                "title": r.title,
                "res": r.lateral_resolution_nm,
                "ss": r.sample_size,
                "modality": r.modality_family,
            })
        })
        .collect();

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&frontier).unwrap(),
    )
        .into_response()
}

async fn handle_toolkit(
    State(state): State<AppState>,
    Query(filters): Query<DatasetFilters>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut matrix = serde_json::Map::new();
    let mut organelles_found = std::collections::HashSet::new();
    let mut modalities_found = std::collections::HashSet::new();

    for r in records {
        modalities_found.insert(r.modality_family.clone());
        for o in r.organelles {
            organelles_found.insert(o.clone());
            let organelle_entry = matrix
                .entry(o.clone())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(ref mut m) = organelle_entry {
                let count = m
                    .get(&r.modality_family)
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    + 1;
                m.insert(r.modality_family.clone(), serde_json::json!(count));
            }
        }
    }

    let mut organelles: Vec<String> = organelles_found.into_iter().collect();
    organelles.sort();
    let mut modalities: Vec<String> = modalities_found.into_iter().collect();
    modalities.sort();

    let response = serde_json::json!({
        "matrix": matrix,
        "organelles": organelles,
        "modalities": modalities,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

async fn handle_measurement_grammar(
    State(state): State<AppState>,
    Query(filters): Query<DatasetFilters>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut matrix = serde_json::Map::new();
    let mut organelle_totals = std::collections::HashMap::new();
    let mut metric_totals = std::collections::HashMap::new();

    for r in records {
        for o in &r.organelles {
            *organelle_totals.entry(o.clone()).or_insert(0) += 1;
            let organelle_entry = matrix
                .entry(o.clone())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(ref mut m) = organelle_entry {
                for met in &r.metric_families {
                    *metric_totals.entry(met.clone()).or_insert(0) += 1;
                    let count = m.get(met).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
                    m.insert(met.clone(), serde_json::json!(count));
                }
            }
        }
    }

    let mut organelles: Vec<String> = organelle_totals.keys().cloned().collect();
    let organelle_diversity: std::collections::HashMap<String, usize> = matrix
        .iter()
        .map(|(k, v)| (k.clone(), v.as_object().unwrap().len()))
        .collect();

    organelles.sort_by(|a, b| {
        let div_a = organelle_diversity.get(a).cloned().unwrap_or(0);
        let div_b = organelle_diversity.get(b).cloned().unwrap_or(0);
        let tot_a = organelle_totals.get(a).cloned().unwrap_or(0);
        let tot_b = organelle_totals.get(b).cloned().unwrap_or(0);
        div_b
            .cmp(&div_a)
            .then_with(|| tot_b.cmp(&tot_a))
            .then_with(|| a.cmp(b))
    });

    let mut metric_families: Vec<String> = metric_totals.keys().cloned().collect();
    metric_families.sort_by(|a, b| {
        let tot_a = metric_totals.get(a).cloned().unwrap_or(0);
        let tot_b = metric_totals.get(b).cloned().unwrap_or(0);
        tot_b.cmp(&tot_a).then_with(|| a.cmp(b))
    });

    let response = serde_json::json!({
        "matrix": matrix,
        "organelles": organelles,
        "metric_families": metric_families,
        "organelle_totals": organelle_totals,
        "metric_totals": metric_totals,
        "organelle_metric_family_counts": organelle_diversity,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

async fn handle_reusability_map(
    State(state): State<AppState>,
    Query(filters): Query<DatasetFilters>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut matrix = serde_json::Map::new();
    let mut row_totals = std::collections::HashMap::new();
    let mut reusable_totals = std::collections::HashMap::new();
    let mut reusable_modalities = std::collections::HashMap::new();
    let mut reusable_metrics = std::collections::HashMap::new();

    for r in records {
        for o in &r.organelles {
            *row_totals.entry(o.clone()).or_insert(0) += 1;
            let o_entry = matrix.entry(o.clone()).or_insert_with(|| {
                serde_json::json!({
                    "none": 0,
                    "partial": 0,
                    "complete": 0
                })
            });
            if let Some(count) = o_entry.get_mut(&r.public_data_status) {
                if let Some(c) = count.as_i64() {
                    *count = serde_json::json!(c + 1);
                }
            }

            if r.public_data_status != "none" {
                *reusable_totals.entry(o.clone()).or_insert(0) += 1;
                reusable_modalities
                    .entry(o.clone())
                    .or_insert_with(std::collections::HashSet::new)
                    .insert(r.modality_family.clone());
                for met in &r.metric_families {
                    reusable_metrics
                        .entry(o.clone())
                        .or_insert_with(std::collections::HashSet::new)
                        .insert(met.clone());
                }
            }
        }
    }

    let mut public_share = serde_json::Map::new();
    for (o, total) in &row_totals {
        let reusable = reusable_totals.get(o).cloned().unwrap_or(0);
        let share = if *total > 0 {
            (reusable as f64 / *total as f64 * 1000.0).round() / 1000.0
        } else {
            0.0
        };
        public_share.insert(o.clone(), serde_json::json!(share));
    }

    let mut organelles: Vec<String> = row_totals.keys().cloned().collect();
    organelles.sort_by(|a, b| {
        let re_a = reusable_totals.get(a).cloned().unwrap_or(0);
        let re_b = reusable_totals.get(b).cloned().unwrap_or(0);
        let sh_a = public_share.get(a).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let sh_b = public_share.get(b).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let tot_a = row_totals.get(a).cloned().unwrap_or(0);
        let tot_b = row_totals.get(b).cloned().unwrap_or(0);
        re_b.cmp(&re_a)
            .then_with(|| sh_b.partial_cmp(&sh_a).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| tot_b.cmp(&tot_a))
            .then_with(|| a.cmp(b))
    });

    let reusable_modality_families: serde_json::Map<String, serde_json::Value> =
        reusable_modalities
            .into_iter()
            .map(|(k, set)| {
                let mut v: Vec<String> = set.into_iter().collect();
                v.sort();
                (k, serde_json::json!(v))
            })
            .collect();

    let reusable_metric_families: serde_json::Map<String, serde_json::Value> = reusable_metrics
        .into_iter()
        .map(|(k, set)| {
            let mut v: Vec<String> = set.into_iter().collect();
            v.sort();
            (k, serde_json::json!(v))
        })
        .collect();

    let response = serde_json::json!({
        "matrix": matrix,
        "organelles": organelles,
        "statuses": ["none", "partial", "complete"],
        "row_totals": row_totals,
        "reusable_totals": reusable_totals,
        "public_share": public_share,
        "reusable_modality_families": reusable_modality_families,
        "reusable_metric_families": reusable_metric_families,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

async fn handle_coverage_atlas(
    State(state): State<AppState>,
    Query(filters): Query<DatasetFilters>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut matrix = serde_json::Map::new();
    let mut cell_type_totals = std::collections::HashMap::new();
    let mut organelle_totals = std::collections::HashMap::new();
    let mut cell_type_species = std::collections::HashMap::new();

    for r in records {
        *cell_type_totals.entry(r.cell_type.clone()).or_insert(0) += 1;
        cell_type_species
            .entry(r.cell_type.clone())
            .or_insert_with(std::collections::HashSet::new)
            .insert(r.species.clone());

        let ct_entry = matrix
            .entry(r.cell_type.clone())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(ref mut m) = ct_entry {
            for o in &r.organelles {
                *organelle_totals.entry(o.clone()).or_insert(0) += 1;
                let count = m.get(o).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
                m.insert(o.clone(), serde_json::json!(count));
            }
        }
    }

    let cell_type_organelle_counts: std::collections::HashMap<String, usize> = matrix
        .iter()
        .map(|(k, v)| (k.clone(), v.as_object().unwrap().len()))
        .collect();

    let mut cell_types: Vec<String> = cell_type_totals.keys().cloned().collect();
    cell_types.sort_by(|a, b| {
        let div_a = cell_type_organelle_counts.get(a).cloned().unwrap_or(0);
        let div_b = cell_type_organelle_counts.get(b).cloned().unwrap_or(0);
        let tot_a = cell_type_totals.get(a).cloned().unwrap_or(0);
        let tot_b = cell_type_totals.get(b).cloned().unwrap_or(0);
        div_b
            .cmp(&div_a)
            .then_with(|| tot_b.cmp(&tot_a))
            .then_with(|| a.cmp(b))
    });

    let mut organelles: Vec<String> = organelle_totals.keys().cloned().collect();
    organelles.sort_by(|a, b| {
        let tot_a = organelle_totals.get(a).cloned().unwrap_or(0);
        let tot_b = organelle_totals.get(b).cloned().unwrap_or(0);
        tot_b.cmp(&tot_a).then_with(|| a.cmp(b))
    });

    let cell_type_species_formatted: serde_json::Map<String, serde_json::Value> = cell_type_species
        .into_iter()
        .map(|(k, set)| {
            let mut v: Vec<String> = set.into_iter().collect();
            v.sort();
            (k, serde_json::json!(v))
        })
        .collect();

    let response = serde_json::json!({
        "matrix": matrix,
        "cell_types": cell_types,
        "organelles": organelles,
        "cell_type_totals": cell_type_totals,
        "organelle_totals": organelle_totals,
        "cell_type_organelle_counts": cell_type_organelle_counts,
        "cell_type_species": cell_type_species_formatted,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

async fn handle_timeline(
    State(state): State<AppState>,
    Query(filters): Query<DatasetFilters>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut matrix = serde_json::Map::new();
    let mut year_totals = std::collections::HashMap::new();
    let mut public_counts = std::collections::HashMap::new();
    let mut organelles_by_year = std::collections::HashMap::new();
    let mut metrics_by_year = std::collections::HashMap::new();
    let mut modality_totals = std::collections::HashMap::new();

    for r in records {
        let yr = r.year;
        *year_totals.entry(yr).or_insert(0) += 1;
        *modality_totals
            .entry(r.modality_family.clone())
            .or_insert(0) += 1;

        if r.public_data_status != "none" {
            *public_counts.entry(yr).or_insert(0) += 1;
        }

        organelles_by_year
            .entry(yr)
            .or_insert_with(std::collections::HashSet::new)
            .extend(r.organelles);
        metrics_by_year
            .entry(yr)
            .or_insert_with(std::collections::HashSet::new)
            .extend(r.metric_families);

        let yr_entry = matrix
            .entry(yr.to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(ref mut m) = yr_entry {
            let count = m
                .get(&r.modality_family)
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                + 1;
            m.insert(r.modality_family.clone(), serde_json::json!(count));
        }
    }

    let mut years: Vec<i64> = year_totals.keys().cloned().collect();
    years.sort();

    let mut modality_families: Vec<String> = modality_totals.keys().cloned().collect();
    modality_families.sort_by(|a, b| {
        let tot_a = modality_totals.get(a).cloned().unwrap_or(0);
        let tot_b = modality_totals.get(b).cloned().unwrap_or(0);
        tot_b.cmp(&tot_a).then_with(|| a.cmp(b))
    });

    let mut year_totals_formatted = serde_json::Map::new();
    let mut public_counts_formatted = serde_json::Map::new();
    let mut organelle_counts_formatted = serde_json::Map::new();
    let mut metric_family_counts_formatted = serde_json::Map::new();

    for yr in &years {
        let yr_str = yr.to_string();
        year_totals_formatted.insert(
            yr_str.clone(),
            serde_json::json!(year_totals.get(yr).cloned().unwrap_or(0)),
        );
        public_counts_formatted.insert(
            yr_str.clone(),
            serde_json::json!(public_counts.get(yr).cloned().unwrap_or(0)),
        );
        organelle_counts_formatted.insert(
            yr_str.clone(),
            serde_json::json!(organelles_by_year.get(yr).map(|s| s.len()).unwrap_or(0)),
        );
        metric_family_counts_formatted.insert(
            yr_str.clone(),
            serde_json::json!(metrics_by_year.get(yr).map(|s| s.len()).unwrap_or(0)),
        );
    }

    let response = serde_json::json!({
        "matrix": matrix,
        "years": years,
        "modality_families": modality_families,
        "year_totals": year_totals_formatted,
        "public_counts": public_counts_formatted,
        "organelle_counts": organelle_counts_formatted,
        "metric_family_counts": metric_family_counts_formatted,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

fn build_stats(mut values: Vec<f64>) -> Option<serde_json::Value> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = values[values.len() / 2];
    let sum: f64 = values.iter().sum();
    let average = (sum / values.len() as f64 * 10.0).round() / 10.0;
    Some(serde_json::json!({
        "min": values[0],
        "max": values[values.len() - 1],
        "median": median,
        "avg": average,
    }))
}

async fn handle_benchmarks(State(state): State<AppState>) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(
        &conn,
        &DatasetFilters {
            include_borderline: Some(true),
            ..Default::default()
        },
        false,
    ) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    struct GroupData {
        resolutions: Vec<f64>,
        sample_sizes: Vec<f64>,
        count: i64,
    }

    let mut grouped = std::collections::HashMap::new();
    for r in records {
        let entry = grouped
            .entry(r.modality_family.clone())
            .or_insert_with(|| GroupData {
                resolutions: Vec::new(),
                sample_sizes: Vec::new(),
                count: 0,
            });
        entry.count += 1;
        if let Some(res) = r.lateral_resolution_nm {
            entry.resolutions.push(res);
        }
        if let Some(ss) = r.sample_size {
            entry.sample_sizes.push(ss as f64);
        }
    }

    let mut results = Vec::new();
    for (family, data) in grouped {
        results.push(serde_json::json!({
            "modality_family": family,
            "count": data.count,
            "resolution_stats": build_stats(data.resolutions),
            "sample_size_stats": build_stats(data.sample_sizes),
        }));
    }
    results.sort_by(|a, b| {
        a["modality_family"]
            .as_str()
            .unwrap()
            .cmp(b["modality_family"].as_str().unwrap())
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&results).unwrap(),
    )
        .into_response()
}

#[derive(Deserialize)]
struct PlanParams {
    organelles: String,
    res: Option<f64>,
    ss: Option<i64>,
    cell_type: Option<String>,
    #[serde(rename = "metric")]
    metric_family: Option<String>,
    comparator_class: Option<String>,
    #[serde(rename = "family")]
    modality_family: Option<String>,
}

async fn handle_plan(
    State(state): State<AppState>,
    Query(params): Query<PlanParams>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();

    let target_organelles: Vec<String> = params
        .organelles
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    if target_organelles.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let filters = DatasetFilters {
        cell_type: params.cell_type,
        metric_family: params.metric_family,
        comparator_class: params.comparator_class,
        modality_family: params.modality_family,
        include_borderline: Some(true),
        ..Default::default()
    };

    let datasets = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let bio_matches: Vec<DatasetRecord> = datasets
        .iter()
        .filter(|d| target_organelles.iter().any(|o| d.organelles.contains(o)))
        .cloned()
        .collect();

    let mut strict_matches = Vec::new();
    for d in &bio_matches {
        let mut meets_res = true;
        let mut meets_ss = true;

        if let Some(target_res) = params.res {
            meets_res = d.lateral_resolution_nm.unwrap_or(999.0) <= target_res * 1.5;
        }
        if let Some(target_ss) = params.ss {
            meets_ss = d.sample_size.unwrap_or(0) >= (target_ss as f64 * 0.5) as i64;
        }

        if meets_res && meets_ss {
            strict_matches.push(d.clone());
        }
    }

    let (status, msg) = if bio_matches.is_empty() {
        (
            "frontier",
            "No records in the current corpus capture this organelle target.".to_string(),
        )
    } else if strict_matches.is_empty() {
        ("high-risk", format!("{} matching records exist in the current corpus, but none meet the active threshold filters.", bio_matches.len()))
    } else if strict_matches.len() < 3 {
        ("challenging", format!("Only {} records in the current corpus meet the active threshold filters for this target.", strict_matches.len()))
    } else {
        (
            "feasible",
            format!(
                "{} records in the current corpus meet the active filters for this target.",
                strict_matches.len()
            ),
        )
    };

    let mut modality_counts = std::collections::HashMap::new();
    for d in &bio_matches {
        *modality_counts.entry(d.modality.clone()).or_insert(0) += 1;
    }
    let top_modality = modality_counts
        .into_iter()
        .max_by_key(|&(_, count)| count)
        .map(|(m, _)| m)
        .unwrap_or_else(|| "Unknown".to_string());

    let mut metrics_found = std::collections::HashMap::new();
    for d in &bio_matches {
        for m in &d.metric_families {
            *metrics_found.entry(m.clone()).or_insert(0) += 1;
        }
    }
    let mut sorted_metrics: Vec<String> = metrics_found.keys().cloned().collect();
    sorted_metrics.sort_by(|a, b| {
        let count_a = metrics_found.get(a).unwrap_or(&0);
        let count_b = metrics_found.get(b).unwrap_or(&0);
        count_b.cmp(count_a).then_with(|| a.cmp(b))
    });
    let standard_metrics: Vec<String> = sorted_metrics.into_iter().take(3).collect();

    let suggested_baselines: Vec<DatasetRecord> = bio_matches
        .iter()
        .filter(|d| d.public_data_status != "none")
        .take(3)
        .cloned()
        .collect();

    let precedents = if !strict_matches.is_empty() {
        strict_matches.clone()
    } else {
        bio_matches.clone()
    };

    let response = serde_json::json!({
        "biological_target": target_organelles.join(" & "),
        "target_res_nm": params.res,
        "target_sample_size": params.ss,
        "status": status,
        "status_message": msg,
        "modality_recommendation": format!("In the current corpus, {} is the most common modality for this target ({} matching records).", top_modality, bio_matches.len()),
        "precedents": precedents,
        "standard_metrics": standard_metrics,
        "suggested_baselines": suggested_baselines,
        "matched_records_count": bio_matches.len(),
        "threshold_records_count": strict_matches.len(),
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

#[derive(Deserialize)]
struct PlanExportParams {
    #[serde(flatten)]
    plan_params: PlanParams,
    precedent_query: Option<String>,
    precedent_public: Option<String>,
    precedent_sort: Option<String>,
}

async fn handle_plan_export(
    State(state): State<AppState>,
    Query(params): Query<PlanExportParams>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();

    let target_organelles: Vec<String> = params
        .plan_params
        .organelles
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    if target_organelles.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let filters = DatasetFilters {
        cell_type: params.plan_params.cell_type,
        metric_family: params.plan_params.metric_family,
        comparator_class: params.plan_params.comparator_class,
        modality_family: params.plan_params.modality_family,
        include_borderline: Some(true),
        ..Default::default()
    };

    let datasets = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let bio_matches: Vec<DatasetRecord> = datasets
        .iter()
        .filter(|d| target_organelles.iter().any(|o| d.organelles.contains(o)))
        .cloned()
        .collect();

    let mut strict_matches = Vec::new();
    for d in &bio_matches {
        let mut meets_res = true;
        let mut meets_ss = true;

        if let Some(target_res) = params.plan_params.res {
            meets_res = d.lateral_resolution_nm.unwrap_or(999.0) <= target_res * 1.5;
        }
        if let Some(target_ss) = params.plan_params.ss {
            meets_ss = d.sample_size.unwrap_or(0) >= (target_ss as f64 * 0.5) as i64;
        }

        if meets_res && meets_ss {
            strict_matches.push(d.clone());
        }
    }

    let precedents = if !strict_matches.is_empty() {
        strict_matches
    } else {
        bio_matches
    };

    let mut filtered_precedents = precedents;
    if let Some(ref pq) = params.precedent_query {
        let query_lower = pq.trim().to_lowercase();
        if !query_lower.is_empty() {
            filtered_precedents = filtered_precedents
                .into_iter()
                .filter(|d| {
                    let haystack = format!(
                        "{} {} {} {} {} {} {} {} {} {}",
                        d.dataset_id,
                        d.source_study_id.as_deref().unwrap_or(""),
                        d.publication_pmid.as_deref().unwrap_or(""),
                        d.paper_title,
                        d.source,
                        d.cell_type,
                        d.species,
                        d.modality,
                        d.comparator_class.as_deref().unwrap_or(""),
                        d.comparator_detail.as_deref().unwrap_or(""),
                    )
                    .to_lowercase();
                    haystack.contains(&query_lower)
                })
                .collect();
        }
    }

    if let Some(ref pub_state) = params.precedent_public {
        if !pub_state.trim().is_empty() {
            filtered_precedents = filtered_precedents
                .into_iter()
                .filter(|d| d.public_data_status == *pub_state)
                .collect();
        }
    }

    let sort_key = params
        .precedent_sort
        .unwrap_or_else(|| "year_desc".to_string());
    filtered_precedents.sort_by(|a, b| match sort_key.as_str() {
        "year_asc" => a
            .year
            .cmp(&b.year)
            .then_with(|| a.dataset_id.cmp(&b.dataset_id)),
        "author_asc" => {
            let auth_a = a
                .source_study_id
                .as_deref()
                .unwrap_or(&a.dataset_id)
                .to_lowercase();
            let auth_b = b
                .source_study_id
                .as_deref()
                .unwrap_or(&b.dataset_id)
                .to_lowercase();
            auth_a
                .cmp(&auth_b)
                .then_with(|| b.year.cmp(&a.year))
                .then_with(|| a.dataset_id.cmp(&b.dataset_id))
        }
        "sample_desc" => {
            let ss_a = a.sample_size.unwrap_or(-1);
            let ss_b = b.sample_size.unwrap_or(-1);
            ss_b.cmp(&ss_a)
                .then_with(|| b.year.cmp(&a.year))
                .then_with(|| a.dataset_id.cmp(&b.dataset_id))
        }
        "res_asc" => {
            let res_a = a.lateral_resolution_nm.unwrap_or(f64::INFINITY);
            let res_b = b.lateral_resolution_nm.unwrap_or(f64::INFINITY);
            res_a
                .partial_cmp(&res_b)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.year.cmp(&a.year))
                .then_with(|| a.dataset_id.cmp(&b.dataset_id))
        }
        "public_first" => {
            let r_a = match a.public_data_status.as_str() {
                "complete" => 2,
                "partial" => 1,
                _ => 0,
            };
            let r_b = match b.public_data_status.as_str() {
                "complete" => 2,
                "partial" => 1,
                _ => 0,
            };
            r_b.cmp(&r_a)
                .then_with(|| b.year.cmp(&a.year))
                .then_with(|| a.dataset_id.cmp(&b.dataset_id))
        }
        _ => b
            .year
            .cmp(&a.year)
            .then_with(|| a.dataset_id.cmp(&b.dataset_id)),
    });

    let mut writer = csv::Writer::from_writer(Vec::new());
    let _ = writer.write_record([
        "Dataset ID",
        "Study",
        "PMID",
        "Paper Title",
        "Year",
        "Journal",
        "Cell Type",
        "Species",
        "Modality",
        "Modality Family",
        "Res XY (nm)",
        "Res Z (nm)",
        "Sample Size",
        "Organelles",
        "Metrics",
        "Comparator Class",
        "Comparator Detail",
        "Public Data Status",
        "Publication URL",
    ]);

    for d in &filtered_precedents {
        let xy_str = d
            .lateral_resolution_nm
            .map(|x| x.to_string())
            .unwrap_or_default();
        let z_str = d
            .axial_resolution_nm
            .map(|z| z.to_string())
            .unwrap_or_default();
        let ss_str = d.sample_size.map(|s| s.to_string()).unwrap_or_default();
        let _ = writer.write_record([
            &d.dataset_id,
            d.source_study_id.as_deref().unwrap_or(""),
            d.publication_pmid.as_deref().unwrap_or(""),
            &d.paper_title,
            &d.year.to_string(),
            &d.source,
            &d.cell_type,
            &d.species,
            &d.modality,
            &d.modality_family,
            &xy_str,
            &z_str,
            &ss_str,
            &d.organelles.join("; "),
            &d.metric_families.join("; "),
            d.comparator_class.as_deref().unwrap_or(""),
            d.comparator_detail.as_deref().unwrap_or(""),
            &d.public_data_status,
            d.source_publication_url.as_deref().unwrap_or(""),
        ]);
    }

    let csv_bytes = writer.into_inner().unwrap_or_default();
    let csv_string = String::from_utf8(csv_bytes).unwrap_or_default();

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=cell_anatomy_plan_precedents.csv",
            ),
        ],
        csv_string,
    )
        .into_response()
}

async fn handle_get_dataset(
    State(state): State<AppState>,
    axum::extract::Path(dataset_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let filters = DatasetFilters {
        include_borderline: Some(true),
        ..Default::default()
    };
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    if let Some(dataset) = records.into_iter().find(|r| r.dataset_id == dataset_id) {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::to_string(&dataset).unwrap(),
        )
            .into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

fn similarity_score(left: &DatasetRecord, right: &DatasetRecord) -> i32 {
    let mut score = 0;
    if left.cell_type == right.cell_type {
        score += 40;
    }
    if left.species == right.species {
        score += 10;
    }
    if left.modality_family == right.modality_family {
        score += 10;
    }
    let set_a: std::collections::HashSet<&String> = left.organelles.iter().collect();
    let set_b: std::collections::HashSet<&String> = right.organelles.iter().collect();
    let common_orgs = set_a.intersection(&set_b).count() as i32;
    score += common_orgs * 5;

    let m_a: std::collections::HashSet<&String> = left.metric_families.iter().collect();
    let m_b: std::collections::HashSet<&String> = right.metric_families.iter().collect();
    let common_metrics = m_a.intersection(&m_b).count() as i32;
    score += common_metrics * 5;

    score
}

async fn handle_get_similar(
    State(state): State<AppState>,
    axum::extract::Path(dataset_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let filters = DatasetFilters {
        include_borderline: Some(true),
        ..Default::default()
    };
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let target = match records.iter().find(|r| r.dataset_id == dataset_id) {
        Some(t) => t.clone(),
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let mut scored: Vec<(DatasetRecord, i32)> = records
        .into_iter()
        .filter(|r| r.dataset_id != dataset_id)
        .map(|r| {
            let score = similarity_score(&r, &target);
            (r, score)
        })
        .collect();

    scored.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| b.0.year.cmp(&a.0.year))
            .then_with(|| a.0.dataset_id.cmp(&b.0.dataset_id))
    });

    let result: Vec<DatasetRecord> = scored.into_iter().take(4).map(|(r, _)| r).collect();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&result).unwrap(),
    )
        .into_response()
}

#[derive(Deserialize)]
struct CompareRequest {
    dataset_ids: Vec<String>,
}

async fn handle_compare(
    State(state): State<AppState>,
    axum::extract::Json(payload): axum::extract::Json<CompareRequest>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let filters = DatasetFilters {
        include_borderline: Some(true),
        ..Default::default()
    };
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut selected = Vec::new();
    for id in &payload.dataset_ids {
        if let Some(r) = records.iter().find(|d| d.dataset_id == *id) {
            selected.push(r.clone());
        }
    }

    if selected.len() != payload.dataset_ids.len() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let intersect = |groups: Vec<&Vec<String>>| -> Vec<String> {
        if groups.is_empty() {
            return Vec::new();
        }
        let mut shared: std::collections::HashSet<String> = groups[0].iter().cloned().collect();
        for group in groups.iter().skip(1) {
            let next_set: std::collections::HashSet<String> = group.iter().cloned().collect();
            shared = shared.intersection(&next_set).cloned().collect();
        }
        let mut v: Vec<String> = shared.into_iter().collect();
        v.sort();
        v
    };

    let unique = |groups: Vec<Vec<String>>| -> Vec<String> {
        let mut unique_vals = std::collections::HashSet::new();
        for group in groups {
            unique_vals.extend(group);
        }
        let mut v: Vec<String> = unique_vals.into_iter().collect();
        v.sort();
        v
    };

    let cell_types_groups: Vec<Vec<String>> =
        selected.iter().map(|d| vec![d.cell_type.clone()]).collect();
    let species_groups: Vec<Vec<String>> =
        selected.iter().map(|d| vec![d.species.clone()]).collect();
    let organelles_groups: Vec<&Vec<String>> = selected.iter().map(|d| &d.organelles).collect();
    let pairs_groups: Vec<&Vec<String>> = selected.iter().map(|d| &d.organelle_pairs).collect();
    let metrics_groups: Vec<&Vec<String>> = selected.iter().map(|d| &d.metric_families).collect();
    let comparators_groups: Vec<Vec<String>> = selected
        .iter()
        .filter_map(|d| d.comparator_class.clone().map(|c| vec![c]))
        .collect();
    let modality_family_groups: Vec<Vec<String>> = selected
        .iter()
        .map(|d| vec![d.modality_family.clone()])
        .collect();

    let shared_fields = serde_json::json!({
        "cell_types": intersect(cell_types_groups.iter().collect()),
        "species": intersect(species_groups.iter().collect()),
        "organelles": intersect(organelles_groups),
        "organelle_pairs": intersect(pairs_groups),
        "metric_families": intersect(metrics_groups),
        "comparator_classes": intersect(comparators_groups.iter().collect()),
        "modality_families": intersect(modality_family_groups.iter().collect()),
    });

    let key_differences = serde_json::json!({
        "modalities": unique(selected.iter().map(|d| vec![d.modality.clone()]).collect()),
        "sample_size_buckets": unique(selected.iter().map(|d| vec![d.sample_size_bucket.clone()]).collect()),
        "public_data_statuses": unique(selected.iter().map(|d| vec![d.public_data_status.clone()]).collect()),
        "boundary_confirmation": unique(selected.iter().map(|d| vec![d.whole_cell_boundary_confirmed.clone()]).collect()),
    });

    let mut score = 0;
    let all_same_cell_type = selected
        .iter()
        .map(|d| &d.cell_type)
        .collect::<std::collections::HashSet<_>>()
        .len()
        == 1;
    if all_same_cell_type {
        score += 25;
    }

    let all_same_species = selected
        .iter()
        .map(|d| &d.species)
        .collect::<std::collections::HashSet<_>>()
        .len()
        == 1;
    if all_same_species {
        score += 10;
    }

    let shared_pairs = shared_fields["organelle_pairs"].as_array().unwrap();
    if !shared_pairs.is_empty() {
        score += std::cmp::min(20, 5 * shared_pairs.len() as i64);
    }

    let shared_metrics = shared_fields["metric_families"].as_array().unwrap();
    if !shared_metrics.is_empty() {
        score += std::cmp::min(15, 3 * shared_metrics.len() as i64);
    }

    let all_same_mod_fam = selected
        .iter()
        .map(|d| &d.modality_family)
        .collect::<std::collections::HashSet<_>>()
        .len()
        == 1;
    if all_same_mod_fam {
        score += 10;
    }

    let shared_comparators = shared_fields["comparator_classes"].as_array().unwrap();
    if !shared_comparators.is_empty() {
        score += 10;
    }

    let all_completeness_high = selected
        .iter()
        .all(|d| d.metadata_completeness_score >= 0.8);
    if all_completeness_high {
        score += 10;
    }

    score = std::cmp::min(score, 100);

    let summary = if score >= 75 {
        "High biological overlap with enough shared structure to justify direct comparison."
    } else if score >= 50 {
        "Moderate comparability; useful for targeted comparison with technical caveats."
    } else {
        "Low direct comparability; treat these datasets as analogs rather than close matches."
    };

    let response = serde_json::json!({
        "datasets": selected,
        "shared_fields": shared_fields,
        "key_differences": key_differences,
        "comparability_score": score,
        "summary": summary,
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&response).unwrap(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn volume_engine_auth_requires_the_packaged_sidecar_token() {
        assert!(volume_engine_request_authorized(None, None));
        assert!(volume_engine_request_authorized(
            Some("secret"),
            Some("secret")
        ));
        assert!(!volume_engine_request_authorized(Some("secret"), None));
        assert!(!volume_engine_request_authorized(
            Some("secret"),
            Some("wrong")
        ));
    }

    fn private_workset_fixture(workset_id: &str) -> PathBuf {
        let root = std::env::temp_dir().join(unique_local_id("caos_private_workset_test"));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("workset.json"),
            serde_json::to_vec(&json!({
                "schema": "cell-anatomy-archive-workset",
                "schema_version": 1,
                "workset_id": workset_id,
                "title": "Fixture Workset",
                "source_registry": {
                    "registry_id": "fixture-registry",
                    "archive_id": "fixture-archive",
                    "archive_root": root
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let asset = json!({
            "schema": "cell-anatomy-archive-workset-asset",
            "schema_version": 1,
            "asset_id": "fixture-asset",
            "relative_path": "raw/cell.mrc",
            "size_bytes": 1072,
            "metadata": {
                "format": "MRC",
                "dtype": "uint16",
                "dimensions": { "z": 2, "y": 3, "x": 4 },
                "voxel_size_nm": { "z": 5.0, "y": 2.0, "x": 2.0 }
            },
            "status": { "allowed_operations": { "can_convert": true } },
            "readiness": { "conversion_ready": true, "blockers": [] },
            "promotion": { "blocked_operations": [] }
        });
        fs::write(
            root.join("workset-assets.jsonl"),
            format!("{}\n", serde_json::to_string(&asset).unwrap()),
        )
        .unwrap();
        root.join("workset.json").canonicalize().unwrap()
    }

    #[test]
    fn private_workset_registers_as_a_runnable_conversion_queue() {
        let workset_path = private_workset_fixture("fixture-workset");
        let dataset = private_workset_dataset_payload(&workset_path).unwrap();
        assert_eq!(
            dataset["slug"],
            "private-workset:fixture-archive:fixture-workset"
        );
        assert_eq!(dataset["readiness"]["ready_assets"], 1);
        assert_eq!(dataset["assets"][0]["index_status"], "ready_for_conversion");

        let registry = Arc::new(Mutex::new(BTreeMap::from([(
            "private-workset:fixture-archive:fixture-workset".to_string(),
            workset_path.clone(),
        )])));
        let request = StartIndexJobRequest {
            kind: "convert".to_string(),
            dataset_slug: "private-workset:fixture-archive:fixture-workset".to_string(),
            asset_relative_path: "raw/cell.mrc".to_string(),
        };
        let (kind, command, display, _) = resolve_index_job_command(&request, &registry).unwrap();
        assert_eq!(kind, "convert");
        assert_eq!(command[0], "python3");
        assert!(command
            .iter()
            .any(|value| value.ends_with("private_workset_derivative.py")));
        assert!(command.iter().any(|value| value == "fixture-asset"));
        assert!(display.contains("--workset"));

        fs::remove_dir_all(workset_path.parent().unwrap()).unwrap();
    }

    #[test]
    fn private_worksets_from_one_archive_keep_distinct_queue_identities() {
        let first = private_workset_fixture("pilot-one");
        let second = private_workset_fixture("pilot-two");
        let first_dataset = private_workset_dataset_payload(&first).unwrap();
        let second_dataset = private_workset_dataset_payload(&second).unwrap();
        let first_slug = value_str(&first_dataset, "slug").to_string();
        let second_slug = value_str(&second_dataset, "slug").to_string();
        assert_ne!(first_slug, second_slug);
        let registered =
            BTreeMap::from([(first_slug, first.clone()), (second_slug, second.clone())]);
        assert_eq!(registered.len(), 2);

        fs::remove_dir_all(first.parent().unwrap()).unwrap();
        fs::remove_dir_all(second.parent().unwrap()).unwrap();
    }

    fn fixture_queue() -> Value {
        json!({
            "root": "/tmp/scion-public-data",
            "root_exists": true,
            "datasets": [
                {
                    "slug": "alpha",
                    "dataset": { "title": "Alpha cells" },
                    "assets": [
                        {
                            "relative_path": "a1.tif",
                            "format": "TIFF",
                            "size_bytes": 100,
                            "dimensions": { "z": 3, "y": 4, "x": 5 },
                            "index_status": "ready_for_conversion",
                            "convert_command": "convert alpha a1"
                        },
                        {
                            "relative_path": "a2.tif",
                            "format": "TIFF",
                            "index_status": "ready_for_conversion",
                            "convert_command": "convert alpha a2"
                        }
                    ]
                },
                {
                    "slug": "beta",
                    "dataset": { "title": "Beta cells" },
                    "assets": [
                        {
                            "relative_path": "b1.tif",
                            "format": "TIFF",
                            "index_status": "ready_for_conversion",
                            "convert_command": "convert beta b1"
                        },
                        {
                            "relative_path": "b2.tif",
                            "format": "TIFF",
                            "index_status": "ready_for_conversion",
                            "convert_command": "convert beta b2"
                        }
                    ]
                }
            ]
        })
    }

    fn fixture_job(
        status: &str,
        dataset_slug: &str,
        asset_relative_path: &str,
        created_at_ms: u64,
    ) -> IndexJobRecord {
        IndexJobRecord {
            id: format!("job_{created_at_ms}"),
            kind: "convert".to_string(),
            dataset_slug: dataset_slug.to_string(),
            asset_relative_path: asset_relative_path.to_string(),
            status: status.to_string(),
            created_at_ms,
            started_at_ms: None,
            finished_at_ms: None,
            exit_code: None,
            pid: None,
            command: vec!["python3".to_string()],
            command_display: "python3 convert".to_string(),
            log: Vec::new(),
            error: None,
        }
    }

    #[test]
    fn batch_plan_applies_total_and_per_dataset_limits() {
        let queue = fixture_queue();
        let request = IndexBatchPlanRequest {
            kind: "convert".to_string(),
            dataset_slug: None,
            total_limit: Some(3),
            per_dataset_limit: Some(1),
            retry_failed: None,
            skip_completed: None,
        };

        let plan = build_index_batch_plan(&queue, &BTreeMap::new(), &request).unwrap();
        assert_eq!(plan["summary"]["candidate_count"], 4);
        assert_eq!(plan["summary"]["planned_count"], 2);
        assert_eq!(plan["summary"]["skipped_limit"], 2);
        assert_eq!(
            plan["items"].as_array().unwrap()[0]["dataset_slug"],
            "alpha"
        );
        assert_eq!(plan["items"].as_array().unwrap()[1]["dataset_slug"], "beta");
    }

    #[test]
    fn batch_plan_skips_active_and_requires_retry_failed_flag() {
        let queue = fixture_queue();
        let mut jobs = BTreeMap::new();
        jobs.insert(
            "active".to_string(),
            fixture_job("running", "alpha", "a1.tif", 1),
        );
        jobs.insert(
            "failed".to_string(),
            fixture_job("failed", "alpha", "a2.tif", 2),
        );

        let request = IndexBatchPlanRequest {
            kind: "convert".to_string(),
            dataset_slug: Some("alpha".to_string()),
            total_limit: Some(4),
            per_dataset_limit: Some(4),
            retry_failed: Some(false),
            skip_completed: None,
        };
        let plan = build_index_batch_plan(&queue, &jobs, &request).unwrap();
        assert_eq!(plan["summary"]["planned_count"], 0);
        assert_eq!(plan["summary"]["skipped_active"], 1);
        assert_eq!(plan["summary"]["skipped_previous_failed"], 1);

        let retry_request = IndexBatchPlanRequest {
            retry_failed: Some(true),
            ..request
        };
        let retry_plan = build_index_batch_plan(&queue, &jobs, &retry_request).unwrap();
        assert_eq!(retry_plan["summary"]["planned_count"], 1);
        assert_eq!(
            retry_plan["items"].as_array().unwrap()[0]["asset_relative_path"],
            "a2.tif"
        );
    }

    #[test]
    fn batch_run_from_plan_tracks_pending_items_and_concurrency() {
        let queue = fixture_queue();
        let request = IndexBatchPlanRequest {
            kind: "convert".to_string(),
            dataset_slug: None,
            total_limit: Some(2),
            per_dataset_limit: Some(2),
            retry_failed: None,
            skip_completed: None,
        };
        let plan = build_index_batch_plan(&queue, &BTreeMap::new(), &request).unwrap();

        let run = build_index_batch_run_from_plan(&plan, Some(2)).unwrap();
        assert_eq!(run.plan_id, plan["plan_id"].as_str().unwrap());
        assert_eq!(run.kind, "convert");
        assert_eq!(run.concurrency, 2);
        assert_eq!(run.status, "queued");
        assert_eq!(run.summary.total, 2);
        assert_eq!(run.summary.pending, 2);
        assert_eq!(run.items[0].dataset_slug, "alpha");
        assert!(run.checkpoint_path.ends_with(".json"));
    }

    #[test]
    fn batch_run_reconciles_terminal_child_job_status() {
        let queue = fixture_queue();
        let request = IndexBatchPlanRequest {
            kind: "convert".to_string(),
            dataset_slug: Some("alpha".to_string()),
            total_limit: Some(1),
            per_dataset_limit: Some(1),
            retry_failed: None,
            skip_completed: None,
        };
        let plan = build_index_batch_plan(&queue, &BTreeMap::new(), &request).unwrap();
        let mut run = build_index_batch_run_from_plan(&plan, Some(1)).unwrap();
        run.items[0].status = "running".to_string();
        run.items[0].job_id = Some("child".to_string());

        let mut jobs = BTreeMap::new();
        let mut job = fixture_job("completed", "alpha", "a1.tif", 42);
        job.id = "child".to_string();
        job.started_at_ms = Some(43);
        job.finished_at_ms = Some(44);
        jobs.insert(job.id.clone(), job);

        reconcile_index_batch_items(&mut run, &jobs);
        assert_eq!(run.items[0].status, "completed");
        assert_eq!(run.items[0].started_at_ms, Some(43));
        assert_eq!(run.items[0].finished_at_ms, Some(44));
    }

    #[test]
    fn batch_resume_requires_retry_flag_for_failed_items() {
        let queue = fixture_queue();
        let request = IndexBatchPlanRequest {
            kind: "convert".to_string(),
            dataset_slug: Some("alpha".to_string()),
            total_limit: Some(2),
            per_dataset_limit: Some(2),
            retry_failed: None,
            skip_completed: None,
        };
        let plan = build_index_batch_plan(&queue, &BTreeMap::new(), &request).unwrap();
        let mut run = build_index_batch_run_from_plan(&plan, Some(1)).unwrap();
        run.status = "failed".to_string();
        run.items[0].status = "completed".to_string();
        run.items[1].status = "failed".to_string();

        assert!(prepare_index_batch_resume(&mut run.clone(), false).is_err());
        prepare_index_batch_resume(&mut run, true).unwrap();
        assert_eq!(run.status, "queued");
        assert_eq!(run.items[0].status, "completed");
        assert_eq!(run.items[1].status, "pending");
        assert_eq!(run.summary.pending, 1);
    }
}

// ==========================================
// DAEMON MAIN ENTRY POINT
// ==========================================

#[tokio::main]
async fn main() {
    // Initialize SQLite database completely in memory
    let mut conn = Connection::open_in_memory().unwrap();
    if let Err(e) = seed_database(&mut conn) {
        eprintln!("Failed to seed in-memory SQLite database: {:?}", e);
        std::process::exit(1);
    }

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        index_jobs: Arc::new(Mutex::new(BTreeMap::new())),
        index_batch_runs: Arc::new(Mutex::new(load_index_batch_runs())),
        private_worksets: Arc::new(Mutex::new(load_private_workset_registry())),
    };
    let auth = VolumeEngineAuth {
        token: std::env::var("CELL_ANATOMY_VOLUME_ENGINE_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    };
    if auth.token.is_some() {
        println!("Volume engine loopback authentication enabled");
    } else {
        println!("Volume engine loopback authentication disabled for standalone development");
    }

    let app = Router::new()
        .route("/api/health", get(handle_health))
        .route("/api/volume/slice", get(handle_slice))
        .route("/api/volume/3d", get(handle_volume_3d))
        .route("/api/volume/workbench-data", get(handle_workbench_data))
        .route("/api/volume/open-local", get(handle_open_local))
        .route("/api/volume/index-queue", get(handle_index_queue))
        .route(
            "/api/volume/private-worksets/register",
            post(handle_register_private_workset),
        )
        .route(
            "/api/volume/index-jobs",
            get(handle_list_index_jobs).post(handle_start_index_job),
        )
        .route(
            "/api/volume/index-batch-plan",
            post(handle_index_batch_plan),
        )
        .route(
            "/api/volume/index-batch-runs",
            get(handle_list_index_batch_runs).post(handle_start_index_batch_run),
        )
        .route(
            "/api/volume/index-batch-runs/:run_id/cancel",
            post(handle_cancel_index_batch_run),
        )
        .route(
            "/api/volume/index-batch-runs/:run_id/resume",
            post(handle_resume_index_batch_run),
        )
        .route(
            "/api/volume/index-jobs/:job_id/cancel",
            post(handle_cancel_index_job),
        )
        .route(
            "/api/volume/index-jobs/:job_id/retry",
            post(handle_retry_index_job),
        )
        .route("/api/datasets", get(handle_search))
        .route("/api/datasets/export", get(handle_export))
        .route("/api/datasets/facets", get(handle_facets))
        .route("/api/datasets/analytics/cross-tab", get(handle_cross_tab))
        .route("/api/datasets/analytics/frontier", get(handle_frontier))
        .route("/api/datasets/analytics/toolkit", get(handle_toolkit))
        .route(
            "/api/datasets/analytics/measurement-grammar",
            get(handle_measurement_grammar),
        )
        .route(
            "/api/datasets/analytics/reusability-map",
            get(handle_reusability_map),
        )
        .route(
            "/api/datasets/analytics/coverage-atlas",
            get(handle_coverage_atlas),
        )
        .route("/api/datasets/analytics/timeline", get(handle_timeline))
        .route("/api/datasets/analytics/benchmarks", get(handle_benchmarks))
        .route("/api/datasets/analytics/plan", get(handle_plan))
        .route(
            "/api/datasets/analytics/plan/export",
            get(handle_plan_export),
        )
        .route("/api/datasets/:dataset_id", get(handle_get_dataset))
        .route("/api/datasets/:dataset_id/similar", get(handle_get_similar))
        .route("/api/datasets/compare", axum::routing::post(handle_compare))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            auth,
            require_volume_engine_auth,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
                .expose_headers([
                    header::HeaderName::from_static("x-width"),
                    header::HeaderName::from_static("x-height"),
                    header::HeaderName::from_static("x-depth"),
                    header::HeaderName::from_static("x-dtype"),
                    header::HeaderName::from_static("x-voxel-size-z"),
                    header::HeaderName::from_static("x-voxel-size-y"),
                    header::HeaderName::from_static("x-voxel-size-x"),
                ]),
        );

    let port = std::env::var("CELL_ANATOMY_VOLUME_ENGINE_PORT")
        .or_else(|_| std::env::var("SCION_VOLUME_ENGINE_PORT"))
        .unwrap_or_else(|_| "8080".to_string())
        .parse::<u16>()
        .unwrap_or(8080);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!(
        "Cell Anatomy Volumetric Sidecar + SQLite engine running on http://{}",
        addr
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
