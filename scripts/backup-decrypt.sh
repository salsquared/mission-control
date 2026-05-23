#!/bin/bash
#
# mission-control backup decrypt — companion to scripts/backup-db.sh.
# Walks a directory of age-encrypted backups and decrypts every `*.age`
# file in place, leaving the plaintext alongside. The encrypted originals
# are kept so a botched recovery doesn't burn the only copy.
#
# Usage:
#   MC_BACKUP_AGE_IDENTITY=~/.config/mission-control/backup.key \
#     scripts/backup-decrypt.sh ~/restore/
#
# Or to decrypt a single file:
#   MC_BACKUP_AGE_IDENTITY=~/.config/mission-control/backup.key \
#     scripts/backup-decrypt.sh ~/restore/mc-20260523-040000.db.age
#
# The identity file is the SECRET key (lines starting with "AGE-SECRET-KEY-…"
# produced by `age-keygen`). Keep it OFF Google Drive — anyone who has it
# can decrypt every backup. Recommended: store the secret-key text in
# 1Password; the file on disk lives at ~/.config/mission-control/backup.key
# with mode 0600.
#
# See CLAUDE.md §"Backups + recovery" for the full runbook.
set -euo pipefail

# Explicit env var wins, otherwise probe the default discovery path that
# the backup script also uses. This way the trivial recovery case
# ("Mac alive, just unpacking a backup") needs zero env-var plumbing.
DEFAULT_IDENTITY_PATH="$HOME/.config/mission-control/backup.key"
IDENTITY_FILE="${MC_BACKUP_AGE_IDENTITY:-}"
if [ -z "$IDENTITY_FILE" ] && [ -r "$DEFAULT_IDENTITY_PATH" ]; then
    IDENTITY_FILE="$DEFAULT_IDENTITY_PATH"
fi

if [ -z "$IDENTITY_FILE" ]; then
    echo "[DECRYPT] ERROR: no age identity found. Either:" >&2
    echo "  - place the secret-key file at $DEFAULT_IDENTITY_PATH (mode 0600)" >&2
    echo "  - or set MC_BACKUP_AGE_IDENTITY=/path/to/secret.key" >&2
    exit 1
fi

if [ ! -r "$IDENTITY_FILE" ]; then
    echo "[DECRYPT] ERROR: identity file $IDENTITY_FILE is not readable" >&2
    exit 1
fi

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <file-or-dir> [<file-or-dir> ...]" >&2
    exit 1
fi

AGE_BIN=""
if command -v age >/dev/null 2>&1; then
    AGE_BIN="$(command -v age)"
elif [ -x /opt/homebrew/bin/age ]; then
    AGE_BIN="/opt/homebrew/bin/age"
elif [ -x /usr/local/bin/age ]; then
    AGE_BIN="/usr/local/bin/age"
fi

if [ -z "$AGE_BIN" ]; then
    echo "[DECRYPT] ERROR: age is not installed. Run: brew install age" >&2
    exit 1
fi

decrypt_one() {
    local enc="$1"
    case "$enc" in
        *.age) ;;
        *)
            echo "[DECRYPT] WARN: $enc does not end in .age — skipping" >&2
            return 0
            ;;
    esac
    local plain="${enc%.age}"
    if [ -e "$plain" ]; then
        echo "[DECRYPT] WARN: $plain already exists — skipping (delete first to re-decrypt)" >&2
        return 0
    fi
    "$AGE_BIN" --decrypt --identity "$IDENTITY_FILE" --output "$plain" "$enc"
    echo "[DECRYPT] $enc → $plain"
}

for target in "$@"; do
    if [ -d "$target" ]; then
        # macOS bash 3.2 has no `find -print0 | while`; use a subshell loop.
        while IFS= read -r f; do
            decrypt_one "$f"
        done < <(find "$target" -type f -name '*.age')
    elif [ -f "$target" ]; then
        decrypt_one "$target"
    else
        echo "[DECRYPT] WARN: $target is neither a file nor a directory — skipping" >&2
    fi
done

echo "[DECRYPT] done"
