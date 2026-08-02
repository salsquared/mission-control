/**
 * Role-matrix smoke — every route in `app/api/**` carries a role decision.
 * P2.2 of docs/multi-user-crew.html; the manifest below is §2.5's 69-route table.
 *
 *   npx tsx scripts/tests/hermetic/role-matrix-smoke.ts
 *
 * WHY THIS FILE EXISTS. The owner/crew model is enforced by per-route guards
 * rather than by a middleware manifest, and the one thing a middleware manifest
 * would have given us for free is exhaustiveness: a route that matches no rule
 * is visibly unhandled. Check 1 below buys that back — it globs
 * `app/api/**\/route.ts` and fails if any file is absent from MANIFEST, so a new
 * route cannot reach `main` without someone writing down whether crew may call
 * it (design-doc risk R1). That assertion is the point of this file; everything
 * else verifies that the recorded decision is the one the code actually makes.
 *
 * THE TWO REJECTION CODES ARE ASSERTED SEPARATELY, NEVER AS "some 4xx"
 * (§2.3, OQ2a vs OQ3a). They answer different questions and have different
 * fixes, and a smoke that accepted either would pass with them swapped:
 *
 *   401 no-verified-identity — "I do not know who you are." Fix at the edge.
 *   403 owner-only           — "I know exactly who you are, and you may not do
 *                              this." Fix is the role, not the edge.
 *
 * HOW MUCH OF THIS IS BEHAVIOURAL. Most of it, and the split is deliberate:
 *
 *   Checks 4 and 5 are FULLY BEHAVIOURAL and per-route. They `require()` each
 *   real route module and call every HTTP method it exports, asserting the
 *   status code AND the `reason` discriminator off the real response body.
 *   No source-text pattern-matching, no stand-in for the guard. Crucially the
 *   handler BODY never runs in either phase — the guard short-circuits first —
 *   which is what keeps a smoke that drives 67 live route handlers hermetic.
 *   (If a guard were mis-wired the body WOULD run; that is the failure being
 *   detected, and DATABASE_URL is pinned to a throwaway path below so the blast
 *   radius of detecting it is a file in /tmp.)
 *
 *   The one direction that cannot be driven per-route is "a crew viewer is
 *   ADMITTED to a crew route", because admission means the body executes — and
 *   those bodies reach SQLite, Gemini and arXiv. That direction is proved
 *   COMPOSITIONALLY instead: check 3 drives each guard function directly and
 *   asserts behaviourally that the crew-admitting family really does admit a
 *   crew viewer, and check 6 asserts structurally that each crew-allowed route
 *   awaits a guard from that family and never from the owner family. Neither
 *   half is hand-waved; together they give "route → guard → admits crew".
 *
 * ASSERT BY GUARD FAMILY, NOT BY EXACT GUARD NAME. The crew family has held
 * three members and now holds two — `requireLocalOrSession` was a vestigial
 * alias of `requireSession` and was collapsed into it (P1.3.2). Pinning exact
 * names would have turned that zero-behaviour rename into a red gate, so the
 * manifest records the CLASS and the check accepts any guard in the matching
 * family; that is what let the collapse land here as a deletion and nothing
 * more. Keep it that way for the next one. The one exception is
 * spelled out in check 7: `calendar/event` is the sole route on the
 * `requireOwnerOrService` carve-out, and that is asserted by name.
 *
 * Hermetic: no network, no PM2, and no read or write of dev.db / prod.db.
 */

// Pin a throwaway DATABASE_URL so any transitive `lib/prisma` load points at a
// scratch file rather than dev.db — belt-and-suspenders against the "phantom
// prisma/prisma/dev.db" footgun, and the blast-radius bound described above.
// Unlinked in main()'s finally.
const SCRATCH_DB = `/tmp/role-matrix-smoke-${process.pid}.db`;
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
// Checks 3–5 assert the STRICT deny path. The pre-push hook may run in a shell
// with a break-glass escape armed (P5.1.3), which would resolve a viewer where
// this file requires none.
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

import fs from "fs";
import path from "path";
import {
    requireOwner,
    requireOwnerOrService,
    requireSession,
    requireSessionOrService,
    type ServiceTokenConfig,
} from "@/lib/auth-guards";
import { __seedViewer, __resetViewer, type Viewer } from "@/lib/viewer";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
function section(title: string) { console.log(`\n── ${title}`); }

// ---------------------------------------------------------------------------
// The manifest — docs/multi-user-crew.html §2.5.
//
// `route` is the path under `app/api`, i.e. the manifest key derived from
// `app/api/<route>/route.ts`. Every file under app/api MUST appear here.
//
//   'owner'     — owner-only. Crew gets 403. Guard family: requireOwner /
//                 requireOwnerOrService.
//   'crew'      — any provisioned viewer. Guard family: requireSession /
//                 requireSessionOrService. The handler
//                 is then responsible for scoping by session.user.id (§2.4's
//                 second invariant, covered by user-scoping-smoke.ts).
//   'unguarded' — deliberately carries no auth-guard because a different,
//                 named gate authenticates the caller. Two routes, both with
//                 their sentinel asserted in check 7.
// ---------------------------------------------------------------------------

type RouteClass = "owner" | "crew" | "unguarded";

interface RouteSpec {
    route: string;
    cls: RouteClass;
    /** §2.5's group label — printed in the matrix, and count-asserted in check 2. */
    group: string;
    /**
     * `unguarded` only: the gate that stands in for an auth-guard. Every pattern
     * must be present in `file`, otherwise the route is simply unprotected.
     */
    sentinel?: { file: string; patterns: RegExp[]; why: string };
}

