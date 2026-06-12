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
    # Best-effort under `set -e`: a transient Drive failure must not abort the
    # rest of the chain (the resumes tarball + the local prune still run, and
    # the next cron run re-mirrors anything missed — rclone copy is idempotent).
    if ! "$RCLONE_BIN" copy "$src" "$RCLONE_DEST/"; then
        echo "[BACKUP] WARN: rclone copy failed for ${src##*/} — offsite mirror skipped this run" >&2
    fi
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

# Verify the snapshot BEFORE it enters the retention/offsite chain — a corrupt
# snapshot mirrored to Drive would silently poison the recovery path. On
# failure: warn loudly, drop the bad snapshot, skip its upload, still run the
# resumes tarball + prunes, and exit non-zero so cron/launchd surfaces it.
DB_BACKUP_FAILED=0
INTEGRITY="$(sqlite3 "$DB_DEST" "PRAGMA integrity_check;" 2>&1 || true)"
if [ "$INTEGRITY" = "ok" ]; then
    DB_DEST="$(maybe_encrypt "$DB_DEST")"
    rclone_copy "$DB_DEST"
    echo "[BACKUP] db   → ${DB_DEST##*/}"
else
    DB_BACKUP_FAILED=1
    echo "[BACKUP] ERROR: integrity_check failed on snapshot ${DB_DEST##*/} — NOT keeping or uploading it. Output: $INTEGRITY" >&2
    rm -f "$DB_DEST"
fi

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

# ─── 4. Drive-side 30-day retention (best-effort) ────────────────────────
# Mirror the local prune so the Drive folder doesn't grow unbounded.
# Conservative on purpose: scoped to the exact backup destination dir,
# top-level only (--max-depth 1), and only the four artifact name patterns
# this script writes. Warn-on-fail — a prune hiccup never fails the backup.
if [ -n "$RCLONE_BIN" ]; then
    for prune_pattern in 'mc-*.db' 'mc-*.db.age' 'mc-resumes-*.tar.gz' 'mc-resumes-*.tar.gz.age'; do
        if ! "$RCLONE_BIN" delete "$RCLONE_DEST" --min-age 30d --max-depth 1 --include "$prune_pattern"; then
            echo "[BACKUP] WARN: Drive-side prune failed for pattern $prune_pattern (skipping)" >&2
        fi
    done
else
    echo "[BACKUP] WARN: rclone not found — skipping Drive-side prune" >&2
fi

if [ "$DB_BACKUP_FAILED" -ne 0 ]; then
    echo "[BACKUP] done at $TS — WITH ERRORS (db snapshot failed integrity_check)" >&2
    exit 1
fi
echo "[BACKUP] done at $TS"
