# Backups + recovery

Two pieces of state matter:

- **`prisma/prod.db`** — every Application, ApplicationEvent, Profile entity, Watchlist, JobPosting, Notification, GeneratedResume row. **Also contains plaintext `Account.refresh_token` for the Gmail/Calendar OAuth session** — anyone with this file has equivalence to the owner's mailbox.
- **`data/resumes/<id>.<ext>`** — the actual PDF/DOCX bytes archived per generation. `GeneratedResume.artifactPath` points at this directory.

> **⚠️ The snapshot is multi-person-sensitive as of 2026-07-28.** With the owner/crew work ([`multi-user-crew.html`](./multi-user-crew.html)), `prisma/prod.db` no longer holds one person's data. It holds **every crew member's job search** — their applications and the employer emails behind them, their profile and resume bullets, their watchlists, their generated resumes on disk. A leaked snapshot is a disclosure about other people, not just about Sal, and they cannot rotate their way out of it the way an OAuth token can be revoked. That raises the stakes on two things this runbook already covered as hygiene and now treats as load-bearing: **encryption at rest for every artifact** (below) and **not putting the age secret key in the same Drive that holds the encrypted backups**.

`scripts/backup-db.sh` snapshots both, encrypts each artifact with [age](https://age-encryption.org/) when a recipient is configured (RAH-13), mirrors to Google Drive via rclone, and prunes copies (and their `.age` variants) older than 30 days on **both** the local dir and the Drive side. Every DB snapshot is verified with `PRAGMA integrity_check` before it's kept — a corrupt snapshot is discarded (never uploaded) and the run exits non-zero so cron/launchd surfaces it. rclone failures are tolerated per-step: a failed copy or prune warns and the rest of the run continues (the next run re-mirrors anything missed — `rclone copy` is idempotent). Designed for cron / launchd; run by hand any time. Falls back to local-only if rclone isn't on PATH (warns loudly); falls back to **plaintext** if no age recipient is configured, also warning loudly (so cron doesn't break before the user finishes initial setup).

## Prerequisites — verify both, the script fails open on each

`scripts/backup-db.sh` is written to never break cron: every dependency it's missing degrades to a warning on **stderr** and the run continues. That's the right behavior for a script on a timer and the wrong behavior for your confidence in it — a degraded run and a perfect run look identical from the exit code, and under cron the warning lands in the log file nobody reads. Check both explicitly.

| Prerequisite | Path / probe | If missing | Status 2026-07-28 |
| --- | --- | --- | --- |
| **age recipient** — `backup.pub` | `~/.config/mission-control/backup.pub` (override: `MC_BACKUP_AGE_RECIPIENT`) | Snapshots are written in **plaintext**, warning only (`backup-db.sh:87`) | ✅ Present — runs produce `.age` artifacts |
| **rclone** — offsite mirror | `command -v rclone`, else `/opt/homebrew/bin/rclone`, else `/usr/local/bin/rclone` | Local copies only; **no offsite mirror**, and the Drive-side prune is skipped too (`backup-db.sh:49,170`) | ❌ **Absent — see below** |

**`~/.config/mission-control/backup.pub` is a prerequisite, not an option.** The script encrypts *only* when it finds a recipient there; with no recipient it still produces a snapshot, just an unencrypted one, and says so on stderr. Given the file is now multi-person-sensitive (above) and carries a live Gmail refresh token, a plaintext run is not a lesser backup — it's a liability sitting in `~/backups/` and, if rclone were configured, in Google Drive. Treat a missing `backup.pub` as a broken backup, not a partial one. Setup is below and takes one minute.

> **❌ Known gap (verified 2026-07-28): the offsite mirror is not running.** `rclone` is **not on PATH**, and it is not at either Homebrew fallback path the script probes (`/opt/homebrew/bin/rclone`, `/usr/local/bin/rclone`). The consequence: `scripts/backup-db.sh` runs to completion and **exits 0**, encryption works, `~/backups/mission-control/` fills with correct `.age` artifacts — and **every offsite copy is silently skipped**. `rclone_copy()` prints `WARN: rclone not found — skipping offsite mirror` to stderr and returns success (`backup-db.sh:48–50`); the Drive-side prune warns and skips the same way (`backup-db.sh:170`). Under the cron line below, that warning is redirected into `backup.log` and nothing else surfaces it.
>
> **What this means today: backups are local-only.** They are age-encrypted and integrity-checked, so they survive a bad migration or a corrupt DB — but **they do not survive the Mac dying**, which is the exact scenario the "Recovery — Mac died, fresh machine" section below is written for. That section's step 1 (`rclone copy gdrive:…`) has nothing to copy from.
>
> **To close it:** `brew install rclone && rclone config` (remote named `gdrive`, matching `RCLONE_DEST="gdrive:backups/mission-control"` at `backup-db.sh:28`), then run `./scripts/backup-db.sh` by hand once and confirm the artifacts appear in Drive. Existing local `.age` snapshots back-fill on the next run — `rclone copy` is idempotent.
>
> **To confirm it stays closed:** `grep WARN ~/backups/mission-control/backup.log | tail` after a cron run. A clean backup emits no `WARN` lines.

## Encryption (RAH-13) — required setup, one time

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

> **⚠️ Read the rclone gap above before trusting step 1.** As of 2026-07-28 no backup has been mirrored offsite, so `gdrive:backups/mission-control/` may be empty or months stale. If the Mac is genuinely gone, the encrypted snapshots went with it. Verify what's actually in Drive (`rclone ls gdrive:backups/mission-control/`) before assuming this procedure can run.

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

# 6. Recreate the untracked env files. The per-tier files are documented by
#    tracked examples (OQ12b — .env* is gitignored, never committed):
cp .env.development.example .env.development
cp .env.production.example .env.production
#    Real secrets (Google OAuth, NextAuth, Gemini, ALLOWED_SIGNIN_EMAILS, …)
#    live in the untracked .env — recreate it from 1Password; there is no
#    example file for it.

# 7. Bring services back up
pm2 start mission-control mission-control-dev mission-control-scheduler-dev mission-control-scheduler-prod
```

## Restoring the access path (what the DB restore does *not* bring back)

The Cloudflare tunnel (`cloudflared` — a system-level Homebrew process, so `pm2 list` won't show it) handles the public-hostname side. **Cloudflare Access at the edge** gates the public hostnames (Zero Trust app; design in [`cloudflare-access-auth.html`](./cloudflare-access-auth.html)).

**The origin no longer trusts the network it's reached over** (changed 2026-07-28, [`multi-user-crew.html`](./multi-user-crew.html)). The previous behavior — every request that reached the origin, LAN or tunnel, was served as the single owner via `resolveOwner()` — was safe only while there was one user, and that premise expired at the second one. Three things replaced it, and a fresh machine needs all three or the app is either unreachable or unsafe:

1. **Identity comes from the edge, per request.** Access stamps `Cf-Access-Authenticated-User-Email`; `lib/viewer.ts` resolves that header to the `User` row it names. There are **zero fallback branches** — no `resolveOwner()` backstop — so an unstamped request is refused rather than served as the owner.
2. **Prod binds loopback**, not the LAN: `next start -p 3101 -H 127.0.0.1` (`package.json:8`). This is in effect today.
3. **The `mc.local` Caddy vhost is retired** — commented out in `/opt/homebrew/etc/Caddyfile`, with the rollback lever and a pristine copy at `~/.config/mission-control/Caddyfile-backup-2026-07-27` documented in that file's header. **Authored, not yet cut over:** as of 2026-07-28 the `brew services restart caddy` that actually drops the `:443` listener is still the pending P5.2 step, so the retirement is on disk but not yet in the running process.

**Recovery implication.** Restoring `prisma/prod.db` restores the `User` rows and their roles, but **not** the edge config — the Access application, its email policy, the per-app AUD, and the `/api/gmail/webhook` bypass all live in the Cloudflare dashboard and are not in any backup here. On a fresh machine, re-point the tunnel and re-check the Access policy before assuming the app is gated; a tunnel that reaches the origin without Access in front of it is an origin with no gate at all, because step 1 above trusts the header Access is responsible for stamping. Also confirm Caddy is not left serving a stale LAN vhost from a restored config.
