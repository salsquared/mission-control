#!/bin/bash
#
# mission-control backup — snapshots both the production SQLite database AND
# the generated-resume artifacts directory, then mirrors both to Google Drive
# via rclone. Local copies are kept for 30 days.
#
# Designed to run unattended (cron / launchd). Idempotent on re-runs.
#
# Recovery runbook: see CLAUDE.md §"Recovery from Drive backups".
set -euo pipefail

REPO_ROOT="/Users/sal/salsquared/mission-control"
LOCAL_DIR="$HOME/backups/mission-control"
RCLONE_DEST="gdrive:backups/mission-control"
TS=$(date +%Y%m%d-%H%M%S)

mkdir -p "$LOCAL_DIR"

# Offsite mirroring is optional — if rclone isn't installed (or not on PATH),
# we still take the local snapshot and warn loudly. This way a one-off
# rclone outage doesn't take the whole backup chain offline.
RCLONE_BIN=""
if command -v rclone >/dev/null 2>&1; then
    RCLONE_BIN="$(command -v rclone)"
elif [ -x /opt/homebrew/bin/rclone ]; then
    RCLONE_BIN="/opt/homebrew/bin/rclone"
elif [ -x /usr/local/bin/rclone ]; then
    RCLONE_BIN="/usr/local/bin/rclone"
fi

rclone_copy() {
    local src="$1"
    if [ -z "$RCLONE_BIN" ]; then
        echo "[BACKUP] WARN: rclone not found — skipping offsite mirror for ${src##*/}"
        return 0
    fi
    "$RCLONE_BIN" copy "$src" "$RCLONE_DEST/"
}

# ─── 1. SQLite hot backup ────────────────────────────────────────────────
# sqlite3 .backup is safe while the server is live (WAL handles concurrent
# readers + writers correctly; a plain cp can capture a half-flushed file).
DB_DEST="$LOCAL_DIR/mc-$TS.db"
sqlite3 "$REPO_ROOT/prisma/prod.db" ".backup '$DB_DEST'"
rclone_copy "$DB_DEST"
echo "[BACKUP] db   → ${DB_DEST##*/}"

# ─── 2. Generated-resume artifacts ───────────────────────────────────────
# data/resumes/<id>.<ext> — referenced by GeneratedResume.artifactPath in
# prod.db. The row + the file together make a recoverable archive. Tar
# everything except the .gitkeep marker; skip silently when nothing's there.
ARTIFACTS_SRC="$REPO_ROOT/data/resumes"
if [ -d "$ARTIFACTS_SRC" ] && [ -n "$(ls -A "$ARTIFACTS_SRC" 2>/dev/null | grep -v '^\.gitkeep$' || true)" ]; then
    ARTIFACTS_DEST="$LOCAL_DIR/mc-resumes-$TS.tar.gz"
    tar -czf "$ARTIFACTS_DEST" -C "$REPO_ROOT/data" resumes
    rclone_copy "$ARTIFACTS_DEST"
    echo "[BACKUP] resumes → ${ARTIFACTS_DEST##*/}"
else
    echo "[BACKUP] resumes → empty, skipped"
fi

# ─── 3. Local 30-day retention ───────────────────────────────────────────
find "$LOCAL_DIR" -name 'mc-*.db' -mtime +30 -delete
find "$LOCAL_DIR" -name 'mc-resumes-*.tar.gz' -mtime +30 -delete

echo "[BACKUP] done at $TS"
