#!/bin/bash
set -e

LOCAL_DIR="$HOME/backups/mission-control"
mkdir -p "$LOCAL_DIR"
TS=$(date +%Y%m%d-%H%M%S)
DEST="$LOCAL_DIR/mc-$TS.db"

# Hot backup — safe while server is live (SQLite WAL handles concurrent readers)
sqlite3 /Users/sal/salsquared/mission-control/prisma/prod.db ".backup '$DEST'"

# Push to Google Drive via rclone (configure with: rclone config → remote name "gdrive")
rclone copy "$DEST" "gdrive:backups/mission-control/"

# Keep last 30 days locally
find "$LOCAL_DIR" -name 'mc-*.db' -mtime +30 -delete

echo "[BACKUP] Done: $DEST"
