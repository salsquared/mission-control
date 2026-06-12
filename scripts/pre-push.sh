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
# Isolate the fetcher-health store: loggedFetch / serveStale / the fetchers all
# record fetch outcomes to data/fetcher-health.db now, and many smokes exercise
# those helpers with test fixtures (example.com URLs, local test servers). Point
# the store at a throwaway file so the hermetic gate never pollutes the real
# per-tier telemetry the FetcherHealthCard reads. (The fetcher-health smoke
# overrides this with its own temp path internally — harmless.)
export FETCHER_HEALTH_PATH="${TMPDIR:-/tmp}/fh-prepush-$$.db"
trap 'rm -f "$FETCHER_HEALTH_PATH" "$FETCHER_HEALTH_PATH"-wal "$FETCHER_HEALTH_PATH"-shm' EXIT

# Suites are discovered by glob: every scripts/tests/hermetic/*.ts runs on
# every push, in deterministic (sorted) order, so a new smoke auto-registers
# the moment the file lands — no hand-maintained list to forget to update,
# and no "skip (not found)" path by construction (the glob only yields files
# that exist). The ONLY way a hermetic file stays out of the gate is an
# explicit entry in EXCLUDED below, with the reason documented inline.
#
# EXCLUDED — basename + REASON (keep both; an undocumented exclusion is a bug):
#   resume-render-smoke.ts  — requires a local Chrome/Chromium install for the
#                             PDF render path; not hermetic on machines without
#                             it. Run manually: npx tsx scripts/tests/hermetic/resume-render-smoke.ts
#   profile-repo-smoke.ts   — mutates dev.db (writes real Profile rows through
#                             the live Prisma dev database); unsafe to run on
#                             every push against a working dev DB.
EXCLUDED=(
    "resume-render-smoke.ts"
    "profile-repo-smoke.ts"
)

is_excluded() {
    local base="$1" ex
    for ex in "${EXCLUDED[@]}"; do
        if [ "$base" = "$ex" ]; then
            return 0
        fi
    done
    return 1
}

# LC_ALL=C pins glob/sort collation so the order is identical on every machine.
SUITES=()
while IFS= read -r suite; do
    if is_excluded "$(basename "$suite")"; then
        continue
    fi
    SUITES+=("$suite")
done < <(ls scripts/tests/hermetic/*.ts 2>/dev/null | LC_ALL=C sort)

if [ "${#SUITES[@]}" -eq 0 ]; then
    echo "  ✗ No hermetic suites found under scripts/tests/hermetic/ — refusing to pass an empty gate."
    exit 1
fi

for suite in "${SUITES[@]}"; do
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
