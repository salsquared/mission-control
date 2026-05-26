# Backups + recovery

Two pieces of state matter:

- **`prisma/prod.db`** — every Application, ApplicationEvent, Profile entity, Watchlist, JobPosting, Notification, GeneratedResume row. **Also contains plaintext `Account.refresh_token` for the Gmail/Calendar OAuth session** — anyone with this file has equivalence to the user's mailbox.
- **`data/resumes/<id>.<ext>`** — the actual PDF/DOCX bytes archived per generation. `GeneratedResume.artifactPath` points at this directory.

`scripts/backup-db.sh` snapshots both, encrypts each artifact with [age](https://age-encryption.org/) when a recipient is configured (RAH-13), mirrors to Google Drive via rclone, and prunes local copies (and their `.age` variants) older than 30 days. Designed for cron / launchd; run by hand any time. Falls back to local-only if rclone isn't on PATH (warns loudly); falls back to **plaintext** if no age recipient is configured, also warning loudly (so cron doesn't break before the user finishes initial setup).

## Encryption (RAH-13) — one-time setup

The script auto-discovers an age recipient at `~/.config/mission-control/backup.pub`. To activate encryption for an existing install:

```sh
# 1. Install age (Homebrew)
brew install age

# 2. Generate a keypair (private key file lives at the canonical config path)
mkdir -p ~/.config/mission-control
age-keygen -o ~/.config/mission-control/backup.key
chmod 600 ~/.config/mission-control/backup.key

# 3. Pull the public-key line into the auto-discovery path the script reads
grep '^# public key:' ~/.config/mission-control/backup.key \
    | sed 's/^# public key: //' \
    > ~/.config/mission-control/backup.pub
chmod 644 ~/.config/mission-control/backup.pub

# 4. CRITICAL — copy the secret key text into 1Password (or any offline
#    store NOT named Google Drive). Lose the secret and every encrypted
#    backup becomes unrecoverable. The file you need to copy is:
#      ~/.config/mission-control/backup.key
```

The next `./scripts/backup-db.sh` run will pick up the new public key automatically and emit `.age`-suffixed artifacts — no env-var plumbing or cron edit needed. Override the auto-discovery path by exporting `MC_BACKUP_AGE_RECIPIENT=/path/to/recipients.txt`.

**Clean up the existing plaintext history once encrypted backups are verified working:** the script encrypts new runs but does not retroactively re-encrypt the ~30 days of plaintext snapshots already on disk + Drive. Run the decrypt smoke (`./scripts/backup-decrypt.sh ~/backups/mission-control/$(ls -t ~/backups/mission-control/*.age | head -1)`) end-to-end against the live key first, then:

```sh
# Local plaintext purge
rm -f ~/backups/mission-control/mc-*.db ~/backups/mission-control/mc-resumes-*.tar.gz
# Drive plaintext purge (only if you've verified the new encrypted backups are uploading correctly)
rclone delete gdrive:backups/mission-control/ --include "mc-*.db" --include "mc-resumes-*.tar.gz"
```

## Set up the cron (run once)

```sh
# Open crontab editor
crontab -e

# Add:
# 0 4 * * *  cd /Users/sal/salsquared/mission-control && ./scripts/backup-db.sh >> ~/backups/mission-control/backup.log 2>&1
```

No env-var plumbing in the crontab — the script auto-discovers the recipient from `~/.config/mission-control/backup.pub`.

## Recovery — Mac died, fresh machine

```sh
# 0. (One-time on the new machine) Install age, restore the secret key from
#    1Password to ~/.config/mission-control/backup.key, chmod 600 it.
brew install age
mkdir -p ~/.config/mission-control
# paste the secret-key text from 1Password into:
#   ~/.config/mission-control/backup.key
chmod 600 ~/.config/mission-control/backup.key

# 1. Pull the latest backup from Drive (encrypted .age artifacts; plaintext
#    artifacts only if older than the RAH-13 cutover)
rclone copy gdrive:backups/mission-control/  ~/restore/ \
    --include "mc-*.db.age" --include "mc-resumes-*.tar.gz.age" \
    --include "mc-*.db"     --include "mc-resumes-*.tar.gz"

# 2. Decrypt every .age in ~/restore/ (auto-discovers the identity at
#    ~/.config/mission-control/backup.key)
./scripts/backup-decrypt.sh ~/restore/

# 3. Stop everything
pm2 stop mission-control mission-control-dev mission-control-scheduler-dev mission-control-scheduler-prod

# 4. Restore the DB
cp ~/restore/mc-LATEST.db prisma/prod.db
rm -f prisma/prod.db-wal prisma/prod.db-shm   # let SQLite rebuild WAL sidecars

# 5. Restore artifacts
rm -rf data/resumes/*    # leave .gitkeep
tar -xzf ~/restore/mc-resumes-LATEST.tar.gz -C data/

# 6. Bring services back up
pm2 start mission-control mission-control-dev mission-control-scheduler-dev mission-control-scheduler-prod
```

The Cloudflare tunnel (`cloudflared` PID checked via `pm2 list` won't show it — it's a system-level process via Homebrew) handles the public-hostname side. `requireLocalOrSession` in `lib/auth-guards.ts` gates tunnel traffic behind NextAuth while LAN hosts (localhost / mc.local) skip auth.
