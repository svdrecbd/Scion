use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tower_http::cors::{Any, CorsLayer};
use rusqlite::Connection;

static CUSTOM_DATASETS: OnceLock<Mutex<Vec<serde_json::Value>>> = OnceLock::new();
fn get_custom_datasets() -> &'static Mutex<Vec<serde_json::Value>> {
    CUSTOM_DATASETS.get_or_init(|| Mutex::new(Vec::new()))
}


// Embed metadata CSVs for full self-contained offline capability
const STUDY_MANIFEST_CSV: &str = include_str!("../../../references/manifests/study_manifest.csv");
const CORPUS_LOCATOR_CSV: &str = include_str!("../../../references/manifests/corpus_locator.csv");
const PUBLIC_DATA_ASSETS_CSV: &str = include_str!("../../../references/manifests/public_data_assets.csv");

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
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

fn locate_zarr_derivative(dataset: &str, asset_path: &str) -> Option<DerivativeEntry> {
    if dataset.starts_with("custom_") {
        let guard = get_custom_datasets().lock().unwrap();
        for val in guard.iter() {
            if let Some(slug) = val.get("slug").and_then(|s| s.as_str()) {
                if slug == dataset {
                    if let Some(derivatives) = val.get("derivatives").and_then(|d| d.as_array()) {
                        for d in derivatives {
                            if let Ok(entry) = serde_json::from_value::<DerivativeEntry>(d.clone()) {
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

async fn handle_slice(Query(params): Query<SliceParams>) -> impl IntoResponse {
    let entry = match locate_zarr_derivative(&params.dataset, &params.asset) {
        Some(e) => e,
        None => {
            return (
                StatusCode::NOT_FOUND,
                "Dataset or derivative not found",
            ).into_response()
        }
    };

    let zarr_dir = PathBuf::from(&entry.output_path);
    let zarr_config = match parse_zarray(&zarr_dir) {
        Some(c) => c,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse .zarray metadata",
            ).into_response()
        }
    };

    let shape = &zarr_config.shape;
    let chunks = &zarr_config.chunks;
    if shape.len() != 3 || chunks.len() != 3 {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid OME-Zarr array shape/chunks dimensions",
        ).into_response();
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
            ).into_response()
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
                ).into_response();
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
                                        .copy_from_slice(&chunk_data[src_offset..(src_offset + len_to_copy)]);
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
                ).into_response();
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
                                    let src_offset = ((lz * y_len * x_len) + (yo * x_len)) * elem_size;
                                    let dest_z = (zc * cz) + lz;
                                    let dest_x = xc * cx;
                                    let dest_offset = ((dest_z * x_max) + dest_x) * elem_size;

                                    let len_to_copy = x_len * elem_size;
                                    out_buffer[dest_offset..(dest_offset + len_to_copy)]
                                        .copy_from_slice(&chunk_data[src_offset..(src_offset + len_to_copy)]);
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
                ).into_response();
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
                                        let src_offset = ((lz * y_len * x_len) + (ly * x_len) + xo) * elem_size;
                                        let dest_z = (zc * cz) + lz;
                                        let dest_y = (yc * cy) + ly;
                                        let dest_offset = ((dest_z * y_max) + dest_y) * elem_size;

                                        out_buffer[dest_offset..(dest_offset + elem_size)]
                                            .copy_from_slice(&chunk_data[src_offset..(src_offset + elem_size)]);
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
            ).into_response()
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
        header::HeaderValue::from_str(&zarr_config.dtype).unwrap_or(header::HeaderValue::from_static("uint8")),
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

async fn handle_volume_3d(Query(params): Query<Volume3DParams>) -> impl IntoResponse {
    let downsample = params.downsample.unwrap_or(4);
    if downsample == 0 {
        return (StatusCode::BAD_REQUEST, "Downsample factor cannot be zero").into_response();
    }

    let entry = match locate_zarr_derivative(&params.dataset, &params.asset) {
        Some(e) => e,
        None => {
            return (
                StatusCode::NOT_FOUND,
                "Dataset or derivative not found",
            ).into_response()
        }
    };

    let zarr_dir = PathBuf::from(&entry.output_path);
    let zarr_config = match parse_zarray(&zarr_dir) {
        Some(c) => c,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse .zarray metadata",
            ).into_response()
        }
    };

    let shape = &zarr_config.shape;
    let chunks = &zarr_config.chunks;
    if shape.len() != 3 || chunks.len() != 3 {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid OME-Zarr array shape/chunks dimensions",
        ).into_response();
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
            ).into_response()
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

                                        let src_offset = ((zo * y_len * x_len) + (yo * x_len) + xo) * elem_size;
                                        let dest_offset = ((sz * dy * dx) + (sy * dx) + sx) * elem_size;

                                        out_buffer[dest_offset..(dest_offset + elem_size)]
                                            .copy_from_slice(&chunk_data[src_offset..(src_offset + elem_size)]);

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
        header::HeaderValue::from_str(&zarr_config.dtype).unwrap_or(header::HeaderValue::from_static("uint8")),
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

