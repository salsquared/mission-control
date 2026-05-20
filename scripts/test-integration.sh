#!/usr/bin/env bash
#
# Mission-control integration test runner. Exercises real API routes against
# the dev PM2 process on :4101 — broader coverage than the hermetic pre-push
# suite but slower (~30–60s typical) and requires PM2 to be up.
#
# Not wired into the pre-push hook by design: PM2 startup cost would add 5–10s
# to every push and external watchlist smokes hit live boards (Anthropic,
# Lever demo, Ashby posthog) which can be flaky. Run by hand before merging:
#
#   npm run test:integration       # this script
#   npm run test:all               # hermetic + integration
#
# Bypass with SKIP_INTEGRATION_TESTS=1 if PM2 is intentionally down.
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$SKIP_INTEGRATION_TESTS" = "1" ]; then
    echo "▶ Integration: SKIP_INTEGRATION_TESTS=1, skipping."
    exit 0
fi

echo "▶ Integration suite (requires PM2 mission-control-dev on :4101)"
START=$(date +%s)

# Verify PM2 dev is online — otherwise every fetch will fail with ECONNREFUSED
# and the user wastes a minute watching ten suites time out in sequence.
if ! pm2 jlist 2>/dev/null | grep -q '"name":"mission-control-dev".*"status":"online"'; then
    echo "  ⚠ mission-control-dev is not online — start it with:"
    echo "    pm2 restart mission-control-dev"
    echo "  Or skip with: SKIP_INTEGRATION_TESTS=1 npm run test:integration"
    exit 1
fi

: "${DATABASE_URL:=file:./dev.db}"
export DATABASE_URL
# Same Gmail-send safety net as pre-push.sh — never blast the inbox from a smoke.
export EMAIL_ENABLED=0

# Suites are listed in roughly-increasing wall-time order. Watchlist E2E /
# Phase2 hit live boards and are skipped gracefully (by their own headers) if
# the boards are unreachable.
SUITES=(
    "scripts/tests/integration/applications-api-smoke.ts"
    "scripts/tests/integration/profile-api-smoke.ts"
    "scripts/tests/integration/profile-import-smoke.ts"
    "scripts/tests/integration/notification-bell-smoke.ts"
    "scripts/tests/integration/resume-archival-smoke.ts"
    "scripts/tests/integration/resume-docx-smoke.ts"
    "scripts/tests/integration/resume-e2e-smoke.ts"
    "scripts/tests/integration/watchlist-auto-run-smoke.ts"
    "scripts/tests/integration/watchlist-e2e-smoke.ts"
    "scripts/tests/integration/watchlist-phase2-smoke.ts"
)

PASSED=0
FAILED=0
for suite in "${SUITES[@]}"; do
    if [ ! -f "$suite" ]; then
        echo "  ⚠ skip: $suite (not found)"
        continue
    fi
    echo "  ▸ $suite"
    if ! npx tsx "$suite" > /tmp/mc-integration.log 2>&1; then
        echo "  ✗ FAILED — last 30 lines:"
        tail -30 /tmp/mc-integration.log | sed 's/^/    /'
        echo ""
        FAILED=$((FAILED + 1))
    else
        PASSED=$((PASSED + 1))
    fi
done

ELAPSED=$(( $(date +%s) - START ))
TOTAL=$((PASSED + FAILED))
if [ "$FAILED" -gt 0 ]; then
    echo "▶ Integration: ${PASSED}/${TOTAL} suites passed in ${ELAPSED}s (${FAILED} failed)"
    exit 1
fi
echo "▶ Integration: ${TOTAL} suites passed in ${ELAPSED}s"
