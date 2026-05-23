#!/bin/bash
#
# mission-control backup — snapshots both the production SQLite database AND
# the generated-resume artifacts directory, optionally encrypts them with
# age (RAH-13), then mirrors both to Google Drive via rclone. Local copies
# are kept for 30 days.
#
# Designed to run unattended (cron / launchd). Idempotent on re-runs.
#
# Encryption (RAH-13): the production DB carries plaintext Gmail OAuth
# refresh tokens on Account rows. Anyone with access to the Drive folder
# (or the local backup dir) gets Gmail + Calendar equivalence on this
# account. To close that gap, drop a file containing one or more age
# public keys ("age1..." lines, one per line) at the default discovery
# path ~/.config/mission-control/backup.pub — the script will pick it up
# automatically on the next run. Override with MC_BACKUP_AGE_RECIPIENT if
# the file lives somewhere else. Each artifact is encrypted in place with
# age before either local retention OR offsite upload sees it. When no
# recipient is found the script still produces plaintext backups but
# warns loudly to stderr — this fail-open behavior exists only so the
# cron chain doesn't break before initial key setup.
#
# One-time setup + recovery: CLAUDE.md §"Backups + recovery".
set -euo pipefail

REPO_ROOT="/Users/sal/salsquared/mission-control"
LOCAL_DIR="$HOME/backups/mission-control"
RCLONE_DEST="gdrive:backups/mission-control"
TS=$(date +%Y%m%d-%H%M%S)

mkdir -p "$LOCAL_DIR"

# ─── Offsite (rclone) discovery ──────────────────────────────────────────
# If rclone isn't installed (or not on PATH), we still take the local
# snapshot and warn loudly. A one-off rclone outage doesn't take the whole
# backup chain offline.
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
        echo "[BACKUP] WARN: rclone not found — skipping offsite mirror for ${src##*/}" >&2
        return 0
    fi
    "$RCLONE_BIN" copy "$src" "$RCLONE_DEST/"
}

# ─── Encryption (RAH-13) ─────────────────────────────────────────────────
# Resolve the age binary lazily so the script still runs (with a warning)
# on a machine that hasn't installed it yet.
AGE_BIN=""
if command -v age >/dev/null 2>&1; then
    AGE_BIN="$(command -v age)"
elif [ -x /opt/homebrew/bin/age ]; then
    AGE_BIN="/opt/homebrew/bin/age"
elif [ -x /usr/local/bin/age ]; then
    AGE_BIN="/usr/local/bin/age"
fi

# Resolve the recipient once: explicit env var wins, otherwise probe the
# default discovery path. Empty string means "no encryption configured".
DEFAULT_RECIPIENT_PATH="$HOME/.config/mission-control/backup.pub"
RECIPIENT_FILE="${MC_BACKUP_AGE_RECIPIENT:-}"
if [ -z "$RECIPIENT_FILE" ] && [ -r "$DEFAULT_RECIPIENT_PATH" ]; then
    RECIPIENT_FILE="$DEFAULT_RECIPIENT_PATH"
fi

# Encrypts $1 in place, replacing it with $1.age. Returns the new path on
# stdout via the caller's command substitution. When no recipient is
# configured, prints the original path and warns.
maybe_encrypt() {
    local plain="$1"

    if [ -z "$RECIPIENT_FILE" ]; then
        echo "[BACKUP] WARN: no age recipient configured — ${plain##*/} stored in plaintext (RAH-13). Place a public key at $DEFAULT_RECIPIENT_PATH or set MC_BACKUP_AGE_RECIPIENT." >&2
        printf '%s' "$plain"
        return 0
    fi

    if [ -z "$AGE_BIN" ]; then
        # User wanted encryption (recipient configured) but the tool is missing.
        # Fail closed — don't silently leak.
        echo "[BACKUP] ERROR: recipient $RECIPIENT_FILE is configured but age is not installed. Run: brew install age" >&2
        rm -f "$plain"
        exit 1
    fi

    if [ ! -r "$RECIPIENT_FILE" ]; then
        echo "[BACKUP] ERROR: recipient file $RECIPIENT_FILE is not readable" >&2
        rm -f "$plain"
        exit 1
    fi

    local enc="$plain.age"
    "$AGE_BIN" --encrypt --recipients-file "$RECIPIENT_FILE" --output "$enc" "$plain"
    # Replace plaintext atomically once the encrypted file is on disk.
    rm -f "$plain"
    printf '%s' "$enc"
}

# ─── 1. SQLite hot backup ────────────────────────────────────────────────
# sqlite3 .backup is safe while the server is live (WAL handles concurrent
# readers + writers correctly; a plain cp can capture a half-flushed file).
DB_DEST="$LOCAL_DIR/mc-$TS.db"
sqlite3 "$REPO_ROOT/prisma/prod.db" ".backup '$DB_DEST'"
DB_DEST="$(maybe_encrypt "$DB_DEST")"
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
    ARTIFACTS_DEST="$(maybe_encrypt "$ARTIFACTS_DEST")"
    rclone_copy "$ARTIFACTS_DEST"
    echo "[BACKUP] resumes → ${ARTIFACTS_DEST##*/}"
else
    echo "[BACKUP] resumes → empty, skipped"
fi

# ─── 3. Local 30-day retention ───────────────────────────────────────────
# Also prune the .age variants — the original retention rules pre-date
# RAH-13 and only matched plaintext names.
find "$LOCAL_DIR" -name 'mc-*.db' -mtime +30 -delete
find "$LOCAL_DIR" -name 'mc-*.db.age' -mtime +30 -delete
find "$LOCAL_DIR" -name 'mc-resumes-*.tar.gz' -mtime +30 -delete
find "$LOCAL_DIR" -name 'mc-resumes-*.tar.gz.age' -mtime +30 -delete

echo "[BACKUP] done at $TS"