fn parse_voxel_size(path: &Path) -> Value {
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
                        if let Some(datasets) = first_ms.get("datasets").and_then(|d| d.as_array()) {
                            if let Some(first_ds) = datasets.first() {
                                if let Some(transforms) = first_ds.get("coordinateTransformations").and_then(|t| t.as_array()) {
                                    for t in transforms {
                                        if t.get("type").and_then(|ty| ty.as_str()) == Some("scale") {
                                            if let Some(scale) = t.get("scale").and_then(|s| s.as_array()) {
                                                if scale.len() == 3 {
                                                    return serde_json::json!({
                                                        "z": scale[0],
                                                        "y": scale[1],
                                                        "x": scale[2]
                                                    });
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
    serde_json::json!({
        "z": 1.0,
        "y": 1.0,
        "x": 1.0
    })
}

#[derive(Deserialize)]
struct OpenLocalParams {
    path: String,
}

async fn handle_open_local(Query(params): Query<OpenLocalParams>) -> impl IntoResponse {
    let path = PathBuf::from(&params.path);
    if !path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::to_string(&serde_json::json!({
                "success": false,
                "error": format!("Path does not exist: {}", params.path)
            })).unwrap()
        ).into_response();
    }

    let mut zarray_path = path.join(".zarray");
    if !zarray_path.exists() {
        zarray_path = path.join("0").join(".zarray");
        if !zarray_path.exists() {
            return (
                StatusCode::BAD_REQUEST,
                [(header::CONTENT_TYPE, "application/json")],
                serde_json::to_string(&serde_json::json!({
                    "success": false,
                    "error": "No .zarray file found at the root or within resolution group '0'"
                })).unwrap()
            ).into_response();
        }
    }

    let file = match File::open(&zarray_path) {
        Ok(f) => f,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CONTENT_TYPE, "application/json")],
                serde_json::to_string(&serde_json::json!({
                    "success": false,
                    "error": format!("Failed to open .zarray: {}", e)
                })).unwrap()
            ).into_response();
        }
    };

    let zarr_config: Zarray = match serde_json::from_reader(file) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CONTENT_TYPE, "application/json")],
                serde_json::to_string(&serde_json::json!({
                    "success": false,
                    "error": format!("Failed to parse .zarray: {}", e)
                })).unwrap()
            ).into_response();
        }
    };

    let folder_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let slug = format!("custom_{}_{}", folder_name.to_lowercase().replace(' ', "_"), timestamp);
    let title = format!("Local: {}", folder_name);

    let voxel_size = parse_voxel_size(&path);

    let derivative = serde_json::json!({
        "source_relative_path": "",
        "output_path": params.path.clone(),
        "shape_zyx": zarr_config.shape,
        "chunks_zyx": zarr_config.chunks,
        "dtype": zarr_config.dtype,
        "physical_voxel_size_nm": voxel_size
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

    {
        let mut guard = get_custom_datasets().lock().unwrap();
        guard.push(new_dataset);
    }

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&serde_json::json!({
            "success": true,
            "slug": slug
        })).unwrap()
    ).into_response()
}

