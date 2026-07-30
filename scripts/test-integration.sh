#!/usr/bin/env bash
#
# Mission-control integration test runner. Exercises real API routes against
# the dev PM2 process on :4101 — broader coverage than the hermetic pre-push
# suite but slower (~30–60s typical) and requires PM2 to be up.
#
# REQUIRES AN IDENTITY. Post-Cloudflare-Access, an unauthenticated caller gets
# 401 on every route, so this script pre-flights GET /api/account and aborts
# with arming instructions rather than running ten suites into a wall — see the
# identity pre-flight below.
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

# ── Identity pre-flight — the gate that keeps a locked-out run from scoring green ──
#
# Since the Cloudflare Access work (docs/multi-user-crew.html) every API route
# resolves the caller through lib/viewer.ts:resolveViewer(), which reads the
# edge-stamped `Cf-Access-Authenticated-User-Email` header. These suites call
# :4101 directly with plain fetch and a forged NextAuth cookie that nothing
# reads any more, so with no identity EVERY request 401s. On 2026-07-29 that
# state was scored "4/10 suites passed" — the suites' own exit paths were the
# other half of the bug (since fixed), but the runner should never have got far
# enough to report a number. So: probe first, and refuse to run.
#
# Do NOT "fix" this by weakening the origin. The sanctioned escape is the
# loopback break-glass, which is OFF by default and must go back off.
BASE_URL="${MC_BASE_URL:-http://localhost:4101}"
ACCOUNT_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE_URL/api/account" || echo "000")

if [ "$ACCOUNT_STATUS" != "200" ]; then
    echo ""
    echo "  ══════════════════════════════════════════════════════════════════════"
    echo "  ✗ ABORTING — the suites cannot authenticate against $BASE_URL"
    echo "    GET /api/account returned $ACCOUNT_STATUS (expected 200)."
    echo ""
    case "$ACCOUNT_STATUS" in
        401)
            echo "    401 = no Access-verified identity. Expected: these suites send no"
            echo "    Cf-Access-Authenticated-User-Email header and cannot mint one"
            echo "    (lib/access-jwt.ts is fail-closed by design). Running anyway would"
            echo "    just 401 ten suites in a row."
            echo ""
            echo "    To run them, arm the dev loopback break-glass — and disarm it after."
            echo "    'pm2 restart --update-env' can ADD an env var but cannot REMOVE one,"
            echo "    so both directions must RECREATE the process:"
            echo ""
            echo "      # arm"
            echo "      pm2 delete mission-control-dev"
            echo "      MC_DEV_LOOPBACK_OWNER=1 pm2 start ~/salsquared/ecosystem.config.cjs \\"
            echo "          --only mission-control-dev --update-env"
            echo ""
            echo "      npm run test:integration"
            echo ""
            echo "      # DISARM — not optional. Every loopback caller is the owner while armed."
            echo "      pm2 delete mission-control-dev"
            echo "      pm2 start ~/salsquared/ecosystem.config.cjs --only mission-control-dev"
            echo "      pm2 save   # so the boot-time dump can't resurrect an armed process"
            echo ""
            echo "    Verify the disarm from the LIVE process env, not 'pm2 describe':"
            echo "      ps eww -o command= -p \$(pgrep -P \$(pm2 pid mission-control-dev)) | tr ' ' '\\n' | grep MC_"
            echo "      curl -s -o /dev/null -w '%{http_code}' $BASE_URL/api/account   # want 401"
            ;;
        403)
            echo "    403 = identity verified, but no User row on this instance. Provision it:"
            echo "      npx tsx scripts/manage-crew.ts add <email>"
            ;;
        000)
            echo "    000 = no HTTP response at all. Is mission-control-dev actually serving"
            echo "    on $BASE_URL? (pm2 says online, which only means the process is up.)"
            ;;
        *)
            echo "    Unexpected status — inspect the response before trusting any run:"
            echo "      curl -i $BASE_URL/api/account"
            ;;
    esac
    echo "  ══════════════════════════════════════════════════════════════════════"
    echo ""
    echo "  Or skip the layer entirely: SKIP_INTEGRATION_TESTS=1 npm run test:integration"
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
