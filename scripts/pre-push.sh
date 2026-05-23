#!/usr/bin/env bash
#
# Mission-control pre-push hook. Runs the hermetic test suites (no real
# network, no PM2 dependency) before letting a push out the door.
#
# Bypass with `git push --no-verify` if you know what you're doing
# (e.g., emergency hotfix where a known-failing suite isn't the issue).
#
# Wired via simple-git-hooks in package.json. To install or re-install:
#   npx simple-git-hooks
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "▶ Pre-push: hermetic suite + lint"
START=$(date +%s)

# Some suites require DATABASE_URL (they hit dev.db for a real user). If the
# user hasn't set it in their shell, default to dev.db so the hook still works
# from a fresh terminal.
: "${DATABASE_URL:=file:./dev.db}"
export DATABASE_URL
# Mute Gmail send for the duration of the hook. PM2 dev also has EMAIL_ENABLED=0
# in .env.development, so HTTP-driven smokes (notification-bell) inherit it too.
# Defense in depth: any direct-tsx suite that doesn't go through PM2 picks this
# value up from the hook's exported env.
export EMAIL_ENABLED=0

# Suites are listed in dependency order: pure ones first so they fail fast.
# All entries live under scripts/tests/hermetic/ — no PM2, no real network.
SUITES=(
    "scripts/tests/hermetic/url-guard-smoke.ts"
    "scripts/tests/hermetic/route-auth-smoke.ts"
    "scripts/tests/hermetic/fetcher-unit-smoke.ts"
    "scripts/tests/hermetic/resume-select-smoke.ts"
    "scripts/tests/hermetic/skills-gap-smoke.ts"
    "scripts/tests/hermetic/profile-merge-smoke.ts"
    "scripts/tests/hermetic/profile-snapshots-smoke.ts"
    "scripts/tests/hermetic/contacts-smoke.ts"
    "scripts/tests/hermetic/email-message-smoke.ts"
    "scripts/tests/hermetic/watchlist-hermetic-smoke.ts"
    "scripts/tests/hermetic/negative-filters-smoke.ts"
    "scripts/tests/hermetic/track-as-application-smoke.ts"
    "scripts/tests/hermetic/notification-dispatch-smoke.ts"
    "scripts/tests/hermetic/stale-nudge-smoke.ts"
    "scripts/tests/hermetic/posting-digest-smoke.ts"
    "scripts/tests/hermetic/notification-negative-filter-smoke.ts"
    "scripts/tests/hermetic/deadline-nudge-smoke.ts"
    "scripts/tests/hermetic/find-app-by-company-smoke.ts"
    "scripts/tests/hermetic/company-directory-smoke.ts"
    "scripts/tests/hermetic/watchlist-hydrate-smoke.ts"
    "scripts/tests/hermetic/employment-type-smoke.ts"
    "scripts/tests/hermetic/webhook-dedup-smoke.ts"
    "scripts/tests/hermetic/ingest-retry-smoke.ts"
    "scripts/tests/hermetic/normalize-company-smoke.ts"
    "scripts/tests/hermetic/sender-domain-smoke.ts"
    "scripts/tests/hermetic/stale-status-ingest-smoke.ts"
    "scripts/tests/hermetic/notification-dedup-smoke.ts"
    "scripts/tests/hermetic/gcal-idempotency-smoke.ts"
    "scripts/tests/hermetic/webhook-prune-smoke.ts"
    "scripts/tests/hermetic/app-race-dedup-smoke.ts"
    "scripts/tests/hermetic/gemini-rate-limit-smoke.ts"
    "scripts/tests/hermetic/cache-smoke.ts"
    "scripts/tests/hermetic/classify-employment-type-smoke.ts"
    "scripts/tests/hermetic/discovery-suggest-smoke.ts"
    "scripts/tests/hermetic/location-expansion-smoke.ts"
)

for suite in "${SUITES[@]}"; do
    if [ ! -f "$suite" ]; then
        echo "  ⚠ skip: $suite (not found)"
        continue
    fi
    echo "  ▸ $suite"
    if ! npx tsx "$suite" > /tmp/mc-pre-push.log 2>&1; then
        echo "  ✗ FAILED — last 30 lines:"
        tail -30 /tmp/mc-pre-push.log | sed 's/^/    /'
        echo ""
        echo "  Bypass with: git push --no-verify"
        exit 1
    fi
done

ELAPSED=$(( $(date +%s) - START ))
echo "▶ Pre-push: ${#SUITES[@]} suites passed in ${ELAPSED}s"