async fn handle_workbench_data() -> impl IntoResponse {
    let mut packaged_datasets = Vec::new();

    {
        if let Ok(guard) = get_custom_datasets().lock() {
            packaged_datasets.extend(guard.clone());
        }
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
                        let deriv_path = root.join(slug).join("metadata").join("derivative-manifest.json");
                        let mut derivatives = Vec::new();
                        if deriv_path.exists() {
                            if let Ok(df) = File::open(&deriv_path) {
                                if let Ok(dm) = serde_json::from_reader::<_, Value>(df) {
                                    if let Some(deriv_arr) = dm.get("derivatives").and_then(|d| d.as_array()) {
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
                        let advisory_path = root.join(slug).join("metadata").join("advisory-findings.json");
                        let mut findings = Vec::new();
                        if advisory_path.exists() {
                            if let Ok(af) = File::open(&advisory_path) {
                                if let Ok(am) = serde_json::from_reader::<_, Value>(af) {
                                    if let Some(findings_arr) = am.get("findings").and_then(|f| f.as_array()) {
                                        findings = findings_arr.clone();
                                    }
                                }
                            }
                        }

                        // Build packaged dataset entry
                        let dataset_meta = ds.get("dataset");
                        let title = dataset_meta.and_then(|m| m.get("title")).and_then(|t| t.as_str()).unwrap_or(slug);
                        let source = dataset_meta.and_then(|m| m.get("source")).and_then(|s| s.as_str()).unwrap_or("");
                        let entry_id = dataset_meta.and_then(|m| m.get("entry_id")).and_then(|e| e.as_str()).unwrap_or("");
                        let experiment_type = dataset_meta.and_then(|m| m.get("experiment_type")).and_then(|e| e.as_str()).unwrap_or("");

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
    ).into_response()
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
    if ["fib-sem", "sbf-sem", "sem", "electron", "cryo", "tem", "et"].iter().any(|&t| lowered.contains(t)) {
        "EM".to_string()
    } else if ["sxt", "x-ray", "stxm", "hxt"].iter().any(|&t| lowered.contains(t)) {
        "X-ray".to_string()
    } else if ["optical", "fluorescence", "phase contrast", "diffraction", "lls", "sim"].iter().any(|&t| lowered.contains(t)) {
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
    } else if ["glucose", "metabolic", "fed", "fasted"].iter().any(|&t| lowered.contains(t)) {
        "metabolic condition"
    } else if ["development", "stage", "differentiation", "young", "mature"].iter().any(|&t| lowered.contains(t)) {
        "developmental stage"
    } else if ["methodology", "resolution", "modality"].iter().any(|&t| lowered.contains(t)) {
        "methodology"
    } else if ["species", "cell type"].iter().any(|&t| lowered.contains(t)) {
        "cell type"
    } else if ["stress", "infection", "treatment", "mutant", "mutation"].iter().any(|&t| lowered.contains(t)) {
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
    score += if xy.is_some() || z.is_some() { 0.15 } else { 0.05 };
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
        format!("https://github.com/mmirvis/Cell-Anatomy-Scoping-Review/tree/main#{}", study_slug)
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
            let scope_note = asset.get("availability_scope_note").cloned().unwrap_or_default().to_lowercase();
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

        let comparators_conditions = study.get("comparators_conditions").cloned().unwrap_or_default();
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
        let organelles_specialized = row.get("organelles_specialized").cloned().unwrap_or_default();
        let organelles = split_terms(&[&organelles_common, &organelles_specialized]);
        let organelle_pairs = build_pairs(&organelles);

        let c_score = completeness_score(&organelles, &metrics, sample_size, xy_nm, z_nm, public_status);

        let mut note_parts = Vec::new();
        if public_status == "complete" {
            note_parts.push("Public data available.".to_string());
        } else if public_status == "partial" {
            note_parts.push("Some public data available.".to_string());
        }
        let sample_size_notes = row.get("sample_size_notes").cloned().unwrap_or_default().trim().to_string();
        if !sample_size_notes.is_empty() && sample_size_notes.len() <= 120 {
            note_parts.push(sample_size_notes);
        }
        let notes = if note_parts.is_empty() { None } else { Some(note_parts.join(" ")) };

        let included_status = row.get("included_status").cloned().unwrap_or_else(|| "included".to_string());
        let pmid = study.get("pmid").cloned().unwrap_or_default();
        let publication_pmid = if pmid.trim().is_empty() { None } else { Some(pmid.trim().to_string()) };
        let study_slug = row.get("study_slug").cloned().unwrap_or_default();
        let source_publication_url = Some(publication_url(&pmid, &study_slug));

        let public_locator_urls_raw = row.get("public_locator_urls").cloned().unwrap_or_default();
        let public_locator_urls: Vec<String> = public_locator_urls_raw
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let title = format!("{} whole-cell dataset ({})", cell_type, row.get("imaging_modality").cloned().unwrap_or_default());
        let paper_title = study.get("title").cloned().unwrap_or_default();
        let year = row.get("year").and_then(|y| y.parse::<i64>().ok()).unwrap_or(0);
        let source = if !row.get("journal_published").cloned().unwrap_or_default().trim().is_empty() {
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
    FROM dataset_records WHERE 1=1".to_string();

    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    let include_borderline = filters.include_borderline.unwrap_or(false);
    if include_borderline {
        sql.push_str(" AND included_status IN ('included', 'borderline')");
    } else {
        sql.push_str(" AND included_status = 'included'");
    }

    if let Some(ref q) = filters.query {
        if !q.trim().is_empty() {
            sql.push_str(" AND (
                title LIKE ? OR 
                paper_title LIKE ? OR 
                source_study_id LIKE ? OR 
                publication_pmid LIKE ? OR 
                source LIKE ? OR 
                species LIKE ? OR 
                cell_type LIKE ? OR 
                notes LIKE ?
            )");
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
            sql.push_str(" AND EXISTS (SELECT 1 FROM json_each(organelles) WHERE LOWER(value) = LOWER(?))");
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
        let organelle_pairs: Vec<String> = serde_json::from_str(&organelle_pairs_str).unwrap_or_default();
        let metric_families: Vec<String> = serde_json::from_str(&metric_families_str).unwrap_or_default();
        let public_locator_urls: Vec<String> = serde_json::from_str(&public_locator_urls_str).unwrap_or_default();

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
    ).into_response()
}

#[derive(Deserialize)]
struct ExportParams {
    #[serde(default = "default_export_format")]
    format: String,
    #[serde(flatten)]
    filters: DatasetFilters,
}
fn default_export_format() -> String { "csv".to_string() }

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
        ).into_response();
    }

    if params.format == "bibtex" {
        let mut bib = String::new();
        for d in &records {
            let slug = d.dataset_id.replace('-', "");
            bib.push_str(&format!("@article{{{}, \n", slug));
            bib.push_str(&format!("  title = {{{}}},\n", d.paper_title));
            let author = d.source_study_id.as_deref().unwrap_or(&d.source)
                .replace("et al.", "")
                .replace("et al", "")
                .trim()
                .split_whitespace().next().unwrap_or("")
                .to_string();
            bib.push_str(&format!("  author = {{{}}},\n", if author.is_empty() { &d.source } else { &author }));
            bib.push_str(&format!("  journal = {{{}}},\n", d.source));
            bib.push_str(&format!("  year = {{{}}},\n", d.year));
            if let Some(ref pmid) = d.publication_pmid {
                bib.push_str(&format!("  pmid = {{{}}},\n", pmid));
            }
            bib.push_str(&format!("  note = {{Indexed in the Cell Anatomy Corpus: {}}}\n", d.title));
            bib.push_str("}\n\n");
        }
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/plain"),
                (header::CONTENT_DISPOSITION, "attachment; filename=cell_anatomy_corpus_export.bib"),
            ],
            bib,
        ).into_response();
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
        let xy_str = d.lateral_resolution_nm.map(|x| x.to_string()).unwrap_or_default();
        let z_str = d.axial_resolution_nm.map(|z| z.to_string()).unwrap_or_default();
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
            (header::CONTENT_DISPOSITION, "attachment; filename=cell_anatomy_corpus_export.csv"),
        ],
        csv_string,
    ).into_response()
}

async fn handle_facets(State(state): State<AppState>) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &DatasetFilters { include_borderline: Some(false), ..Default::default() }, false) {
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
        let mut v: Vec<serde_json::Value> = map.into_iter()
            .map(|(k, count)| serde_json::json!({ "value": k, "count": count }))
            .collect();
        v.sort_by(|a, b| {
            let ac = a["count"].as_i64().unwrap_or(0);
            let bc = b["count"].as_i64().unwrap_or(0);
            bc.cmp(&ac).then_with(|| a["value"].as_str().unwrap_or("").cmp(&b["value"].as_str().unwrap_or("")))
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
    ).into_response()
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
        "comparator_class" => record.comparator_class.clone().unwrap_or("none".to_string()),
        "sample_size_bucket" => record.sample_size_bucket.clone(),
        _ => "none".to_string(),
    };
    if val.trim().is_empty() { "none".to_string() } else { val }
}

