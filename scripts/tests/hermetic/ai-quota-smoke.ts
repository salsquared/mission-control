/**
 * Hermetic smoke for the per-user daily Gemini credit counter
 * (lib/ai/quota.ts — docs/multi-user-crew.html §2.9 / OQ7a, task P2.5).
 *
 *   npx tsx scripts/tests/hermetic/ai-quota-smoke.ts
 *
 * Asserts:
 *   1. OWNER IS UNLIMITED — far more calls than any crew limit, every one
 *      granted, `limit === Infinity`, and NOT ONE AiUsage row written. The
 *      owner's spend is the thing the crew cap protects; metering it would be
 *      backwards, and a row would mean the exempt path touches the DB.
 *   2. CREW REFUSED AT N+1 — N grants reporting used 1..N, then refusal at
 *      N+1 with `{ ok: false, used: N, limit: N }`. Repeated refusals do NOT
 *      keep incrementing, so the 429 body can never say "used 47 of 3".
 *   3. THE DAY BUCKET ROLLS OVER — both halves: utcDateBucket() flips across
 *      UTC midnight (and NOT at local midnight), and a user whose only row
 *      belongs to a previous bucket starts the new day at used=1 with the old
 *      row preserved.
 *   4. TWO CREW MEMBERS HAVE INDEPENDENT COUNTERS — one exhausting their
 *      allowance leaves the other's untouched, and vice versa.
 *   5. CONCURRENCY AT THE BOUNDARY — limit+4 consumes fired simultaneously
 *      yield EXACTLY `limit` grants. A read-then-write implementation loses
 *      updates here; the single-statement guarded upsert does not.
 *   6. CREW_AI_DAILY_LIMIT=0 refuses without writing a row (the INSERT arm of
 *      the upsert is not covered by its own WHERE guard — the explicit
 *      short-circuit in consumeAiCredit is what makes 0 mean 0).
 *   7. THE 429 CONTRACT (task P3.6 renders this body) — status, `code`,
 *      `stage`, `used`, `limit`, and a positive Retry-After.
 *   8. THE GATE IS WIRED INTO ALL SEVEN ROUTES, not just importable:
 *      (a) STRUCTURALLY, off a manifest of the 7 that is checked against a
 *          filesystem sweep for `consumeAiCredit`, so an 8th quota-wired route
 *          (or a route that silently drops the gate) cannot land unrecorded.
 *          Each is asserted to await the credit, RETURN the shared refusal, and
 *          — the part that matters — to do so AFTER its own auth / validation /
 *          ownership gates. That order is not cosmetic: `consumeAiCredit`
 *          MUTATES, so a credit taken before a 400/404 bills a crew member for
 *          a call that never reached Gemini.
 *      (b) BEHAVIOURALLY on the five routes reachable without a DB fixture —
 *          each driven at `CREW_AI_DAILY_LIMIT=0` as a crew viewer and asserted
 *          to answer the shared 429 before any Gemini-touching work. The other
 *          two (`profile/bullets/assist`, `watchlists/[id]/run`) sit behind a
 *          Profile-with-entities / Watchlist row respectively; their gate order
 *          is what (a)'s `mustPrecede` patterns pin.
 *
 * Genuinely hermetic: no network, no PM2, no Gemini, no server. The DB is a
 * THROWAWAY SQLite file in /tmp (DATABASE_URL pinned before any import; tables
 * created with raw DDL mirroring
 * prisma/migrations/20260728053644_add_user_role_and_ai_usage). dev.db /
 * prod.db are never touched, and no AI module beyond lib/ai/quota.ts is loaded.
 * The route drives never reach Gemini: the quota refusal returns first, which
 * is the property being asserted.
 */
const TMP_DB = `/tmp/ai-quota-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${TMP_DB}`;
process.env.EMAIL_ENABLED = "0";
// The route drives below act through the `__seedViewer` seam and must not
// inherit a break-glass escape from the shell the pre-push hook runs in (P5.1.3)
// — one would resolve an OWNER viewer, and the owner is quota-exempt, so every
// 429 assertion would silently become a 200-shaped failure.
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

/**
 * Route handlers' inferred return type carries a phantom `| undefined`
 * (pre-existing codebase-wide TS quirk — untouched routes show it too); at
 * runtime every path returns a NextResponse. Same helper as
 * user-scoping-smoke.ts.
 */