const MANIFEST: RouteSpec[] = [
    // ---- Owner-only — other dashes (16) ----------------------------------
    // Not the job/resume path: research, space, finance, AI news. Nothing here
    // is crew-relevant and several are per-user-expensive upstream calls.
    { route: "ai", cls: "owner", group: "owner/other-dashes" },
    { route: "ai/llmleaderboard", cls: "owner", group: "owner/other-dashes" },
    { route: "company-news", cls: "owner", group: "owner/other-dashes" },
    { route: "finance", cls: "owner", group: "owner/other-dashes" },
    { route: "finance/history", cls: "owner", group: "owner/other-dashes" },
    { route: "space", cls: "owner", group: "owner/other-dashes" },
    { route: "space/launches", cls: "owner", group: "owner/other-dashes" },
    { route: "space/moon", cls: "owner", group: "owner/other-dashes" },
    { route: "space/satellites", cls: "owner", group: "owner/other-dashes" },
    { route: "space/satellites/history", cls: "owner", group: "owner/other-dashes" },
    { route: "space/solar", cls: "owner", group: "owner/other-dashes" },
    { route: "research", cls: "owner", group: "owner/other-dashes" },
    { route: "research/hf", cls: "owner", group: "owner/other-dashes" },
    { route: "research/historical", cls: "owner", group: "owner/other-dashes" },
    { route: "research/review", cls: "owner", group: "owner/other-dashes" },
    { route: "research/import", cls: "owner", group: "owner/other-dashes" },
    { route: "research/saved", cls: "owner", group: "owner/other-dashes" },

    // ---- Owner-only — ops (8) --------------------------------------------
    // system/logs is the sharpest of these: lib/logger.ts monkey-patches
    // console.* into a ring buffer, and in prod that includes the Prisma
    // $allOperations query log WITH PARAMETER VALUES — i.e. every user's data.
    // Hiding the dash is not enough; the route itself must be owner-only.
    { route: "system", cls: "owner", group: "owner/ops" },
    { route: "system/cache/invalidate", cls: "owner", group: "owner/ops" },
    { route: "system/logs", cls: "owner", group: "owner/ops" },
    { route: "system/logs/historical", cls: "owner", group: "owner/ops" },
    { route: "system/fetcher-health", cls: "owner", group: "owner/ops" },
    { route: "notifications/test", cls: "owner", group: "owner/ops" },

    // The crew-management surface (P7). Owner-only for two separate reasons,
    // and losing EITHER guard would be its own incident: the GET enumerates
    // every account's email plus what they have been spending (the cross-user
    // visibility §3.2 gives the owner and denies crew), and the POST/DELETE are
    // the account-creation and account-destruction surfaces themselves. A crew
    // viewer reaching DELETE could remove every other crew member; reaching
    // POST could provision an accomplice.
    { route: "crew", cls: "owner", group: "owner/ops" },
    { route: "crew/[id]", cls: "owner", group: "owner/ops" },

    // ---- Owner-only — needs the owner's Google tokens directly (4) --------
    // These reach Gmail/Calendar through the owner's refresh token. Crew has no
    // linked Google account, so admitting them would mean operating the owner's
    // mailbox on a crew member's behalf.
    { route: "applications/backfill", cls: "owner", group: "owner/google" },
    { route: "applications/events/adopt", cls: "owner", group: "owner/google" },
    { route: "applications/events/gcal-candidates", cls: "owner", group: "owner/google" },
    // The one requireOwnerOrService route — see check 7.
    { route: "calendar/event", cls: "owner", group: "owner/google" },

    // ---- Crew-allowed — applications (6) ---------------------------------
    { route: "applications", cls: "crew", group: "crew/applications" },
    { route: "applications/bulk-track", cls: "crew", group: "crew/applications" },
    { route: "applications/contacts", cls: "crew", group: "crew/applications" },
    { route: "applications/events", cls: "crew", group: "crew/applications" },
    { route: "applications/events/sync", cls: "crew", group: "crew/applications" },
    { route: "applications/pipeline-picker", cls: "crew", group: "crew/applications" },

    // ---- Crew-allowed — postings & watchlists (8) ------------------------
    { route: "postings", cls: "crew", group: "crew/postings" },
    { route: "postings/[id]", cls: "crew", group: "crew/postings" },
    { route: "postings/[id]/track-as-application", cls: "crew", group: "crew/postings" },
    { route: "watchlists", cls: "crew", group: "crew/postings" },
    { route: "watchlists/[id]", cls: "crew", group: "crew/postings" },
    { route: "watchlists/[id]/run", cls: "crew", group: "crew/postings" },
    { route: "blacklist", cls: "crew", group: "crew/postings" },
    { route: "blacklist/[id]", cls: "crew", group: "crew/postings" },

    // ---- Crew-allowed — profile & resumes (18) ---------------------------
    { route: "profile", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/bullets/assist", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/education", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/import", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/projects", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/snapshots", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/snapshots/[id]", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/tagline/draft", cls: "crew", group: "crew/profile-resumes" },
    { route: "profile/work-roles", cls: "crew", group: "crew/profile-resumes" },
    { route: "resumes", cls: "crew", group: "crew/profile-resumes" },
    { route: "resumes/[id]", cls: "crew", group: "crew/profile-resumes" },
    { route: "resumes/[id]/download", cls: "crew", group: "crew/profile-resumes" },
    { route: "resumes/diff", cls: "crew", group: "crew/profile-resumes" },
    { route: "resumes/specialize", cls: "crew", group: "crew/profile-resumes" },
    { route: "canons", cls: "crew", group: "crew/profile-resumes" },
    { route: "canons/[id]", cls: "crew", group: "crew/profile-resumes" },
    { route: "canons/[id]/preview", cls: "crew", group: "crew/profile-resumes" },
    { route: "canons/[id]/selection", cls: "crew", group: "crew/profile-resumes" },

    // ---- Crew-allowed — shell & cross-cutting (7) ------------------------
    // `settings` is crew-allowed with no change because GlobalSetting is already
    // one row per user — theme / hues / dashOrder are already per-person.
    { route: "account", cls: "crew", group: "crew/shell" },
    { route: "events", cls: "crew", group: "crew/shell" },
    { route: "settings", cls: "crew", group: "crew/shell" },
    { route: "notifications", cls: "crew", group: "crew/shell" },
    { route: "discovery/suggest", cls: "crew", group: "crew/shell" },
    { route: "tasks", cls: "crew", group: "crew/shell" },
    { route: "goals", cls: "crew", group: "crew/shell" },

    // ---- Unguarded by design (2) -----------------------------------------
    {
        route: "auth/[...nextauth]",
        cls: "unguarded",
        group: "unguarded",
        sentinel: {
            file: "lib/auth.ts",
            patterns: [/ALLOWED_SIGNIN_EMAILS/, /\bsignIn\b/],
            why: "the NextAuth signIn callback checks ALLOWED_SIGNIN_EMAILS; a guard here would lock out the sign-in flow itself",
        },
    },
    {
        route: "gmail/webhook",
        cls: "unguarded",
        group: "unguarded",
        sentinel: {
            file: "app/api/gmail/webhook/route.ts",
            patterns: [/verifyPubSubOIDC/, /await\s+verifyPubSubOIDC\s*\(/],
            why: "Google Pub/Sub cannot do interactive login; the caller is authenticated by its OIDC service-account JWT",
        },
    },
];

/** §2.5's totals. Asserted so a route MOVED between classes also trips. */
const EXPECTED = { owner: 29, crew: 39, unguarded: 2, total: 70 } as const;

// Guard families. Membership, not identity — see the header note on why exact
// names are deliberately not pinned.
const OWNER_GUARDS = ["requireOwner", "requireOwnerOrService"] as const;
const CREW_GUARDS = ["requireSession", "requireSessionOrService"] as const;
const ALL_GUARDS = [...OWNER_GUARDS, ...CREW_GUARDS] as readonly string[];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const API_ROOT = path.join(REPO_ROOT, "app", "api");

const CREW_VIEWER: Viewer = { id: "role-matrix-crew", email: "crew@role-matrix.invalid", role: "crew" };
const OWNER_VIEWER: Viewer = { id: "role-matrix-owner", email: "owner@role-matrix.invalid", role: "owner" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every `route.ts` under app/api, as manifest keys. */
function discoverRoutes(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) discoverRoutes(p, out);
        else if (entry.name === "route.ts") out.push(path.relative(API_ROOT, path.dirname(p)));
    }
    return out;
}

function routeFile(route: string): string {
    return path.join("app", "api", route, "route.ts");
}

function readRoute(route: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, routeFile(route)), "utf8");
}

