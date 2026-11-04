#!/usr/bin/env bash
set -euo pipefail

# Idempotent preparation script for private MinIO storage on the Contabo VPS.
# It does NOT download binaries or start services. Run the documented commands
# manually after reviewing this script and obtaining production approval.

MINIO_USER=minio
MINIO_GROUP=minio
DATA_DIR=/var/lib/truevine-voice/minio
ENV_FILE=/etc/truevine/minio.env
BUCKET=truevine-voice-audio

echo "Create service account and data directory"
sudo groupadd --system "$MINIO_GROUP" 2>/dev/null || true
sudo useradd --system --gid "$MINIO_GROUP" --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$MINIO_USER" 2>/dev/null || true
sudo mkdir -p "$DATA_DIR"
sudo chown -R "$MINIO_USER:$MINIO_GROUP" "$DATA_DIR"
sudo chmod 750 "$DATA_DIR"
sudo mkdir -p /etc/truevine
sudo chmod 750 /etc/truevine

echo "Expected persistent data path: $DATA_DIR"
echo "Create $ENV_FILE from infrastructure/minio/minio.env.example before starting the service."
echo "Then install the MinIO binary to /usr/local/bin/minio and enable minio.service."
echo "Bucket to create after first start: $BUCKET"
