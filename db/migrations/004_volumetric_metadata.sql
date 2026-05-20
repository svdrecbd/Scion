-- Migration 004: Volumetric Metadata
-- Adds tracking for physical scale grids, voxel resolutions, Zarr structures, and acquisition states of 3D cell data volumes.

CREATE TABLE IF NOT EXISTS volumetric_assets (
    asset_id SERIAL PRIMARY KEY,
    dataset_id TEXT REFERENCES dataset_records(dataset_id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    local_path TEXT NOT NULL,
    sha256 TEXT,
    size_bytes BIGINT NOT NULL,
    format TEXT NOT NULL, -- e.g. 'tiff', 'mrc', 'zarr'
    acquisition_state TEXT NOT NULL DEFAULT 'indexed', -- 'indexed', 'mirrored', 'streamable'
    
    -- Dimensions (shape)
    shape_z INTEGER,
    shape_y INTEGER,
    shape_x INTEGER,
    
    -- Physical Scale (Voxel Spacing)
    voxel_size_z REAL,
    voxel_size_y REAL,
    voxel_size_x REAL,
    voxel_unit TEXT NOT NULL DEFAULT 'nm',
    
    -- OME-Zarr details
    ome_zarr_path TEXT,
    chunks_z INTEGER,
    chunks_y INTEGER,
    chunks_x INTEGER,
    dtype TEXT,
    
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(dataset_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_volumetric_assets_dataset_id
    ON volumetric_assets(dataset_id);

CREATE INDEX IF NOT EXISTS idx_volumetric_assets_acquisition_state
    ON volumetric_assets(acquisition_state);