async fn handle_cross_tab(
    State(state): State<AppState>,
    Query(params): Query<CrossTabParams>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let records = match query_records(&conn, &DatasetFilters { include_borderline: Some(true), ..Default::default() }, false) {
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
    ).into_response()
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

    let frontier: Vec<serde_json::Value> = records.into_iter()
        .filter(|r| r.lateral_resolution_nm.is_some() && r.sample_size.is_some())
        .map(|r| serde_json::json!({
            "id": r.dataset_id,
            "title": r.title,
            "res": r.lateral_resolution_nm,
            "ss": r.sample_size,
            "modality": r.modality_family,
        }))
        .collect();

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&frontier).unwrap(),
    ).into_response()
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
            let organelle_entry = matrix.entry(o.clone()).or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(ref mut m) = organelle_entry {
                let count = m.get(&r.modality_family).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
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
    ).into_response()
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
            let organelle_entry = matrix.entry(o.clone()).or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
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
    let organelle_diversity: std::collections::HashMap<String, usize> = matrix.iter()
        .map(|(k, v)| (k.clone(), v.as_object().unwrap().len()))
        .collect();

    organelles.sort_by(|a, b| {
        let div_a = organelle_diversity.get(a).cloned().unwrap_or(0);
        let div_b = organelle_diversity.get(b).cloned().unwrap_or(0);
        let tot_a = organelle_totals.get(a).cloned().unwrap_or(0);
        let tot_b = organelle_totals.get(b).cloned().unwrap_or(0);
        div_b.cmp(&div_a).then_with(|| tot_b.cmp(&tot_a)).then_with(|| a.cmp(b))
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
    ).into_response()
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
                reusable_modalities.entry(o.clone()).or_insert_with(std::collections::HashSet::new)
                    .insert(r.modality_family.clone());
                for met in &r.metric_families {
                    reusable_metrics.entry(o.clone()).or_insert_with(std::collections::HashSet::new)
                        .insert(met.clone());
                }
            }
        }
    }

    let mut public_share = serde_json::Map::new();
    for (o, total) in &row_totals {
        let reusable = reusable_totals.get(o).cloned().unwrap_or(0);
        let share = if *total > 0 { (reusable as f64 / *total as f64 * 1000.0).round() / 1000.0 } else { 0.0 };
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

    let reusable_modality_families: serde_json::Map<String, serde_json::Value> = reusable_modalities.into_iter()
        .map(|(k, set)| {
            let mut v: Vec<String> = set.into_iter().collect();
            v.sort();
            (k, serde_json::json!(v))
        })
        .collect();

    let reusable_metric_families: serde_json::Map<String, serde_json::Value> = reusable_metrics.into_iter()
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
    ).into_response()
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
        cell_type_species.entry(r.cell_type.clone()).or_insert_with(std::collections::HashSet::new)
            .insert(r.species.clone());

        let ct_entry = matrix.entry(r.cell_type.clone()).or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(ref mut m) = ct_entry {
            for o in &r.organelles {
                *organelle_totals.entry(o.clone()).or_insert(0) += 1;
                let count = m.get(o).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
                m.insert(o.clone(), serde_json::json!(count));
            }
        }
    }

    let cell_type_organelle_counts: std::collections::HashMap<String, usize> = matrix.iter()
        .map(|(k, v)| (k.clone(), v.as_object().unwrap().len()))
        .collect();

    let mut cell_types: Vec<String> = cell_type_totals.keys().cloned().collect();
    cell_types.sort_by(|a, b| {
        let div_a = cell_type_organelle_counts.get(a).cloned().unwrap_or(0);
        let div_b = cell_type_organelle_counts.get(b).cloned().unwrap_or(0);
        let tot_a = cell_type_totals.get(a).cloned().unwrap_or(0);
        let tot_b = cell_type_totals.get(b).cloned().unwrap_or(0);
        div_b.cmp(&div_a).then_with(|| tot_b.cmp(&tot_a)).then_with(|| a.cmp(b))
    });

    let mut organelles: Vec<String> = organelle_totals.keys().cloned().collect();
    organelles.sort_by(|a, b| {
        let tot_a = organelle_totals.get(a).cloned().unwrap_or(0);
        let tot_b = organelle_totals.get(b).cloned().unwrap_or(0);
        tot_b.cmp(&tot_a).then_with(|| a.cmp(b))
    });

    let cell_type_species_formatted: serde_json::Map<String, serde_json::Value> = cell_type_species.into_iter()
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
    ).into_response()
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
        *modality_totals.entry(r.modality_family.clone()).or_insert(0) += 1;

        if r.public_data_status != "none" {
            *public_counts.entry(yr).or_insert(0) += 1;
        }

        organelles_by_year.entry(yr).or_insert_with(std::collections::HashSet::new)
            .extend(r.organelles);
        metrics_by_year.entry(yr).or_insert_with(std::collections::HashSet::new)
            .extend(r.metric_families);

        let yr_entry = matrix.entry(yr.to_string()).or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(ref mut m) = yr_entry {
            let count = m.get(&r.modality_family).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
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
        year_totals_formatted.insert(yr_str.clone(), serde_json::json!(year_totals.get(yr).cloned().unwrap_or(0)));
        public_counts_formatted.insert(yr_str.clone(), serde_json::json!(public_counts.get(yr).cloned().unwrap_or(0)));
        organelle_counts_formatted.insert(yr_str.clone(), serde_json::json!(organelles_by_year.get(yr).map(|s| s.len()).unwrap_or(0)));
        metric_family_counts_formatted.insert(yr_str.clone(), serde_json::json!(metrics_by_year.get(yr).map(|s| s.len()).unwrap_or(0)));
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
    ).into_response()
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
    let records = match query_records(&conn, &DatasetFilters { include_borderline: Some(true), ..Default::default() }, false) {
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
        let entry = grouped.entry(r.modality_family.clone()).or_insert_with(|| GroupData {
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
    results.sort_by(|a, b| a["modality_family"].as_str().unwrap().cmp(b["modality_family"].as_str().unwrap()));

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&results).unwrap(),
    ).into_response()
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

    let target_organelles: Vec<String> = params.organelles
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

    let bio_matches: Vec<DatasetRecord> = datasets.iter()
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
        ("frontier", "No records in the current corpus capture this organelle target.".to_string())
    } else if strict_matches.is_empty() {
        ("high-risk", format!("{} matching records exist in the current corpus, but none meet the active threshold filters.", bio_matches.len()))
    } else if strict_matches.len() < 3 {
        ("challenging", format!("Only {} records in the current corpus meet the active threshold filters for this target.", strict_matches.len()))
    } else {
        ("feasible", format!("{} records in the current corpus meet the active filters for this target.", strict_matches.len()))
    };

    let mut modality_counts = std::collections::HashMap::new();
    for d in &bio_matches {
        *modality_counts.entry(d.modality.clone()).or_insert(0) += 1;
    }
    let top_modality = modality_counts.into_iter()
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

    let suggested_baselines: Vec<DatasetRecord> = bio_matches.iter()
        .filter(|d| d.public_data_status != "none")
        .take(3)
        .cloned()
        .collect();

    let precedents = if !strict_matches.is_empty() { strict_matches.clone() } else { bio_matches.clone() };

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
    ).into_response()
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

    let target_organelles: Vec<String> = params.plan_params.organelles
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

    let bio_matches: Vec<DatasetRecord> = datasets.iter()
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

    let precedents = if !strict_matches.is_empty() { strict_matches } else { bio_matches };

    let mut filtered_precedents = precedents;
    if let Some(ref pq) = params.precedent_query {
        let query_lower = pq.trim().to_lowercase();
        if !query_lower.is_empty() {
            filtered_precedents = filtered_precedents.into_iter()
                .filter(|d| {
                    let haystack = format!("{} {} {} {} {} {} {} {} {} {}",
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
                    ).to_lowercase();
                    haystack.contains(&query_lower)
                })
                .collect();
        }
    }

    if let Some(ref pub_state) = params.precedent_public {
        if !pub_state.trim().is_empty() {
            filtered_precedents = filtered_precedents.into_iter()
                .filter(|d| d.public_data_status == *pub_state)
                .collect();
        }
    }

    let sort_key = params.precedent_sort.unwrap_or_else(|| "year_desc".to_string());
    filtered_precedents.sort_by(|a, b| {
        match sort_key.as_str() {
            "year_asc" => a.year.cmp(&b.year).then_with(|| a.dataset_id.cmp(&b.dataset_id)),
            "author_asc" => {
                let auth_a = a.source_study_id.as_deref().unwrap_or(&a.dataset_id).to_lowercase();
                let auth_b = b.source_study_id.as_deref().unwrap_or(&b.dataset_id).to_lowercase();
                auth_a.cmp(&auth_b).then_with(|| b.year.cmp(&a.year)).then_with(|| a.dataset_id.cmp(&b.dataset_id))
            }
            "sample_desc" => {
                let ss_a = a.sample_size.unwrap_or(-1);
                let ss_b = b.sample_size.unwrap_or(-1);
                ss_b.cmp(&ss_a).then_with(|| b.year.cmp(&a.year)).then_with(|| a.dataset_id.cmp(&b.dataset_id))
            }
            "res_asc" => {
                let res_a = a.lateral_resolution_nm.unwrap_or(f64::INFINITY);
                let res_b = b.lateral_resolution_nm.unwrap_or(f64::INFINITY);
                res_a.partial_cmp(&res_b).unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.year.cmp(&a.year))
                    .then_with(|| a.dataset_id.cmp(&b.dataset_id))
            }
            "public_first" => {
                let r_a = match a.public_data_status.as_str() { "complete" => 2, "partial" => 1, _ => 0 };
                let r_b = match b.public_data_status.as_str() { "complete" => 2, "partial" => 1, _ => 0 };
                r_b.cmp(&r_a).then_with(|| b.year.cmp(&a.year)).then_with(|| a.dataset_id.cmp(&b.dataset_id))
            }
            _ => b.year.cmp(&a.year).then_with(|| a.dataset_id.cmp(&b.dataset_id)),
        }
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
        let xy_str = d.lateral_resolution_nm.map(|x| x.to_string()).unwrap_or_default();
        let z_str = d.axial_resolution_nm.map(|z| z.to_string()).unwrap_or_default();
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
            (header::CONTENT_DISPOSITION, "attachment; filename=cell_anatomy_plan_precedents.csv"),
        ],
        csv_string,
    ).into_response()
}

