-- Migration: 20261120120000_audio_storage_bytea_w3_04
-- Add PostgreSQL BYTEA audio storage with quotas and storage backend tracking

-- 1. ENUMS (declare before tables)
CREATE TYPE audio_storage_backend AS ENUM ('S3', 'POSTGRESQL');

-- 2. AUDIO BLOBS — one-way org-scoped composite FK to audio_assets
CREATE TABLE audio_blobs (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL,
  content BYTEA NOT NULL,
  content_type VARCHAR(64) NOT NULL,
  byte_size BIGINT NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, asset_id),
  
  -- One-way org-scoped composite FK: blob -> asset (NO FK on audio_assets)
  FOREIGN KEY (organization_id, asset_id) 
    REFERENCES audio_assets(organization_id, id) 
    ON DELETE RESTRICT
);

CREATE INDEX idx_audio_blobs_org_size ON audio_blobs(organization_id, byte_size);

-- 3. ORGANIZATION AUDIO QUOTA
CREATE TABLE organization_audio_quota (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  max_total_bytes BIGINT NOT NULL DEFAULT 52428800,
  max_single_file_bytes BIGINT NOT NULL DEFAULT 5242880,
  max_files INTEGER NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);

-- 4. AUDIO_ASSETS — add storage_backend (NO blob_id column)
ALTER TABLE audio_assets 
ADD COLUMN storage_backend audio_storage_backend NOT NULL DEFAULT 'S3';