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
# Force the loadPrompt disk-fallback path for hermetic tests. Prisma's runtime
# loads .env on import (transitive dep via dotenv), which would populate
# LUNARY_PUBLIC_KEY late in import order. Setting it explicitly to empty here
# defeats dotenv's "don't overwrite" rule — `Boolean('')` is false, so
# lunaryEnabled() in lib/ai/prompts.ts returns false and the disk path runs.
# Without this, smokes that fetch (e.g. discovery-suggest-smoke) see an
# extra Lunary HTTP call slip through their fetch mocks.
export LUNARY_PUBLIC_KEY=""

# Suites are listed in dependency order: pure ones first so they fail fast.
# All entries live under scripts/tests/hermetic/ — no PM2, no real network.
SUITES=(
    "scripts/tests/hermetic/url-guard-smoke.ts"
    "scripts/tests/hermetic/route-auth-smoke.ts"
    "scripts/tests/hermetic/fetcher-unit-smoke.ts"
    "scripts/tests/hermetic/liveness-probe-smoke.ts"
    "scripts/tests/hermetic/resume-select-smoke.ts"
    "scripts/tests/hermetic/resume-diff-smoke.ts"
    "scripts/tests/hermetic/skills-gap-smoke.ts"
    "scripts/tests/hermetic/profile-merge-smoke.ts"
    "scripts/tests/hermetic/profile-snapshots-smoke.ts"
    "scripts/tests/hermetic/archive-spans-smoke.ts"
    "scripts/tests/hermetic/resume-uploads-smoke.ts"
    "scripts/tests/hermetic/bullet-assist-smoke.ts"
    "scripts/tests/hermetic/prompt-render-smoke.ts"
    "scripts/tests/hermetic/job-watcher-classifier-regression-smoke.ts"
    "scripts/tests/hermetic/job-watcher-scale-regression-smoke.ts"
    "scripts/tests/hermetic/fetcher-partial-regression-smoke.ts"
    "scripts/tests/hermetic/events-broadcast-regression-smoke.ts"
    "scripts/tests/hermetic/contacts-smoke.ts"
    "scripts/tests/hermetic/bulk-track-smoke.ts"
    "scripts/tests/hermetic/compensation-smoke.ts"
    "scripts/tests/hermetic/readme-prompt-smoke.ts"
    "scripts/tests/hermetic/metric-deltas-smoke.ts"
    "scripts/tests/hermetic/quiet-hours-smoke.ts"
    "scripts/tests/hermetic/user-rate-limit-smoke.ts"
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
    # M8.4 / M8.5 Wave 1
    "scripts/tests/hermetic/pipeline-picker-smoke.ts"
    "scripts/tests/hermetic/resume-from-application-smoke.ts"
    "scripts/tests/hermetic/resume-list-smoke.ts"
    "scripts/tests/hermetic/auto-tag-merge-smoke.ts"
    "scripts/tests/hermetic/bullet-remove-tag-smoke.ts"
    # M8.5 Wave 2
    "scripts/tests/hermetic/auto-tag-smoke.ts"
    "scripts/tests/hermetic/resume-rewrite-fold-in-smoke.ts"
    # M8.4 polish (canonical resume naming)
    "scripts/tests/hermetic/resume-labels-smoke.ts"
    # Find Roles edit (group-by-search)
    "scripts/tests/hermetic/find-roles-grouping-smoke.ts"
    # M7.7 — bullet tag/AI UX refactor
    "scripts/tests/hermetic/bullet-pin-tag-smoke.ts"
    "scripts/tests/hermetic/bullet-rewrite-text-only-smoke.ts"
    "scripts/tests/hermetic/bullet-tag-suggest-smoke.ts"
    # M7.8 — per-entity scratchpad (profile half)
    "scripts/tests/hermetic/scratchpad-patch-smoke.ts"
    "scripts/tests/hermetic/bullet-assist-scratchpad-smoke.ts"
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