/** Guards this file imports from `@/lib/auth-guards`. */
function importedGuards(src: string): string[] {
    const found = new Set<string>();
    for (const m of src.matchAll(/import\s*(?:type\s*)?{([^}]*)}\s*from\s+['"][^'"]*auth-guards['"]/g)) {
        for (const g of ALL_GUARDS) if (new RegExp(`\\b${g}\\b`).test(m[1])) found.add(g);
    }
    return [...found];
}

/**
 * Guards this file actually AWAITS. Distinct from the import list on purpose —
 * an imported-but-never-called guard is the exact regression shape the original
 * route-auth-smoke was written to catch.
 */
function awaitedGuards(src: string): string[] {
    return ALL_GUARDS.filter((g) => new RegExp(`\\bawait\\s+${g}\\s*\\(`).test(src));
}

/** The standard wiring, uniform across all 67 guarded routes today. */
function hasReturnWiring(src: string): boolean {
    return /if\s*\(\s*['"]error['"]\s+in\s+\w+\s*\)\s*return\s+\w+\.error\b/.test(src);
}

interface LoadedRoute {
    mod: Record<string, unknown>;
    methods: string[];
}

const moduleCache = new Map<string, LoadedRoute>();

function loadRoute(route: string): LoadedRoute {
    const cached = moduleCache.get(route);
    if (cached) return cached;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(`@/app/api/${route}/route`) as Record<string, unknown>;
    const methods = HTTP_METHODS.filter((m) => typeof mod[m] === "function");
    const loaded = { mod, methods };
    moduleCache.set(route, loaded);
    return loaded;
}

/**
 * Call one exported handler and reduce the response to `"<status>:<reason>"`.
 * A throw is reported verbatim rather than swallowed: a guard NEVER throws (it
 * returns a NextResponse), so a throw means execution reached the handler body
 * — which is itself the failure.
 */
async function driveHandler(route: string, method: string): Promise<string> {
    const { mod } = loadRoute(route);
    const handler = mod[method] as (req: Request, ctx: unknown) => Promise<Response>;
    // Dynamic segments are stubbed; the guard rejects long before params are read.
    const url = `http://role-matrix-smoke.invalid/api/${route.replace(/\[[^\]]+\]/g, "role-matrix-probe")}`;
    const req =
        method === "GET" || method === "HEAD"
            ? new Request(url, { method })
            : new Request(url, { method, headers: { "content-type": "application/json" }, body: "{}" });
    const ctx = { params: Promise.resolve({ id: "role-matrix-probe", slug: ["role-matrix-probe"] }) };
    try {
        const res = await handler(req, ctx);
        let reason = "";
        try {
            reason = ((await res.clone().json()) as { reason?: string }).reason ?? "";
        } catch {
            /* non-JSON body — leave reason empty */
        }
        return `${res.status}${reason ? `:${reason}` : ""}`;
    } catch (err) {
        return `THREW(${(err as Error).message.split("\n")[0].slice(0, 80)})`;
    }
}

// ---------------------------------------------------------------------------
// Check 1 (P2.2.2) — the R1 tripwire. Manifest ⇄ filesystem, both directions.
// ---------------------------------------------------------------------------

function checkManifestCoversEveryRoute(discovered: string[]): void {
    section("1. Manifest completeness — every app/api route is classified (P2.2.2, R1)");

    const declared = new Set(MANIFEST.map((r) => r.route));
    const onDisk = new Set(discovered);

    const unclassified = discovered.filter((r) => !declared.has(r)).sort();
    if (unclassified.length > 0) {
        for (const route of unclassified) {
            fail(
                `UNCLASSIFIED ROUTE: ${routeFile(route)}\n` +
                `        This route has no role decision. Every route must be classified before it can\n` +
                `        ship — that is the whole point of this smoke (design-doc R1).\n` +
                `        FIX: add an entry to MANIFEST in ${path.relative(REPO_ROOT, __filename)}:\n` +
                `            { route: "${route}", cls: "owner" | "crew" | "unguarded", group: "…" },\n` +
                `        'owner' = owner-only (crew gets 403; use requireOwner / requireOwnerOrService).\n` +
                `        'crew'  = any provisioned viewer (requireSession / requireSessionOrService)\n` +
                `                  — and the handler MUST scope by session.user.id.\n` +
                `        'unguarded' = a named non-auth-guard gate authenticates the caller; declare it\n` +
                `                  in \`sentinel\` so check 7 asserts the gate still exists.\n` +
                `        If you are unsure: the rule in §2.5 is that a route is owner-only if it serves a\n` +
                `        non-job dash, is an ops surface, or needs the owner's Google tokens. Everything on\n` +
                `        the job + resume path is crew-allowed.`,
            );
        }
    } else {
        pass(`every one of the ${discovered.length} routes under app/api is classified in MANIFEST`);
    }

    const stale = MANIFEST.map((r) => r.route).filter((r) => !onDisk.has(r)).sort();
    if (stale.length > 0) {
        for (const route of stale) {
            fail(
                `STALE MANIFEST ENTRY: "${route}" has no file at ${routeFile(route)}. ` +
                `If the route was deleted or renamed, update MANIFEST (and §2.5's table + the counts).`,
            );
        }
    } else {
        pass("no stale MANIFEST entries — every declared route exists on disk");
    }

    const dupes = MANIFEST.map((r) => r.route).filter((r, i, a) => a.indexOf(r) !== i);
    if (dupes.length > 0) fail(`duplicate MANIFEST entries: ${[...new Set(dupes)].join(", ")}`);
    else pass("no duplicate MANIFEST entries");
}

// ---------------------------------------------------------------------------
// Check 2 — the counts. A route MOVED between classes without a manifest edit
// trips here even though check 1 would still be satisfied.
// ---------------------------------------------------------------------------

function checkCounts(discovered: string[]): void {
    // Interpolated from EXPECTED rather than spelled out: a hand-written header
    // silently rots the moment a route is added (it read "28 + 39 + 2 = 69"
    // while EXPECTED already said 29/70), and a stale banner over passing
    // assertions is worse than no banner.
    section(
        `2. Class counts — ${EXPECTED.owner} owner + ${EXPECTED.crew} crew + ` +
        `${EXPECTED.unguarded} unguarded = ${EXPECTED.total} (§2.5)`,
    );

    const byClass = (cls: RouteClass) => MANIFEST.filter((r) => r.cls === cls).length;
    const cases: Array<[string, number, number]> = [
        ["owner-only", byClass("owner"), EXPECTED.owner],
        ["crew-allowed", byClass("crew"), EXPECTED.crew],
        ["unguarded-by-design", byClass("unguarded"), EXPECTED.unguarded],
        ["MANIFEST total", MANIFEST.length, EXPECTED.total],
        ["routes on disk", discovered.length, EXPECTED.total],
    ];
    for (const [label, got, want] of cases) {
        if (got === want) pass(`${label}: ${got}`);
        else fail(`${label}: expected ${want}, got ${got} — reconcile MANIFEST with §2.5's table`);
    }

    // §2.5's sub-group sizes, so a route drifting between (say) owner/ops and
    // owner/google is visible even though the class total is unchanged.
    const groups: Array<[string, number]> = [
        ["owner/other-dashes", 17],
        ["owner/ops", 8],
        ["owner/google", 4],
        ["crew/applications", 6],
        ["crew/postings", 8],
        ["crew/profile-resumes", 18],
        ["crew/shell", 7],
        ["unguarded", 2],
    ];
    for (const [group, want] of groups) {
        const got = MANIFEST.filter((r) => r.group === group).length;
        if (got === want) pass(`group ${group}: ${got}`);
        else fail(`group ${group}: expected ${want}, got ${got}`);
    }
}

// ---------------------------------------------------------------------------
// Check 3 (P2.2.1) — behavioural guard matrix. 401 and 403 are asserted as
// DISTINCT outcomes with distinct reasons; this is the check that would fail if
// the two were ever collapsed or swapped.
// ---------------------------------------------------------------------------

const SMOKE_SERVICE_CONFIG: ServiceTokenConfig = {
    tokenEnv: "SERVICE_TOKEN_ROLE_MATRIX_SMOKE",
    userIdEnv: "SERVICE_TOKEN_ROLE_MATRIX_SMOKE_USER_ID",
};
const SMOKE_SERVICE_TOKEN = "role-matrix-smoke-service-token";
const SMOKE_SERVICE_USER_ID = "role-matrix-service-user";

type GuardResult = { error?: Response } & Record<string, unknown>;

async function statusAndReason(res: Response): Promise<string> {
    let reason = "";
    try {
        reason = ((await res.clone().json()) as { reason?: string }).reason ?? "";
    } catch {
        /* non-JSON body */
    }
    return `${res.status}${reason ? `:${reason}` : ""}`;
}

async function expectDenied(label: string, result: GuardResult, want: string): Promise<void> {
    if (!result.error) {
        fail(`${label}: expected ${want} but the guard ADMITTED the caller`, Object.keys(result));
        return;
    }
    const got = await statusAndReason(result.error);
    if (got === want) pass(`${label} → ${got}`);
    else fail(`${label}: expected ${want}, got ${got}`);
}

function expectAdmitted(label: string, result: GuardResult, wantKey: "session" | "userId"): void {
    if (result.error) {
        fail(`${label}: expected admission (${wantKey}), got a rejection`);
        return;
    }
    if (!(wantKey in result)) {
        fail(`${label}: admitted but returned no \`${wantKey}\``, Object.keys(result));
        return;
    }
    pass(`${label} → admitted, { ${wantKey} }`);
}

function svcRequest(withToken: boolean): Request {
    const url = `http://role-matrix-smoke.invalid/api/calendar/event?onBehalfOf=${SMOKE_SERVICE_USER_ID}`;
    return new Request(url, {
        method: "POST",
        headers: withToken ? { authorization: `Bearer ${SMOKE_SERVICE_TOKEN}` } : {},
    });
}

async function checkGuardBehaviour(): Promise<void> {
    section("3. Behavioural guard matrix — 401 ≠ 403, driven through the real guards (P2.2.1)");

    process.env[SMOKE_SERVICE_CONFIG.tokenEnv] = SMOKE_SERVICE_TOKEN;
    process.env[SMOKE_SERVICE_CONFIG.userIdEnv] = SMOKE_SERVICE_USER_ID;
    const plainReq = new Request("http://role-matrix-smoke.invalid/api/anything");

    try {
        // --- No identity at all → 401 on every guard. ----------------------
        __resetViewer();
        await expectDenied("requireOwner()            [no identity]", await requireOwner(), "401:no-verified-identity");
        await expectDenied("requireSession()          [no identity]", await requireSession(), "401:no-verified-identity");
        await expectDenied("requireSessionOrService() [no identity]", await requireSessionOrService(plainReq, SMOKE_SERVICE_CONFIG), "401:no-verified-identity");
        await expectDenied("requireOwnerOrService()   [no identity]", await requireOwnerOrService(svcRequest(false), SMOKE_SERVICE_CONFIG), "401:no-verified-identity");

        // --- Authenticated crew: admitted by the crew family… --------------
        __seedViewer(CREW_VIEWER);
        expectAdmitted("requireSession()          [crew]", await requireSession(), "session");
        expectAdmitted("requireSessionOrService() [crew]", await requireSessionOrService(plainReq, SMOKE_SERVICE_CONFIG), "userId");

        // --- …and rejected 403 (NOT 401) by the owner family. --------------
        // This pair is the heart of P2.2.1: same viewer, same process, two
        // different codes decided purely by the guard's role check.
        await expectDenied("requireOwner()            [crew]", await requireOwner(), "403:owner-only");
        await expectDenied("requireOwnerOrService()   [crew, session branch]", await requireOwnerOrService(svcRequest(false), SMOKE_SERVICE_CONFIG), "403:owner-only");

        // The Bearer branch is deliberately EXEMPT from the role check: Pulsar
        // is a machine pinned to a user id by config, not a viewer with a role.
        // Seeded crew is still in effect here — that is the point.
        expectAdmitted("requireOwnerOrService()   [Bearer service token, role check exempt]", await requireOwnerOrService(svcRequest(true), SMOKE_SERVICE_CONFIG), "userId");

        // --- Owner: admitted by everything. --------------------------------
        __seedViewer(OWNER_VIEWER);
        expectAdmitted("requireOwner()            [owner]", await requireOwner(), "session");
        expectAdmitted("requireOwnerOrService()   [owner, session branch]", await requireOwnerOrService(svcRequest(false), SMOKE_SERVICE_CONFIG), "userId");
        expectAdmitted("requireSession()          [owner]", await requireSession(), "session");

        // --- The codes are not interchangeable. ----------------------------
        __seedViewer(CREW_VIEWER);
        const crewOnOwner = (await requireOwner()) as GuardResult;
        __resetViewer();
        const anonOnOwner = (await requireOwner()) as GuardResult;
        if (!crewOnOwner.error || !anonOnOwner.error) {
            fail("401-vs-403 discrimination: expected both calls to deny");
        } else if (crewOnOwner.error.status === anonOnOwner.error.status) {
            fail(
                `401-vs-403 discrimination COLLAPSED: crew and anonymous both got ` +
                `${crewOnOwner.error.status} — §2.3 requires 403 for crew and 401 for no identity`,
            );
        } else {
            pass(
                `401 ≠ 403 discrimination holds: anonymous → ${anonOnOwner.error.status}, ` +
                `crew → ${crewOnOwner.error.status} on the same route guard`,
            );
        }
    } finally {
        __resetViewer();
        delete process.env[SMOKE_SERVICE_CONFIG.tokenEnv];
        delete process.env[SMOKE_SERVICE_CONFIG.userIdEnv];
    }
}

// ---------------------------------------------------------------------------
// Check 4 (P2.2.1) — behavioural, per-route: no verified identity → 401.
//
// Drives EVERY exported HTTP method of all 67 guarded routes. This is also what
// makes a per-method audit unnecessary: a newly added POST that forgot its guard
// answers something other than 401 and fails here.
// ---------------------------------------------------------------------------

async function checkAnonymousIs401(): Promise<void> {
    // Interpolated from EXPECTED rather than written out: the printed count is
    // the thing that goes stale (it said 65 while 67 routes were guarded), and
    // check 2 already fails if EXPECTED itself drifts from the manifest.
    section(`4. Behavioural per-route — no verified identity → 401 (all ${EXPECTED.total - EXPECTED.unguarded} guarded routes, every method)`);
    __resetViewer();
    let methodCount = 0;
    for (const spec of MANIFEST) {
        if (spec.cls === "unguarded") continue;
        const { methods } = loadRoute(spec.route);
        if (methods.length === 0) {
            fail(`/api/${spec.route}: exports no HTTP handler — cannot verify it is guarded`);
            continue;
        }
        const bad: string[] = [];
        for (const m of methods) {
            const got = await driveHandler(spec.route, m);
            methodCount++;
            if (got !== "401:no-verified-identity") bad.push(`${m}→${got}`);
        }
        if (bad.length === 0) {
            pass(`/api/${spec.route} [${methods.join(",")}] → 401:no-verified-identity`);
        } else {
            fail(
                `/api/${spec.route}: expected 401:no-verified-identity from every method, got ${bad.join(", ")} — ` +
                `an unguarded method, or a guard whose rejection is not returned`,
            );
        }
    }
    pass(`${methodCount} handler invocations denied with 401, no handler body reached`);
}

// ---------------------------------------------------------------------------
// Check 5 (P2.2.1) — behavioural, per-route: authenticated crew → 403 on every
// owner-only route. The end-to-end version of the property this task exists for.
// ---------------------------------------------------------------------------

async function checkCrewIs403OnOwnerRoutes(): Promise<void> {
    section(`5. Behavioural per-route — authenticated crew → 403:owner-only (all ${EXPECTED.owner} owner-only routes)`);
    __seedViewer(CREW_VIEWER);
    try {
        let methodCount = 0;
        for (const spec of MANIFEST) {
            if (spec.cls !== "owner") continue;
            const { methods } = loadRoute(spec.route);
            const bad: string[] = [];
            for (const m of methods) {
                const got = await driveHandler(spec.route, m);
                methodCount++;
                if (got !== "403:owner-only") bad.push(`${m}→${got}`);
            }
            if (bad.length === 0) {
                pass(`/api/${spec.route} [${methods.join(",")}] → 403:owner-only`);
            } else {
                fail(
                    `/api/${spec.route} is declared owner-only but a crew viewer got ${bad.join(", ")}. ` +
                    `A 401 here means the codes are swapped; anything else means crew can reach it.`,
                );
            }
        }
        pass(`${methodCount} handler invocations rejected 403 for crew, no handler body reached`);
    } finally {
        __resetViewer();
    }
}

// ---------------------------------------------------------------------------
// Check 6 — structural, per-route: the declared class matches the guard family
// in use. For crew-allowed routes this is the half that composes with check 3
// into "a crew viewer is admitted"; for owner routes it corroborates check 5 and
// catches a second, conflicting guard that the behavioural pass could not see.
// ---------------------------------------------------------------------------

interface MatrixRow { route: string; cls: RouteClass; guards: string; methods: string }
const matrix: MatrixRow[] = [];

function checkGuardFamilyMatchesClass(): void {
    section("6. Structural per-route — declared class ⇄ guard family in use");

    for (const spec of MANIFEST) {
        const src = readRoute(spec.route);
        const imported = importedGuards(src);
        const awaited = awaitedGuards(src);
        const { methods } = loadRoute(spec.route);
        matrix.push({
            route: spec.route,
            cls: spec.cls,
            guards: awaited.length > 0 ? awaited.join("+") : "—",
            methods: methods.join(","),
        });

        if (spec.cls === "unguarded") continue; // check 7 owns these

        const wanted = spec.cls === "owner" ? OWNER_GUARDS : CREW_GUARDS;
        const forbidden = spec.cls === "owner" ? CREW_GUARDS : OWNER_GUARDS;
        const family = spec.cls === "owner" ? "owner (requireOwner/requireOwnerOrService)" : "crew (requireSession/requireSessionOrService)";

        const used = awaited.filter((g) => (wanted as readonly string[]).includes(g));
        const wrong = awaited.filter((g) => (forbidden as readonly string[]).includes(g));

        if (used.length === 0) {
            const hint =
                awaited.length > 0
                    ? ` — it awaits ${awaited.join(", ")} instead. Either the route was re-guarded and MANIFEST is stale, or MANIFEST is right and the route is wrong; §2.5 decides which.`
                    : imported.length > 0
                        ? ` — it imports ${imported.join(", ")} but never awaits it, so the guard does not run.`
                        : " — it awaits no guard at all, so it is unprotected.";
            fail(`/api/${spec.route}: declared ${spec.cls} but awaits no guard from the ${family} family${hint}`);
            continue;
        }
        if (!imported.some((g) => (wanted as readonly string[]).includes(g))) {
            fail(`/api/${spec.route}: awaits ${used.join(", ")} without importing it from @/lib/auth-guards`);
            continue;
        }
        if (wrong.length > 0) {
            fail(
                `/api/${spec.route}: declared ${spec.cls} but ALSO awaits ${wrong.join(", ")} from the opposite family — ` +
                `conflicting guards mean the effective role depends on which handler you hit`,
            );
            continue;
        }
        if (!hasReturnWiring(src)) {
            fail(`/api/${spec.route}: guard called but rejection not returned (expected \`if ('error' in g) return g.error\`)`);
            continue;
        }
        pass(`/api/${spec.route}: ${spec.cls} · ${used.join("+")} · wired`);
    }
}

// ---------------------------------------------------------------------------
// Check 7 — the two deliberate exceptions, each asserted rather than assumed.
// ---------------------------------------------------------------------------

function checkDeliberateExceptions(): void {
    section("7. Deliberate exceptions — the 2 unguarded routes and the 1 service carve-out");

    for (const spec of MANIFEST) {
        if (spec.cls !== "unguarded" || !spec.sentinel) continue;
        const src = readRoute(spec.route);

        const awaited = awaitedGuards(src);
        if (awaited.length > 0) {
            // Not a failure of security — but the manifest now lies, and the
            // route should be reclassified so checks 4–6 cover it.
            fail(
                `/api/${spec.route} is declared unguarded but now awaits ${awaited.join(", ")}. ` +
                `Reclassify it as 'owner' or 'crew' in MANIFEST so the behavioural checks cover it.`,
            );
        } else {
            pass(`/api/${spec.route}: carries no auth-guard, as declared`);
        }

        const sentinelPath = path.join(REPO_ROOT, spec.sentinel.file);
        if (!fs.existsSync(sentinelPath)) {
            fail(`/api/${spec.route}: sentinel file ${spec.sentinel.file} is missing`);
            continue;
        }
        const sentinelSrc = fs.readFileSync(sentinelPath, "utf8");
        const missing = spec.sentinel.patterns.filter((p) => !p.test(sentinelSrc));
        if (missing.length > 0) {
            fail(
                `/api/${spec.route}: its stand-in gate is GONE from ${spec.sentinel.file} ` +
                `(missing ${missing.map(String).join(", ")}). This route has no auth-guard, so that gate is ` +
                `the ONLY thing authenticating the caller — ${spec.sentinel.why}.`,
            );
        } else {
            pass(`/api/${spec.route}: gated instead by ${spec.sentinel.file} — ${spec.sentinel.why}`);
        }
    }

    // The single requireOwnerOrService route. Named explicitly because it is the
    // one place an owner-only route intentionally admits a non-viewer caller.
    const ownerOrService = MANIFEST.filter(
        (s) => s.cls === "owner" && awaitedGuards(readRoute(s.route)).includes("requireOwnerOrService"),
    ).map((s) => s.route);

    if (ownerOrService.length === 1 && ownerOrService[0] === "calendar/event") {
        pass("calendar/event is the only requireOwnerOrService route — Pulsar's Bearer branch is exempt from the role check by design");
    } else {
        fail(
            `expected exactly one requireOwnerOrService route (calendar/event), found [${ownerOrService.join(", ") || "none"}]. ` +
            `Every additional one widens the set of owner-only routes reachable without a role check — ` +
            `verify the service-token carve-out is intended and update this assertion.`,
        );
    }

    // No CREW route may use the service variants without a deliberate decision:
    // requireSessionOrService admits a Bearer caller with no viewer at all.
    const crewWithService = MANIFEST.filter(
        (s) => s.cls === "crew" && awaitedGuards(readRoute(s.route)).includes("requireSessionOrService"),
    ).map((s) => s.route);
    if (crewWithService.length === 0) {
        pass("no crew-allowed route uses requireSessionOrService — no service-token bypass on the crew surface");
    } else {
        fail(
            `crew-allowed route(s) [${crewWithService.join(", ")}] use requireSessionOrService, which admits a Bearer ` +
            `caller with no viewer. Confirm the service identity is scoped to the right user id, then update this assertion.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Check 8 — the cache-key tripwire. A crew-allowed route may not be wrapped in
// a response cache that keys on the URL alone.
//
// WHY IT LIVES IN THIS FILE. `lib/cache.ts:withCache` keys on "pathname + sorted
// query" and nothing else, so a cached response is served to whoever asks next.
// Every one of today's wrapped routes is owner-only and returns a shared
// external feed (arXiv, NOAA, Pulsar…), so nothing leaks — but the moment
// someone wraps a crew-allowed route "for speed", crew member A's payload is
// served to crew member B, and NOT ONE existing test would see it: the
// row-scoping suites (user-scoping-smoke, crew-scoping-routes-smoke) all drive
// handlers directly, i.e. BELOW the cache wrapper. The manifest above is the one
// exhaustive list of which routes crew can reach, so the check belongs beside
// it — that is what makes it exhaustive by construction rather than a list
// someone has to remember to extend.
//
// `withCache` has an opt-in `userKeyFn` that prefixes the key with a caller
// identity (zero production callers today — it exists precisely for this case),
// so a crew-allowed cached route is acceptable WITH it and never without.
// `withSharedCache` is stricter: it has no such hook at all, and its store is
// shared across BOTH TIERS, so a crew-allowed route wrapped in it is
// unconditionally wrong. That asymmetry is read off the source below rather
// than hardcoded, so the message stays true if the hook is ever added.
//
// THREE SURFACES, not one, because the leak does not care which was used:
// `withCache` and `withSharedCache` wrap the handler, and `cachedValue(key, …)`
// is called INSIDE one with a hand-built key. The third has no hook to forget —
// the caller writes the whole key — so its rule is that a crew route's key must
// name the viewer. `discovery/suggest` is the only such caller today and does
// exactly that; this keeps the next one honest.
// ---------------------------------------------------------------------------

const CACHE_WRAPPERS = ["withCache", "withSharedCache"] as const;

/** Comment-free source — a `withCache` named in prose must not read as a call. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

interface CacheWrap { wrapper: string; args: string }

/** Every cache-wrapper CALL in a route file, with its full argument text. */
function cacheWraps(src: string): CacheWrap[] {
    const clean = stripComments(src);
    const out: CacheWrap[] = [];
    for (const wrapper of CACHE_WRAPPERS) {
        // Word-boundary + literal `(`: `withCache` is also a substring of
        // `withSharedCache`, and both are named in the routes' prose.
        const re = new RegExp(`(?<![A-Za-z0-9_$])${wrapper}\\s*\\(`, "g");
        for (let m = re.exec(clean); m; m = re.exec(clean)) {
            let depth = 0;
            let end = m.index + m[0].length - 1;
            for (let i = end; i < clean.length; i++) {
                if (clean[i] === "(") depth++;
                else if (clean[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
            }
            out.push({ wrapper, args: clean.slice(m.index, end + 1) });
        }
    }
    return out;
}

/**
 * The OTHER cache surface: `lib/cache.ts:cachedValue(key, ttl, fetcher)`, called
 * inside a handler with a hand-built key. There is no `userKeyFn` to forget
 * here — the caller writes the whole key — so the rule is simply that a
 * crew-allowed route's key must mention the viewer id. One caller today
 * (discovery/suggest) and it is correct; this keeps the next one honest.
 *
 * An unresolvable key is reported, not waved through: this is a leak tripwire,
 * and "I could not tell" must read as a failure with an actionable remedy.
 */
function cachedValueViolation(cls: RouteClass, src: string): string | null {
    if (cls !== "crew") return null;
    const clean = stripComments(src);
    const calls = [...clean.matchAll(/cachedValue\s*(?:<[^>]*>)?\s*\(\s*([^,]+),/g)];
    if (calls.length === 0) return null;

    for (const call of calls) {
        const keyArg = call[1].trim();
        // Inline template literal, or an identifier whose declaration we resolve.
        const keySrc = /^[`'"]/.test(keyArg)
            ? keyArg
            : (new RegExp(`(?:const|let|var)\\s+${keyArg.replace(/[^\w$]/g, "")}\\s*=([\\s\\S]*?);`).exec(clean)?.[1] ?? null);
        if (keySrc === null) {
            return (
                `calls cachedValue() with a key this check cannot resolve (\`${keyArg}\`). Inline the key or ` +
                "declare it as a single \\`const\\` in the handler so its per-user scoping can be verified."
            );
        }
        if (!/\buserId\b|\bviewer\b|session\.user\.id/.test(keySrc)) {
            return (
                `is crew-allowed and caches through cachedValue() on a key that does not include the viewer ` +
                `(\`${keySrc.trim().slice(0, 120)}\`). The store is process-wide, so the first crew member's ` +
                "value is replayed to every other caller. Put the user id in the key."
            );
        }
    }
    return null;
}

/**
 * The rule, as a pure predicate so it can be proved to reject the shapes it
 * exists for (teeth, below). Returns null when this route's caching is safe.
 */
function cacheScopingViolation(
    spec: { route: string; cls: RouteClass },
    src: string,
    sharedCacheSupportsUserKey: boolean,
): string | null {
    const byValue = cachedValueViolation(spec.cls, src);
    if (byValue) return byValue;

    const wraps = cacheWraps(src);
    if (wraps.length === 0 || spec.cls !== "crew") return null;

    const unscoped = wraps.filter(w => !/\buserKeyFn\b/.test(w.args));
    if (unscoped.length === 0) return null;

    const viaShared = unscoped.some(w => w.wrapper === "withSharedCache");
    if (viaShared && !sharedCacheSupportsUserKey) {
        return (
            "is crew-allowed and wrapped in withSharedCache, which has NO per-user key hook and whose store " +
            "is shared across BOTH TIERS — one user's payload would be served to the next caller, on either tier. " +
            "Use lib/cache.ts:withCache with a userKeyFn, or do not cache this route."
        );
    }
    return (
        `is crew-allowed and wrapped in ${unscoped.map(w => w.wrapper).join(", ")} without a \`userKeyFn\`. ` +
        "The cache key is pathname + sorted query only, so the FIRST crew member's response is replayed to " +
        "every other caller — a cross-user leak that the row-scoping suites cannot see, because they drive " +
        "handlers below the cache. Pass `userKeyFn` (lib/cache.ts) to scope the key to the viewer."
    );
}

function checkCacheKeyScoping(): void {
    section("8. Cache-key scoping — no crew-allowed route is cached on a shared key");

    const cacheSrc = fs.readFileSync(path.join(REPO_ROOT, "lib", "cache.ts"), "utf8");
    const sharedSrc = fs.readFileSync(path.join(REPO_ROOT, "lib", "research", "shared-cache.ts"), "utf8");

    // The escape hatch must still exist — it has zero production callers, which
    // makes it exactly the kind of thing a cleanup deletes. Without it, the only
    // correct answer for a crew-allowed route becomes "do not cache", and the
    // guidance in the failure message above would be wrong.
    if (!/userKeyFn/.test(cacheSrc)) {
        fail(
            "lib/cache.ts no longer exposes `userKeyFn`. It is the ONLY way to cache a crew-allowed route " +
            "safely; if it was removed as unused, this check's remedy no longer exists and the rule becomes " +
            "\"never wrap a crew-allowed route in withCache\".",
        );
    } else {
        pass("lib/cache.ts still exposes the `userKeyFn` per-user key hook (the sanctioned way to cache a crew route)");
    }
    const sharedCacheSupportsUserKey = /userKeyFn/.test(sharedSrc);

    const wrapped: string[] = [];
    let violations = 0;
    for (const spec of MANIFEST) {
        const src = readRoute(spec.route);
        const wraps = cacheWraps(src);
        if (wraps.length > 0) {
            wrapped.push(`${spec.route} [${spec.cls}] ${[...new Set(wraps.map(w => w.wrapper))].join("+")}`);
        }
        const violation = cacheScopingViolation(spec, src, sharedCacheSupportsUserKey);
        if (violation) { fail(`/api/${spec.route} ${violation}`); violations++; }
    }
    if (violations === 0) {
        pass(
            `${wrapped.length} cache-wrapped route(s), none crew-allowed on a shared key: ${wrapped.join(", ") || "none"}`,
        );
    }

    // Teeth — the rule must reject the shapes it exists for, and admit the ones
    // it does not. Synthetic sources, so no production file is perturbed.
    const CREW = { route: "synthetic", cls: "crew" as RouteClass };
    const OWNER_SPEC = { route: "synthetic", cls: "owner" as RouteClass };
    const cases: Array<[string, string | null]> = [
        ["crew route wrapped in withCache with no userKeyFn",
            cacheScopingViolation(CREW, `const cachedGET = withCache(getHandler, { ttlSeconds: 60 });`, false)],
        ["crew route wrapped in withCache(handler, 60) shorthand",
            cacheScopingViolation(CREW, `const cachedGET = withCache(getHandler, 60);`, false)],
        ["crew route wrapped in withSharedCache",
            cacheScopingViolation(CREW, `const cachedGET = withSharedCache(getHandler, { ttlSeconds: 60, store: s });`, false)],
        ["crew route calling cachedValue() on a key with no user id",
            cacheScopingViolation(CREW, "const cacheKey = `suggest:${topic}`;\nawait cachedValue(cacheKey, 60, fetcher);", false)],
        ["crew route calling cachedValue() with an unresolvable key",
            cacheScopingViolation(CREW, "await cachedValue(buildKey(topic), 60, fetcher);", false)],
    ];
    const admitted: Array<[string, string | null]> = [
        ["owner route wrapped without userKeyFn (today's 14 routes)",
            cacheScopingViolation(OWNER_SPEC, `const cachedGET = withCache(getHandler, { ttlSeconds: 60 });`, false)],
        ["crew route wrapped WITH a userKeyFn",
            cacheScopingViolation(CREW, `const cachedGET = withCache(getHandler, { ttlSeconds: 60, userKeyFn: viewerKey });`, false)],
        ["a route that only MENTIONS withCache in a comment",
            cacheScopingViolation(CREW, `// withCache would be wrong here\nexport async function GET() {}`, false)],
        ["crew route, uncached",
            cacheScopingViolation(CREW, `export async function GET() { return NextResponse.json({}); }`, false)],
        ["crew route calling cachedValue() on a userId-keyed key (today's discovery/suggest)",
            cacheScopingViolation(CREW, "const cacheKey = `suggest:${userId}:${topic}`;\nawait cachedValue<T>(cacheKey, 60, fetcher);", false)],
    ];
    const missed = cases.filter(([, v]) => v === null).map(([n]) => n);
    const overreach = admitted.filter(([, v]) => v !== null).map(([n]) => n);
    if (missed.length > 0) fail(`cache tripwire has no teeth against: ${missed.join("; ")}`);
    else if (overreach.length > 0) fail(`cache tripwire fires on safe shapes: ${overreach.join("; ")}`);
    else pass(`cache tripwire has teeth: rejects all ${cases.length} leak shapes, admits all ${admitted.length} safe ones`);
}

// ---------------------------------------------------------------------------

function printMatrix(): void {
    section("The matrix (route · class · guard · methods)");
    const w = Math.max(...matrix.map((r) => r.route.length)) + 2;
    for (const cls of ["owner", "crew", "unguarded"] as const) {
        for (const row of matrix.filter((r) => r.cls === cls)) {
            console.log(`  ${row.route.padEnd(w)} ${row.cls.padEnd(10)} ${row.guards.padEnd(24)} ${row.methods}`);
        }
    }
}

/**
 * Remove the scratch SQLite file. Registered on `exit` rather than run in a
 * `finally`: importing 67 route modules leaves a lazily-opened Prisma client
 * behind, which can touch the file AFTER the last await resolves — so a
 * finally-block unlink races it and loses. `exit` runs last, and `rmSync` is
 * synchronous, which is what that handler requires.
 */
function cleanScratchDb(): void {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        try { fs.rmSync(`${SCRATCH_DB}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
}

async function main(): Promise<void> {
    process.on("exit", cleanScratchDb);
    try {
        const discovered = discoverRoutes(API_ROOT).sort();
        checkManifestCoversEveryRoute(discovered);
        checkCounts(discovered);
        await checkGuardBehaviour();
        await checkAnonymousIs401();
        await checkCrewIs403OnOwnerRoutes();
        checkGuardFamilyMatchesClass();
        checkDeliberateExceptions();
        checkCacheKeyScoping();
        printMatrix();
    } finally {
        __resetViewer();
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails === 0) console.log("All checks passed.");
    else process.exit(1);
}

void main();
