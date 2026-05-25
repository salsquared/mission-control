/**
 * Hermetic smoke for M8.4.3 (story S8.11) — GET /api/resumes returns the
 * enriched projection (postingTitle / postingCompany), ordered createdAt desc,
 * cross-user-isolated, with a `?limit=` clamp.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/resume-list-smoke.ts
 *
 * Uses the same `require.cache` session-stub pattern as resume-from-application-smoke
 * to forge a session for the route's `requireSession()` guard.
 *
 *   - 3 GeneratedResume rows for the test user with staggered createdAt; one
 *     row has null postingTitle/postingCompany (simulating a legacy pre-M8.4.2
 *     row).
 *   - 1 GeneratedResume row for a second user (must not leak across users).
 *
 * No HTTP, no PM2. Cleanup in finally.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

let mockSessionUser: { id: string; email: string } | null = null;

const cache = (require as unknown as { cache: Record<string, unknown> }).cache;

function injectCacheEntry(specifier: string, exports: Record<string, unknown>): void {
    const resolved = require.resolve(specifier);
    cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        children: [],
        paths: [],
        exports,
    };
}

injectCacheEntry("next-auth/next", {
    getServerSession: async () => {
        if (!mockSessionUser) return null;
        return { user: { id: mockSessionUser.id, email: mockSessionUser.email } };
    },
    default: () => undefined,
    unstable_getServerSession: async () => null,
});

const prisma = new PrismaClient();
const tag = randomBytes(4).toString("hex");
const userId = `rl-smoke-user-${tag}`;
const otherUserId = `rl-smoke-other-${tag}`;
const resumeIds: string[] = [];
// Hoisted so the finally block can clean up Test 4's fixtures even if an
// assertion throws between create and the bottom-of-test deletes.
let test4WatchlistId: string | null = null;
let test4PostingId: string | null = null;
let test4ApplicationId: string | null = null;

async function main() {
    try {
        await prisma.user.create({ data: { id: userId, email: `rl-smoke-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `rl-smoke-other-${tag}@example.invalid` } });

        // Three rows for our user with explicit createdAt so the ordering
        // assertion is deterministic. The middle row is null on both metadata
        // columns — mirrors a pre-M8.4.2 row carried forward by the migration.
        const t0 = new Date("2026-03-01T00:00:00Z");
        const t1 = new Date("2026-04-01T00:00:00Z");
        const t2 = new Date("2026-05-01T00:00:00Z");

        const r0 = await prisma.generatedResume.create({
            data: {
                userId,
                createdAt: t0,
                postingInput: JSON.stringify({ url: "https://example.invalid/jobs/0" }),
                profileSnapshot: "{}",
                selections: "[]",
                templateKey: "ats-plain",
                format: "pdf",
                status: "ready",
                postingTitle: "Senior Engineer",
                postingCompany: "Acme",
            },
        });
        resumeIds.push(r0.id);

        const r1 = await prisma.generatedResume.create({
            data: {
                userId,
                createdAt: t1,
                postingInput: JSON.stringify({ url: "https://example.invalid/jobs/1" }),
                profileSnapshot: "{}",
                selections: "[]",
                templateKey: "ats-plain",
                format: "pdf",
                status: "ready",
                postingTitle: null,
                postingCompany: null,
            },
        });
        resumeIds.push(r1.id);

        const r2 = await prisma.generatedResume.create({
            data: {
                userId,
                createdAt: t2,
                postingInput: JSON.stringify({ url: "https://example.invalid/jobs/2" }),
                profileSnapshot: "{}",
                selections: "[]",
                templateKey: "ats-plain",
                format: "docx",
                status: "ready",
                postingTitle: "Staff Engineer",
                postingCompany: "Globex",
            },
        });
        resumeIds.push(r2.id);

        const rOther = await prisma.generatedResume.create({
            data: {
                userId: otherUserId,
                createdAt: t2,
                postingInput: JSON.stringify({ url: "https://example.invalid/other" }),
                profileSnapshot: "{}",
                selections: "[]",
                templateKey: "ats-plain",
                format: "pdf",
                status: "ready",
                postingTitle: "Leaked",
                postingCompany: "ShouldNotAppear",
            },
        });
        resumeIds.push(rOther.id);

        // Now hit the route's GET handler with a forged session for `userId`.
        mockSessionUser = { id: userId, email: `rl-smoke-${tag}@example.invalid` };
        const routeModule = require("@/app/api/resumes/route");

        // ── Test 1: default GET returns rows for the session user only ───────
        {
            const req = { url: "http://localhost/api/resumes" } as unknown as Parameters<typeof routeModule.GET>[0];
            const resp = await routeModule.GET(req);
            if (resp.status !== 200) { fail(`default GET status ${resp.status}`); return; }
            const body = await resp.json();
            if (!Array.isArray(body.resumes)) { fail("default GET body.resumes not array", body); return; }

            const ours = body.resumes.filter((r: { id: string }) => resumeIds.includes(r.id));
            if (ours.length !== 3) fail(`default GET: should have exactly 3 of our rows, got ${ours.length}`, ours.map((r: { id: string }) => r.id));
            else pass("default GET: returns 3 rows owned by the session user");

            if (body.resumes.some((r: { userId: string }) => r.userId === otherUserId)) {
                fail("cross-user leak: other-user row present in body.resumes", body.resumes.filter((r: { userId: string }) => r.userId === otherUserId));
            } else pass("cross-user isolation: other-user row absent");

            // Ordering: createdAt desc — the user's rows in `ours` should be t2, t1, t0.
            const orderOk = ours[0].createdAt > ours[1].createdAt && ours[1].createdAt > ours[2].createdAt;
            if (!orderOk) fail("ordering: rows not in createdAt desc", ours.map((r: { id: string; createdAt: string }) => ({ id: r.id, createdAt: r.createdAt })));
            else pass("ordering: rows sorted createdAt desc");

            // Posting metadata pass-through for the populated rows + null for the legacy row.
            const r2Row = ours.find((r: { id: string }) => r.id === r2.id);
            if (r2Row?.postingTitle !== "Staff Engineer" || r2Row?.postingCompany !== "Globex") fail("posting metadata: r2 not surfaced", r2Row);
            else pass("posting metadata: title + company surfaced when populated");

            const r1Row = ours.find((r: { id: string }) => r.id === r1.id);
            if (r1Row?.postingTitle !== null || r1Row?.postingCompany !== null) fail("legacy row: postingTitle/Company should be null", r1Row);
            else pass("legacy row: null postingTitle/Company surfaced as null");

            // Shape check: includes hasArtifact (derived), excludes the raw postingInput / profileSnapshot.
            if (!("hasArtifact" in r2Row)) fail("shape: hasArtifact missing", r2Row);
            else pass("shape: hasArtifact present");
            if ("postingInput" in r2Row || "profileSnapshot" in r2Row || "selections" in r2Row) {
                fail("shape: raw JSON columns leaked into projection", r2Row);
            } else pass("shape: raw JSON columns NOT leaked (projection is enrichment-only)");
        }

        // ── Test 2: ?limit=2 clamps to most recent 2 of our 3 rows ───────────
        {
            const req = { url: "http://localhost/api/resumes?limit=2" } as unknown as Parameters<typeof routeModule.GET>[0];
            const resp = await routeModule.GET(req);
            const body = await resp.json();
            const ours = body.resumes.filter((r: { id: string }) => resumeIds.includes(r.id));
            if (ours.length !== 2) fail(`limit=2: should return 2 rows of ours, got ${ours.length}`, ours);
            else pass("limit=2: caps to 2 rows");
            if (ours[0]?.id !== r2.id || ours[1]?.id !== r1.id) fail("limit=2: should be the 2 most recent (r2, r1)", ours.map((r: { id: string }) => r.id));
            else pass("limit=2: returns the 2 most recent rows (createdAt desc honored)");
        }

        // ── Test 3: malformed ?limit fallback ────────────────────────────────
        {
            const req = { url: "http://localhost/api/resumes?limit=not-a-number" } as unknown as Parameters<typeof routeModule.GET>[0];
            const resp = await routeModule.GET(req);
            if (resp.status !== 200) fail(`malformed limit: should 200 with default, got ${resp.status}`);
            else pass("malformed limit: 200 fallback (does not 400 a stale link)");
        }

        // ── Test 4: ?applicationId filter ────────────────────────────────────
        {
            // Fixtures hoisted into module state so the finally block can
            // clean them up even if an assertion throws mid-test.
            const watchlist = await prisma.watchlist.create({
                data: {
                    userId, name: `rl-smoke-wl-${tag}`, kind: "careers-page",
                    config: JSON.stringify({ kind: "careers-page", rootUrl: "https://example.invalid/", linkPattern: "/jobs/", companyName: "Acme" }),
                    scheduleMinutes: 60,
                },
            });
            test4WatchlistId = watchlist.id;
            const posting = await prisma.jobPosting.create({
                data: {
                    watchlistId: watchlist.id, externalId: `ext-${tag}`,
                    company: "Acme", title: "Senior Engineer",
                    sourceUrl: "https://example.invalid/jobs/0", status: "tracked",
                    raw: "{}",
                },
            });
            test4PostingId = posting.id;
            const app = await prisma.application.create({
                data: {
                    userId, company: "Acme", normalizedCompany: `acme-${tag}`,
                    status: "INTERESTED", role: "Senior Engineer", postingId: posting.id,
                    track: "career", kind: "job",
                },
            });
            test4ApplicationId = app.id;
            await prisma.generatedResume.update({ where: { id: r2.id }, data: { applicationId: app.id } });

            const req = { url: `http://localhost/api/resumes?applicationId=${app.id}` } as unknown as Parameters<typeof routeModule.GET>[0];
            const resp = await routeModule.GET(req);
            const body = await resp.json();
            if (body.resumes.length !== 1) fail(`applicationId filter: expected 1, got ${body.resumes.length}`, body.resumes.map((r: { id: string }) => r.id));
            else pass("applicationId filter: returns only the row linked to that Application");
            if (body.resumes[0]?.id !== r2.id) fail("applicationId filter: wrong row", body.resumes[0]);
            else pass("applicationId filter: returns the correct row");
        }
    } finally {
        // Tear down in FK-aware order: GeneratedResume → Application → JobPosting
        // → Watchlist → User. Each step is .catch'd so a single failure doesn't
        // block the rest, but ordering minimizes the cleanup churn.
        for (const id of resumeIds) {
            await prisma.generatedResume.delete({ where: { id } }).catch(() => {});
        }
        if (test4ApplicationId) {
            await prisma.application.delete({ where: { id: test4ApplicationId } }).catch(() => {});
        }
        if (test4PostingId) {
            await prisma.jobPosting.delete({ where: { id: test4PostingId } }).catch(() => {});
        }
        if (test4WatchlistId) {
            await prisma.watchlist.delete({ where: { id: test4WatchlistId } }).catch(() => {});
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
        await prisma.$disconnect();
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