function mustRespond<T>(r: T | undefined, label: string): T {
    if (r === undefined) throw new Error(`${label} returned undefined`);
    return r;
}

const DDL = [
    // Mirrors the migration's redefined User table. The `role` column is NOT
    // NULL, so omitting it here fails every prisma.user.create() with P2022 —
    // this DDL is hand-maintained and does not track prisma/schema.prisma.
    `CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT,
        "email" TEXT,
        "emailVerified" DATETIME,
        "image" TEXT,
        "lastSyncedHistoryId" TEXT,
        "role" TEXT NOT NULL DEFAULT 'crew'
    )`,
    `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
    `CREATE TABLE "AiUsage" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "day" TEXT NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    // The upsert key consumeAiCredit's ON CONFLICT targets. Without it the
    // statement errors ("ON CONFLICT clause does not match any PRIMARY KEY or
    // UNIQUE constraint") and the fail-open branch would silently pass tests.
    `CREATE UNIQUE INDEX "AiUsage_userId_day_key" ON "AiUsage"("userId", "day")`,
];

// ---------------------------------------------------------------------------
// The quota-wired route manifest (docs/multi-user-crew.html §2.9 / P2.5.2).
//
// Seven crew-reachable LLM routes take a credit. The list is asserted against a
// filesystem sweep below, so it cannot drift silently in either direction: a
// new route that calls consumeAiCredit fails until it is recorded here, and a
// route that DROPS the call fails until it is removed.
//
// `mustPrecede` encodes CLAUDE.md's ordering rule per route — "at the TOP of the
// handler, after auth / validation / ownership, before any Gemini-touching
// work". Each pattern is a gate whose source position must come BEFORE the
// credit consume. They are per-route rather than generic because what counts as
// "ownership" differs: a body schema on one route, a watchlist lookup on
// another. The guard call itself is checked separately for every route.
// ---------------------------------------------------------------------------

interface QuotaRouteSpec {
    /** Path under app/api — the file is `app/api/<route>/route.ts`. */
    route: string;
    /** Gates that MUST run before the (mutating) credit consume. */
    mustPrecede: Array<{ pattern: RegExp; why: string }>;
    /** Whether §11 drives this route end-to-end, and if not, why not. */
    drive: "behavioural" | { structuralOnly: string };
}