async fn handle_get_dataset(
    State(state): State<AppState>,
    axum::extract::Path(dataset_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let conn = state.db.lock().unwrap();
    let filters = DatasetFilters { include_borderline: Some(true), ..Default::default() };
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    if let Some(dataset) = records.into_iter().find(|r| r.dataset_id == dataset_id) {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::to_string(&dataset).unwrap(),
        ).into_response();
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
    let filters = DatasetFilters { include_borderline: Some(true), ..Default::default() };
    let records = match query_records(&conn, &filters, false) {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let target = match records.iter().find(|r| r.dataset_id == dataset_id) {
        Some(t) => t.clone(),
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let mut scored: Vec<(DatasetRecord, i32)> = records.into_iter()
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
    ).into_response()
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
    let filters = DatasetFilters { include_borderline: Some(true), ..Default::default() };
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

    let cell_types_groups: Vec<Vec<String>> = selected.iter().map(|d| vec![d.cell_type.clone()]).collect();
    let species_groups: Vec<Vec<String>> = selected.iter().map(|d| vec![d.species.clone()]).collect();
    let organelles_groups: Vec<&Vec<String>> = selected.iter().map(|d| &d.organelles).collect();
    let pairs_groups: Vec<&Vec<String>> = selected.iter().map(|d| &d.organelle_pairs).collect();
    let metrics_groups: Vec<&Vec<String>> = selected.iter().map(|d| &d.metric_families).collect();
    let comparators_groups: Vec<Vec<String>> = selected.iter().filter_map(|d| d.comparator_class.clone().map(|c| vec![c])).collect();
    let modality_family_groups: Vec<Vec<String>> = selected.iter().map(|d| vec![d.modality_family.clone()]).collect();

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
    let all_same_cell_type = selected.iter().map(|d| &d.cell_type).collect::<std::collections::HashSet<_>>().len() == 1;
    if all_same_cell_type { score += 25; }

    let all_same_species = selected.iter().map(|d| &d.species).collect::<std::collections::HashSet<_>>().len() == 1;
    if all_same_species { score += 10; }

    let shared_pairs = shared_fields["organelle_pairs"].as_array().unwrap();
    if !shared_pairs.is_empty() {
        score += std::cmp::min(20, 5 * shared_pairs.len() as i64);
    }

    let shared_metrics = shared_fields["metric_families"].as_array().unwrap();
    if !shared_metrics.is_empty() {
        score += std::cmp::min(15, 3 * shared_metrics.len() as i64);
    }

    let all_same_mod_fam = selected.iter().map(|d| &d.modality_family).collect::<std::collections::HashSet<_>>().len() == 1;
    if all_same_mod_fam { score += 10; }

    let shared_comparators = shared_fields["comparator_classes"].as_array().unwrap();
    if !shared_comparators.is_empty() { score += 10; }

    let all_completeness_high = selected.iter().all(|d| d.metadata_completeness_score >= 0.8);
    if all_completeness_high { score += 10; }

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
    ).into_response()
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
    };

    let app = Router::new()
        .route("/api/health", get(handle_health))
        .route("/api/volume/slice", get(handle_slice))
        .route("/api/volume/3d", get(handle_volume_3d))
        .route("/api/volume/workbench-data", get(handle_workbench_data))
        .route("/api/volume/open-local", get(handle_open_local))
        .route("/api/datasets", get(handle_search))
        .route("/api/datasets/export", get(handle_export))
        .route("/api/datasets/facets", get(handle_facets))
        .route("/api/datasets/analytics/cross-tab", get(handle_cross_tab))
        .route("/api/datasets/analytics/frontier", get(handle_frontier))
        .route("/api/datasets/analytics/toolkit", get(handle_toolkit))
        .route("/api/datasets/analytics/measurement-grammar", get(handle_measurement_grammar))
        .route("/api/datasets/analytics/reusability-map", get(handle_reusability_map))
        .route("/api/datasets/analytics/coverage-atlas", get(handle_coverage_atlas))
        .route("/api/datasets/analytics/timeline", get(handle_timeline))
        .route("/api/datasets/analytics/benchmarks", get(handle_benchmarks))
        .route("/api/datasets/analytics/plan", get(handle_plan))
        .route("/api/datasets/analytics/plan/export", get(handle_plan_export))
        .route("/api/datasets/:dataset_id", get(handle_get_dataset))
        .route("/api/datasets/:dataset_id/similar", get(handle_get_similar))
        .route("/api/datasets/compare", axum::routing::post(handle_compare))
        .with_state(state)
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
    println!("Cell Anatomy Volumetric Sidecar + SQLite engine running on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
