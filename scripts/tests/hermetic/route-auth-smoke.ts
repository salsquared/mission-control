/**
 * Structural auth-shape smoke for tunnel-exposed routes.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/route-auth-smoke.ts
 *
 * Why structural and not behavioral: `getServerSession` reads from Next.js's
 * per-request async-local storage. Calling a route handler directly from a
 * standalone tsx script throws "headers() called outside a request scope" —
 * we can't exercise the full guard runtime hermetically without booting Next.
 * Behavioral verification belongs in the manual `curl` smoke (see the patch
 * commit message / docs/next_steps.md).
 *
 * What this smoke DOES catch: regressions where someone removes the guard
 * import or guard call from one of the patched routes. For each route we
 * assert:
 *   1. The file imports the expected guard from @/lib/auth-guards.
 *   2. The file calls the expected guard with proper error-return wiring.
 *
 * That's enough to keep the patch alive — anyone deleting the guard fails
 * the pre-push hook before the regression ships.
 */
import fs from "fs";
import path from "path";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

interface RouteSpec {
    label: string;
    file: string;
    /** "session" = requireSession; "local-or-session" = requireLocalOrSession. */
    guard: "session" | "local-or-session";
}

const ROUTES: RouteSpec[] = [
    // requireSession (always require auth, tunnel + LAN)
    { label: "/api/events",                       file: "app/api/events/route.ts",                       guard: "session" },
    { label: "/api/system/logs",                  file: "app/api/system/logs/route.ts",                  guard: "session" },
    { label: "/api/system/logs/historical",       file: "app/api/system/logs/historical/route.ts",       guard: "session" },
    { label: "/api/research/import",              file: "app/api/research/import/route.ts",              guard: "session" },

    // requireLocalOrSession (LAN skip, tunnel requires session)
    { label: "/api/system",                       file: "app/api/system/route.ts",                       guard: "local-or-session" },
    { label: "/api/research",                     file: "app/api/research/route.ts",                     guard: "local-or-session" },
    { label: "/api/research/historical",          file: "app/api/research/historical/route.ts",          guard: "local-or-session" },
    { label: "/api/research/review",              file: "app/api/research/review/route.ts",              guard: "local-or-session" },
    { label: "/api/research/hf",                  file: "app/api/research/hf/route.ts",                  guard: "local-or-session" },
    { label: "/api/company-news",                 file: "app/api/company-news/route.ts",                 guard: "local-or-session" },
    { label: "/api/ai",                           file: "app/api/ai/route.ts",                           guard: "local-or-session" },
    { label: "/api/ai/llmleaderboard",            file: "app/api/ai/llmleaderboard/route.ts",            guard: "local-or-session" },
    { label: "/api/finance",                      file: "app/api/finance/route.ts",                      guard: "local-or-session" },
    { label: "/api/finance/history",              file: "app/api/finance/history/route.ts",              guard: "local-or-session" },
    { label: "/api/space",                        file: "app/api/space/route.ts",                        guard: "local-or-session" },
    { label: "/api/space/solar",                  file: "app/api/space/solar/route.ts",                  guard: "local-or-session" },
    { label: "/api/space/launches",               file: "app/api/space/launches/route.ts",               guard: "local-or-session" },
    { label: "/api/space/moon",                   file: "app/api/space/moon/route.ts",                   guard: "local-or-session" },
    { label: "/api/space/satellites",             file: "app/api/space/satellites/route.ts",             guard: "local-or-session" },
];

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function assertGuarded(spec: RouteSpec) {
    const abs = path.join(REPO_ROOT, spec.file);
    if (!fs.existsSync(abs)) {
        fail(`${spec.label}: file missing at ${spec.file}`);
        return;
    }
    const src = fs.readFileSync(abs, "utf8");
    const expectedFn = spec.guard === "session" ? "requireSession" : "requireLocalOrSession";

    // 1. Import present.
    const importRe = new RegExp(`import\\s*{[^}]*\\b${expectedFn}\\b[^}]*}\\s*from\\s+['"][^'"]*auth-guards['"]`);
    if (!importRe.test(src)) {
        fail(`${spec.label}: missing import of ${expectedFn} from auth-guards`);
        return;
    }
    pass(`${spec.label}: imports ${expectedFn}`);

    // 2. Call site present with proper return wiring (`if ('error' in guard) return guard.error`).
    const callRe = new RegExp(`\\bawait\\s+${expectedFn}\\s*\\(`);
    if (!callRe.test(src)) {
        fail(`${spec.label}: ${expectedFn} is imported but never awaited`);
        return;
    }
    const returnRe = /if\s*\(\s*['"]error['"]\s+in\s+\w+\s*\)\s*return\s+\w+\.error\b/;
    if (!returnRe.test(src)) {
        fail(`${spec.label}: guard return-wiring missing (expected "if ('error' in g) return g.error")`);
        return;
    }
    pass(`${spec.label}: ${expectedFn} called with proper return wiring`);

    // 3. Sanity: it's NOT also using the WRONG guard (e.g. session-required
    // routes shouldn't also be wrapped in requireLocalOrSession).
    const wrongFn = spec.guard === "session" ? "requireLocalOrSession" : "requireSession";
    const wrongCallRe = new RegExp(`\\bawait\\s+${wrongFn}\\s*\\(`);
    if (wrongCallRe.test(src)) {
        fail(`${spec.label}: also calls ${wrongFn} — guards conflict`);
    } else {
        pass(`${spec.label}: does not also call ${wrongFn}`);
    }
}

function main() {
    for (const spec of ROUTES) assertGuarded(spec);
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails === 0) console.log("All checks passed.");
    if (fails > 0) process.exit(1);
}

main();