const QUOTA_ROUTES: QuotaRouteSpec[] = [
    {
        route: "resumes",
        mustPrecede: [
            { pattern: /ResumePostBodySchema\.safeParse/, why: "a 400 on a malformed body must not burn a credit" },
            { pattern: /checkUserRateLimit\(/, why: "never burn a credit on a request the rate limiter is about to reject" },
        ],
        drive: "behavioural",
    },
    {
        route: "resumes/specialize",
        mustPrecede: [
            { pattern: /BodySchema\.safeParse/, why: "a 400 on a malformed body must not burn a credit" },
            { pattern: /checkUserRateLimit\(/, why: "never burn a credit on a request the rate limiter is about to reject" },
        ],
        drive: "behavioural",
    },
    {
        route: "profile/bullets/assist",
        mustPrecede: [
            { pattern: /BulletAssistBodySchema\.safeParse/, why: "a 400 on a malformed body must not burn a credit" },
            { pattern: /checkUserRateLimit\(/, why: "never burn a credit on a request the rate limiter is about to reject" },
            { pattern: /loadParent\(/, why: "the cross-user 404 must come first — a foreign parentId must not cost the caller a credit" },
        ],
        // Reaching the credit needs a Profile with a work-role/project entity
        // carrying a bullet; the gate ORDER is what mustPrecede pins instead.
        drive: { structuralOnly: "needs a Profile + entity + bullet fixture to get past loadParent()" },
    },
    {
        route: "profile/tagline/draft",
        mustPrecede: [
            { pattern: /checkUserRateLimit\(/, why: "never burn a credit on a request the rate limiter is about to reject" },
        ],
        drive: "behavioural",
    },
    {
        route: "profile/import",
        mustPrecede: [
            { pattern: /checkUserRateLimit\(/, why: "never burn a credit on a request the rate limiter is about to reject" },
            { pattern: /req\.formData\(\)/, why: "the four multipart 400s must come first — a malformed upload must not cost a credit" },
        ],
        drive: "behavioural",
    },
    {
        route: "discovery/suggest",
        mustPrecede: [
            { pattern: /RequestSchema\.safeParse/, why: "a 400 on a malformed body must not burn a credit" },
        ],
        drive: "behavioural",
    },
    {
        route: "watchlists/[id]/run",
        mustPrecede: [
            { pattern: /prisma\.watchlist\.findFirst/, why: "the ownership 404 must come first — a foreign watchlist id must not cost a credit" },
        ],
        // Reaching the credit needs a Watchlist row owned by the caller; this
        // file's DDL is deliberately User + AiUsage only.
        drive: { structuralOnly: "needs a Watchlist row to get past the ownership check" },
    },
];

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const API_ROOT = path.join(REPO_ROOT, "app", "api");

function section(title: string) { console.log(`\n── ${title}`); }

/** Every `route.ts` under app/api, as manifest keys (mirrors role-matrix-smoke). */
function discoverRoutes(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) discoverRoutes(p, out);
        else if (entry.name === "route.ts") out.push(path.relative(API_ROOT, path.dirname(p)));
    }
    return out;
}

function readRoute(route: string): string {
    return readFileSync(path.join(API_ROOT, route, "route.ts"), "utf8");
}

/**
 * Strip comments before an ordering scan. Without this, the long design
 * rationale each of these routes carries ABOVE its credit call — several
 * paragraphs naming `consumeAiCredit` in prose — would be found first and the
 * position comparison would read a comment as the call.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Source offset of the first match, or -1. */
function at(src: string, re: RegExp): number {
    const m = re.exec(src);
    return m ? m.index : -1;
}

/**
 * The wiring rule for one quota-gated route, as a pure predicate over its
 * (comment-stripped) source so it can be pointed at synthetic regressions and
 * PROVED to reject them — see the teeth check in §10. Returns null when the
 * route is wired correctly, else how it is not.
 */
function quotaWiringViolation(src: string, spec: QuotaRouteSpec): string | null {
    if (!/import\s*{[^}]*\bconsumeAiCredit\b[^}]*}\s*from\s*['"]@\/lib\/ai\/quota['"]/.test(src)) {
        return "does not import consumeAiCredit from @/lib/ai/quota";
    }
    const guardAt = at(src, /await\s+require(?:Session|Owner)(?:OrService)?\s*\(/);
    const creditAt = at(src, /await\s+consumeAiCredit\s*\(/);
    if (guardAt < 0) return "awaits no auth guard";
    if (creditAt < 0) return "never awaits consumeAiCredit — the gate is not wired in";
    if (creditAt < guardAt) {
        return "consumes a credit BEFORE the auth guard — an unauthenticated caller would move the counter";
    }
    // The refusal must be RETURNED, not merely computed: a `credit.ok` that is
    // ignored is the exact shape of a gate that meters and then admits anyway.
    if (!/if\s*\(\s*!\s*(\w+)\.ok\s*\)\s*return\s+aiQuotaExceededResponse\(\s*\1\s*\)/.test(src)) {
        return "the refusal is not returned (expected `if (!credit.ok) return aiQuotaExceededResponse(credit)`)";
    }
    const late = spec.mustPrecede.filter(g => {
        const gateAt = at(src, g.pattern);
        return gateAt < 0 || gateAt > creditAt;
    });
    if (late.length > 0) {
        return (
            `the credit is consumed before ${late.map(g => String(g.pattern)).join(", ")} — ` +
            late.map(g => g.why).join("; ") +
            ". consumeAiCredit MUTATES, so a rejection after it bills a crew member for a call that never ran."
        );
    }
    return null;
}

async function main() {
    // Dynamic imports: DATABASE_URL must be pinned before lib/prisma loads.
    const { prisma } = await import("@/lib/prisma");
    for (const ddl of DDL) await prisma.$executeRawUnsafe(ddl);

    const {
        consumeAiCredit,
        aiQuotaExceededResponse,
        crewAiDailyLimit,
        DEFAULT_CREW_AI_DAILY_LIMIT,
    } = await import("@/lib/ai/quota");
    const { utcDateBucket } = await import("@/lib/notifications/dispatch");

    const OWNER = "owner-ai-quota-smoke";
    const CREW_A = "crew-a-ai-quota-smoke";
    const CREW_B = "crew-b-ai-quota-smoke";

    const usageFor = (userId: string, day = utcDateBucket()) =>
        prisma.aiUsage.findUnique({ where: { userId_day: { userId, day } }, select: { count: true } });

    try {
        await prisma.user.create({ data: { id: OWNER, email: "owner@ai-quota-smoke.invalid", role: "owner" } });
        await prisma.user.create({ data: { id: CREW_A, email: "crew-a@ai-quota-smoke.invalid", role: "crew" } });
        await prisma.user.create({ data: { id: CREW_B, email: "crew-b@ai-quota-smoke.invalid", role: "crew" } });

        // ── 0. The env-var contract ─────────────────────────────────────────
        delete process.env.CREW_AI_DAILY_LIMIT;
        if (crewAiDailyLimit() !== DEFAULT_CREW_AI_DAILY_LIMIT || DEFAULT_CREW_AI_DAILY_LIMIT !== 20) {
            fail(`unset CREW_AI_DAILY_LIMIT should be the documented default 20`, crewAiDailyLimit());
        } else pass("CREW_AI_DAILY_LIMIT unset → default 20/day");

        process.env.CREW_AI_DAILY_LIMIT = "not-a-number";
        if (crewAiDailyLimit() !== DEFAULT_CREW_AI_DAILY_LIMIT) {
            fail("a malformed CREW_AI_DAILY_LIMIT should fall back to the default", crewAiDailyLimit());
        } else pass("malformed CREW_AI_DAILY_LIMIT → falls back to the default (one warn)");

        // ── 1. Owner is unlimited, and never touches the table ──────────────
        process.env.CREW_AI_DAILY_LIMIT = "3";
        let ownerAllOk = true;
        let ownerLimitInfinite = true;
        for (let i = 0; i < 50; i++) {
            const r = await consumeAiCredit(OWNER, "owner");
            if (!r.ok) ownerAllOk = false;
            if (r.limit !== Number.POSITIVE_INFINITY) ownerLimitInfinite = false;
        }
        const ownerRows = await prisma.aiUsage.count({ where: { userId: OWNER } });
        if (!ownerAllOk) fail("owner was refused a credit (must be exempt)");
        else if (!ownerLimitInfinite) fail("owner's limit should be Infinity");
        else if (ownerRows !== 0) fail(`owner wrote ${ownerRows} AiUsage rows (exempt path must not touch the table)`);
        else pass("owner: 50/50 granted at crew limit 3, limit=Infinity, zero AiUsage rows");

        // ── 2. Crew refused at N+1, and refusals don't inflate `used` ───────
        const LIMIT = 3;
        const granted: number[] = [];
        for (let i = 0; i < LIMIT; i++) {
            const r = await consumeAiCredit(CREW_A, "crew");
            if (!r.ok) fail(`crew call ${i + 1}/${LIMIT} refused inside the allowance`, r);
            granted.push(r.used);
        }
        if (granted.join(",") !== "1,2,3") fail("granted calls should report used 1..N", granted);
        else pass(`crew: first ${LIMIT} calls granted, used counts up 1..${LIMIT}`);

        const overA = await consumeAiCredit(CREW_A, "crew");
        if (overA.ok) fail("crew call N+1 should be refused", overA);
        else if (overA.used !== LIMIT || overA.limit !== LIMIT) {
            fail(`refusal should report { used: ${LIMIT}, limit: ${LIMIT} }`, overA);
        } else pass("crew: call N+1 refused with { ok:false, used:3, limit:3 }");

        for (let i = 0; i < 5; i++) await consumeAiCredit(CREW_A, "crew");
        const afterSpam = await usageFor(CREW_A);
        if (afterSpam?.count !== LIMIT) {
            fail(`refused calls must NOT increment — count is ${afterSpam?.count}, expected ${LIMIT}`);
        } else pass("crew: 5 further refusals leave count pinned at the limit (used <= limit always)");

        // ── 3. Two crew members have independent counters ───────────────────
        const b1 = await consumeAiCredit(CREW_B, "crew");
        const b2 = await consumeAiCredit(CREW_B, "crew");
        const aStillOver = await consumeAiCredit(CREW_A, "crew");
        const aCount = (await usageFor(CREW_A))?.count;
        const bCount = (await usageFor(CREW_B))?.count;
        if (!b1.ok || !b2.ok || b2.used !== 2) {
            fail("crew B should have a fresh allowance while crew A is exhausted", { b1, b2 });
        } else if (aStillOver.ok) {
            fail("crew A must remain refused while crew B spends");
        } else if (aCount !== LIMIT || bCount !== 2) {
            fail(`counters leaked across users (A=${aCount} expected ${LIMIT}, B=${bCount} expected 2)`);
        } else pass("two crew members have fully independent counters");

        // ── 4. The day bucket ───────────────────────────────────────────────
        // (a) the helper itself: rolls at UTC midnight, not local midnight.
        const lastSecond = utcDateBucket(new Date("2026-07-27T23:59:59.999Z"));
        const firstSecond = utcDateBucket(new Date("2026-07-28T00:00:00.000Z"));
        const localEvening = utcDateBucket(new Date("2026-07-28T04:30:00.000Z"));
        if (lastSecond !== "2026-07-27" || firstSecond !== "2026-07-28") {
            fail("utcDateBucket must roll at UTC midnight", { lastSecond, firstSecond });
        } else if (localEvening !== "2026-07-28") {
            fail("utcDateBucket must not shift with a local (UTC-n) evening", localEvening);
        } else pass("utcDateBucket rolls at 00:00 UTC and is DST/locale-independent");

        // (b) the counter: relabel crew A's exhausted row to yesterday's bucket
        // — the exact state the process sees one second after midnight — and
        // assert today starts fresh while yesterday's row survives intact.
        const today = utcDateBucket();
        const yesterday = utcDateBucket(new Date(Date.now() - 24 * 60 * 60 * 1000));
        await prisma.aiUsage.update({
            where: { userId_day: { userId: CREW_A, day: today } },
            data: { day: yesterday },
        });
        const newDay = await consumeAiCredit(CREW_A, "crew");
        const yesterdayRow = await usageFor(CREW_A, yesterday);
        if (!newDay.ok || newDay.used !== 1) {
            fail("a new UTC day must start the crew counter at used=1", newDay);
        } else if (yesterdayRow?.count !== LIMIT) {
            fail(`the previous day's row must survive untouched (got ${yesterdayRow?.count})`);
        } else pass("day rollover: new bucket starts at used=1, prior day's row preserved");

        // ── 5. Concurrency at the boundary ──────────────────────────────────
        // A read-then-write implementation loses updates here and over-grants.
        process.env.CREW_AI_DAILY_LIMIT = "5";
        const CONC_USER = "crew-conc-ai-quota-smoke";
        await prisma.user.create({ data: { id: CONC_USER, email: "conc@ai-quota-smoke.invalid", role: "crew" } });
        const results = await Promise.all(
            Array.from({ length: 9 }, () => consumeAiCredit(CONC_USER, "crew")),
        );
        const okCount = results.filter(r => r.ok).length;
        const usedSeries = results.filter(r => r.ok).map(r => r.used).sort((a, b) => a - b);
        const concRow = await usageFor(CONC_USER);
        if (okCount !== 5) {
            fail(`9 simultaneous consumes at limit 5 must grant exactly 5, granted ${okCount}`, results);
        } else if (usedSeries.join(",") !== "1,2,3,4,5") {
            fail("granted concurrent calls must report distinct used values 1..5", usedSeries);
        } else if (concRow?.count !== 5) {
            fail(`stored count should be exactly 5, got ${concRow?.count}`);
        } else pass("9 simultaneous consumes at limit 5 → exactly 5 grants, used 1..5, count=5 (atomic)");

        // ── 6. CREW_AI_DAILY_LIMIT=0 means zero, not "one free" ─────────────
        process.env.CREW_AI_DAILY_LIMIT = "0";
        const ZERO_USER = "crew-zero-ai-quota-smoke";
        await prisma.user.create({ data: { id: ZERO_USER, email: "zero@ai-quota-smoke.invalid", role: "crew" } });
        const zero = await consumeAiCredit(ZERO_USER, "crew");
        const zeroRows = await prisma.aiUsage.count({ where: { userId: ZERO_USER } });
        const zeroOwner = await consumeAiCredit(OWNER, "owner");
        if (zero.ok || zero.limit !== 0 || zero.used !== 0) {
            fail("limit 0 must refuse the very first crew call", zero);
        } else if (zeroRows !== 0) {
            fail(`limit 0 must not write a row (wrote ${zeroRows})`);
        } else if (!zeroOwner.ok) {
            fail("limit 0 must still leave the owner exempt", zeroOwner);
        } else pass("CREW_AI_DAILY_LIMIT=0 refuses the first crew call without writing; owner unaffected");

        // ── 7. The 429 contract P3.6 renders ────────────────────────────────
        const res = aiQuotaExceededResponse({ ok: false, used: 20, limit: 20 });
        const body = await res.json();
        const retryAfter = Number(res.headers.get("Retry-After"));
        if (res.status !== 429) fail(`quota refusal must be 429, got ${res.status}`);
        else if (body.code !== "AI_QUOTA_EXCEEDED") fail("429 body must carry code=AI_QUOTA_EXCEEDED", body);
        else if (body.stage !== "ai-quota") fail("429 body must carry stage=ai-quota", body);
        else if (body.used !== 20 || body.limit !== 20) fail("429 body must carry { used, limit }", body);
        else if (typeof body.error !== "string" || !body.error.includes("20 of 20")) {
            fail("429 body error prose must state 'N of M'", body);
        } else if (!Number.isFinite(retryAfter) || retryAfter < 1 || retryAfter > 86400) {
            fail(`Retry-After should be seconds until UTC midnight, got ${res.headers.get("Retry-After")}`);
        } else pass("429 contract: { error, code, stage, used, limit } + Retry-After (P3.6's shape)");

        // ── 8. The gate is really WIRED into a route, not just importable ───
        // Drives the REAL POST /api/profile/tagline/draft handler through the
        // __seedViewer seam with the limit at 0, so the quota refusal fires
        // before draftTagline() is ever called — no Gemini, no network. This is
        // the assertion that would catch "lib/ai/quota.ts exists and passes its
        // unit tests but nobody calls it", which is the actual failure mode of
        // a seven-route wiring task.
        const { __seedViewer, __resetViewer } = await import("@/lib/viewer");
        try {
            __seedViewer({ id: CREW_A, email: "crew-a@ai-quota-smoke.invalid", role: "crew" });
            const route = await import("@/app/api/profile/tagline/draft/route");
            const routeRes = mustRespond(
                await route.POST(
                    new Request("http://localhost/api/profile/tagline/draft", { method: "POST" }) as never,
                ),
                "tagline/draft POST",
            );
            const routeBody = await routeRes.json();
            if (routeRes.status !== 429) {
                fail(`crew over quota should get 429 from the route, got ${routeRes.status}`, routeBody);
            } else if (routeBody.code !== "AI_QUOTA_EXCEEDED" || routeBody.limit !== 0) {
                fail("route 429 must carry the shared quota contract body", routeBody);
            } else pass("POST /api/profile/tagline/draft: crew over quota → 429 AI_QUOTA_EXCEEDED (wired)");
        } finally {
            __resetViewer();
        }

        // ── 9. Cascade — deleting a user reaps their counters ───────────────
        await prisma.user.delete({ where: { id: CREW_B } });
        const orphans = await prisma.aiUsage.count({ where: { userId: CREW_B } });
        if (orphans !== 0) fail(`AiUsage rows survived their user (${orphans} orphans)`);
        else pass("AiUsage cascades on user delete (no orphaned counters)");

        // ── 10. …and into ALL SEVEN of them, structurally ───────────────────
        // §8 proves ONE route is wired. That is the assertion that catches "the
        // module exists and nobody calls it" — but it says nothing about the
        // other six, and a seven-route wiring task fails route-by-route, not
        // all-or-nothing. This check closes that: the manifest is reconciled
        // against the filesystem (so it cannot go stale in either direction) and
        // each route is asserted to await the credit, RETURN the shared refusal,
        // and do both AFTER its own auth / validation / ownership gates.
        section("10. All 7 quota-wired routes — manifest ⇄ filesystem, and the gate order in each");

        const declared = new Set(QUOTA_ROUTES.map(r => r.route));
        const onDisk = discoverRoutes(API_ROOT)
            .filter(r => /\bconsumeAiCredit\s*\(/.test(stripComments(readRoute(r))))
            .sort();
        const undeclared = onDisk.filter(r => !declared.has(r));
        const missing = QUOTA_ROUTES.map(r => r.route).filter(r => !onDisk.includes(r));

        if (undeclared.length > 0) {
            fail(
                `quota-wired route(s) not in QUOTA_ROUTES: ${undeclared.join(", ")}. ` +
                `Add an entry (with its mustPrecede gates) so the ordering rule is asserted for it too.`,
            );
        } else if (missing.length > 0) {
            fail(
                `QUOTA_ROUTES declares ${missing.join(", ")} but the file no longer calls consumeAiCredit. ` +
                `Either the gate was dropped (a crew member can now spend unmetered on that route) or the ` +
                `route moved — reconcile the manifest with §2.9's list.`,
            );
        } else if (QUOTA_ROUTES.length !== 7) {
            fail(`§2.9 wires SEVEN routes; the manifest holds ${QUOTA_ROUTES.length}`);
        } else {
            pass(`all 7 quota-wired routes accounted for, and no 8th exists on disk: ${onDisk.join(", ")}`);
        }

        for (const spec of QUOTA_ROUTES) {
            const violation = quotaWiringViolation(stripComments(readRoute(spec.route)), spec);
            if (violation) {
                fail(`/api/${spec.route}: ${violation}`);
                continue;
            }
            const how = spec.drive === "behavioural" ? "driven" : `structural-only (${spec.drive.structuralOnly})`;
            pass(`/api/${spec.route}: guard → ${spec.mustPrecede.length} gate(s) → consumeAiCredit → returned refusal · ${how}`);
        }

        // Teeth. A structural check that has never been shown to reject
        // anything is a check nobody has proved CAN reject. Each mutation below
        // is a real regression shape, applied to a synthetic handler rather than
        // to a production file, and each must be caught.
        const SPEC: QuotaRouteSpec = {
            route: "synthetic",
            mustPrecede: [{ pattern: /BodySchema\.safeParse/, why: "a 400 must not burn a credit" }],
            drive: { structuralOnly: "synthetic" },
        };
        const GOOD = `
            import { consumeAiCredit, aiQuotaExceededResponse } from "@/lib/ai/quota";
            export async function POST(req) {
                const guard = await requireSession();
                if ('error' in guard) return guard.error;
                const parsed = BodySchema.safeParse(await req.json());
                if (!parsed.success) return NextResponse.json({}, { status: 400 });
                const credit = await consumeAiCredit(userId, guard.session.user.role);
                if (!credit.ok) return aiQuotaExceededResponse(credit);
            }`;
        const MUTANTS: Array<[string, string]> = [
            ["credit taken before the guard", GOOD.replace(/const guard = await requireSession\(\);/, "const credit0 = await consumeAiCredit(userId, 'crew');\n const guard = await requireSession();")],
            ["credit taken before validation", GOOD.replace(/const parsed = BodySchema\.safeParse\(await req\.json\(\)\);/, "").replace("}\n            }", "const parsed = BodySchema.safeParse(await req.json());\n}")],
            ["refusal computed but not returned", GOOD.replace("if (!credit.ok) return aiQuotaExceededResponse(credit);", "if (!credit.ok) console.warn(aiQuotaExceededResponse(credit));")],
            ["gate removed entirely", GOOD.replace(/const credit = await consumeAiCredit[^\n]*\n/, "")],
        ];
        if (quotaWiringViolation(GOOD, SPEC) !== null) {
            fail("the structural check rejects a CORRECTLY wired handler — it would fail on any refactor", quotaWiringViolation(GOOD, SPEC));
        } else {
            const missed = MUTANTS.filter(([, src]) => quotaWiringViolation(src, SPEC) === null).map(([name]) => name);
            if (missed.length > 0) fail(`the structural check has no teeth against: ${missed.join("; ")}`);
            else pass(`structural check has teeth: accepts the correct shape, rejects all ${MUTANTS.length} regression shapes`);
        }

        // ── 11. …and behaviourally on the routes reachable without a fixture ─
        // Each is driven for real at CREW_AI_DAILY_LIMIT=0 as a crew viewer. The
        // 429 has to come out of the handler itself, before the Gemini call the
        // route exists to make — which is why these are safe to run in the
        // pre-push gate at all.
        section("11. Behavioural — crew at limit 0 gets the shared 429 from each reachable route");

        const ROUTE_USER = "crew-route-drive-ai-quota-smoke";
        await prisma.user.create({ data: { id: ROUTE_USER, email: "route-drive@ai-quota-smoke.invalid", role: "crew" } });
        process.env.CREW_AI_DAILY_LIMIT = "0";

        // A tiny plain-text "resume" — profile/import rejects an empty parts
        // list with a 400 before the credit, so the file has to be real.
        const uploadForm = new FormData();
        uploadForm.append("files", new File(["Jane Doe — Security Officer"], "resume.txt", { type: "text/plain" }));

        const jsonPost = (route: string, payload: unknown) =>
            new Request(`http://ai-quota-smoke.invalid/api/${route}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });

        const DRIVES: Array<{ route: string; req: () => Request }> = [
            // A `posting.text` body is the Gemini-touching branch — the verbatim
            // canon re-render deliberately does NOT pay a credit (see the route).
            { route: "resumes", req: () => jsonPost("resumes", { posting: { text: "Security Officer — patrol, access control, incident reports." } }) },
            // Ids only have to be cuid-SHAPED: the credit is taken before the
            // canon/application lookups, which is the ordering being proved.
            { route: "resumes/specialize", req: () => jsonPost("resumes/specialize", { canonId: "clh0000000000000000000000", applicationId: "clh1111111111111111111111" }) },
            { route: "discovery/suggest", req: () => jsonPost("discovery/suggest", { topic: "ai" }) },
            {
                route: "profile/import",
                req: () => new Request("http://ai-quota-smoke.invalid/api/profile/import", { method: "POST", body: uploadForm }),
            },
        ];

        try {
            __seedViewer({ id: ROUTE_USER, email: "route-drive@ai-quota-smoke.invalid", role: "crew" });
            for (const d of DRIVES) {
                const mod = await import(`@/app/api/${d.route}/route`);
                const r = mustRespond(await mod.POST(d.req() as never), `${d.route} POST`);
                const b = await r.json();
                if (r.status !== 429) {
                    fail(`POST /api/${d.route}: crew at limit 0 should get 429, got ${r.status}`, b);
                } else if (b.code !== "AI_QUOTA_EXCEEDED" || b.stage !== "ai-quota") {
                    fail(`POST /api/${d.route}: 429 must carry the SHARED quota body, not the route's own rate-limit 429`, b);
                } else if (b.limit !== 0 || b.used !== 0) {
                    fail(`POST /api/${d.route}: 429 body should report { used: 0, limit: 0 }`, b);
                } else {
                    pass(`POST /api/${d.route}: crew over quota → 429 AI_QUOTA_EXCEEDED (wired, no Gemini reached)`);
                }
            }
        } finally {
            __resetViewer();
        }

        // limit 0 short-circuits before the upsert (§6), so five refused route
        // calls must leave the counter table untouched for this user.
        const driveRows = await prisma.aiUsage.count({ where: { userId: ROUTE_USER } });
        if (driveRows !== 0) fail(`the refused route drives wrote ${driveRows} AiUsage row(s) at limit 0`);
        else pass("the refused route drives wrote no AiUsage rows (limit 0 short-circuits before the upsert)");

        // Manifest ⇄ drives: every route the manifest calls `behavioural` is
        // actually driven — here, or (for tagline/draft) in §8 above.
        const drivenHere = new Set(DRIVES.map(d => d.route));
        drivenHere.add("profile/tagline/draft"); // §8
        const claimed = QUOTA_ROUTES.filter(r => r.drive === "behavioural").map(r => r.route);
        const unproven = claimed.filter(r => !drivenHere.has(r));
        if (unproven.length > 0) {
            fail(`QUOTA_ROUTES marks ${unproven.join(", ")} as behaviourally covered, but no drive exists for it`);
        } else {
            pass(`${claimed.length} of 7 routes are covered behaviourally; the other 2 are structural-only by declaration`);
        }
    } finally {
        delete process.env.CREW_AI_DAILY_LIMIT;
        try { await prisma.$disconnect(); } catch { /* best-effort */ }
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            try { unlinkSync(TMP_DB + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
