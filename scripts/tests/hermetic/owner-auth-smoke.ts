/**
 * Hermetic smoke for owner resolution + the guard return shapes
 * (docs/multi-user-crew.html §2.3–§2.4, tasks P1.3.1 / P1.3.3 / P1.4.3-C).
 *
 *   npx tsx scripts/tests/hermetic/owner-auth-smoke.ts
 *
 * WHAT THIS FILE STOPPED TESTING, AND WHY. Until P1.3.3 `resolveOwner()` had two
 * resolution branches — an owner-email env pin resolved by `findUnique`, and a
 * `findFirst({ orderBy: { id: 'asc' } })` sole-row fallback. Both are DELETED:
 * ownership is now the stored fact `User.role = 'owner'`, written by the
 * migration that added the column, and the resolver is one
 * `findFirst({ where: { role: 'owner' } })`. So the three cases that pinned that
 * behaviour (the pin, the set-but-unmatched pin, the sole-row fallback) are
 * RETIRED rather than repointed — they described a branch that no longer exists.
 *
 * What is NOT dropped is the security property those cases bought (the
 * 2026-06-24 audit): a lookup that finds nothing returns null and NEVER falls
 * through to a stray row. Cases 1 and 1b below re-anchor it on the column, where
 * it matters more than it did on the env var — with crew rows in the table, the
 * retired sole-row heuristic would have resolved to whichever cuid sorted first,
 * i.e. potentially a crew member.
 *
 * Asserts:
 *   1.  role='owner' resolves REGARDLESS of cuid order (a crew row sorting first
 *       must not win) and queries on the column, not on order.
 *   1b. Zero role='owner' rows → null, never a fall-through to a crew row, and
 *       no second query looking for a substitute.
 *   2.  0-users → null (no throw).
 *   3.  Memo hit skips the DB (a second call doesn't re-query the stub).
 *   4.  Memo re-resolves after a null result (a promotion takes without a restart).
 *   5.  requireSession() → { session: { user: { id, email, role } } }.
 *   7.  requireSessionOrService() service-token branch still works (byte-for-byte).
 *   8.  requireSessionOrService() session branch → { userId }.
 *   9.  requireOwner() → { session } for an owner, 403 for a crew viewer.
 *   10. requireOwnerOrService() → { userId } for an owner, 403 for crew, and the
 *       Bearer branch is untouched by the role check.
 *   11. With NO viewer seeded, every guard denies — the guards have no identity
 *       fallback left, so an out-of-request-scope call is 401, not the owner.
 *
 * Genuinely hermetic + deterministic: NO network, NO PM2, and it NEVER reads or
 * mutates dev.db / prod.db. `resolveOwner()` takes an injectable `client` stub
 * for the resolution tests; the guards resolve through `lib/viewer.ts`, so the
 * guard tests drive them with the `__seedViewer` seam — which short-circuits
 * before any header read or DB access, so prisma is never touched.
 */

// Pin a throwaway DATABASE_URL purely so that if some transitive import loads
// lib/prisma it points at a non-existent file rather than dev.db. The seeded
// viewer means no query ever runs, but this is belt-and-suspenders against the
// "phantom prisma/prisma/dev.db" footgun.
process.env.DATABASE_URL = `file:/tmp/owner-auth-smoke-${process.pid}.db`;
// Case 11 asserts the STRICT deny path; the pre-push hook may run in a shell
// that has a break-glass escape armed (P5.1.3).
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

import {
    resolveOwner,
    __resetOwnerMemo,
    type OwnerResolverClient,
} from "@/lib/owner";
import { __seedViewer, __resetViewer, type Viewer } from "@/lib/viewer";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

type Row = { id: string; email: string | null; role: string };

/**
 * The HTTP status a guard denied with, or null when it admitted. The guards'
 * `{ session } | { error }` unions are `as const` on each arm, so `"error" in
 * guard` narrows the presence but not the optionality — reading it structurally
 * keeps the assertions readable without a cast per call site.
 */
function denyStatusOf(guard: unknown): number | null {
    const err = (guard as { error?: { status?: number } }).error;
    return typeof err?.status === "number" ? err.status : null;
}

/**
 * Deterministic in-memory stand-in for PrismaClient's `user` delegate. Counts
 * calls so we can prove the memo skips the DB, and records the `where` so case 1
 * can assert the resolver filters on the ROLE COLUMN rather than on row order.
 *
 * Rows are scanned in cuid order — the worst case for the retired
 * `orderBy: { id: 'asc' }` heuristic, and therefore the case that makes case 1
 * meaningful.
 */
function makeStubClient(rows: Row[]) {
    const calls = { findFirst: 0 };
    const seenWhere: Array<{ role: string }> = [];
    const client: OwnerResolverClient = {
        user: {
            async findFirst({ where }) {
                calls.findFirst++;
                seenWhere.push(where);
                const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
                const hit = sorted.find((r) => r.role === where.role);
                return hit ? { id: hit.id, email: hit.email } : null;
            },
        },
    };
    return { client, calls, seenWhere };
}

async function main() {
    // ── 1. role='owner' wins regardless of cuid order ───────────────────────
    // The crew row's id sorts FIRST. The retired heuristic would have returned
    // it; the column-based resolver must return the owner.
    __resetOwnerMemo();
    {
        const { client, calls, seenWhere } = makeStubClient([
            { id: "a-crew-sorts-first", email: "crew@owner-auth-smoke.invalid", role: "crew" },
            { id: "z-owner-sorts-last", email: "owner@owner-auth-smoke.invalid", role: "owner" },
        ]);
        const owner = await resolveOwner(client);
        if (owner?.id !== "z-owner-sorts-last" || owner.email !== "owner@owner-auth-smoke.invalid") {
            fail("role='owner' must win even when a crew row sorts first by cuid", owner);
        } else if (calls.findFirst !== 1) {
            fail("resolveOwner should issue exactly one query", calls);
        } else if (seenWhere[0]?.role !== "owner") {
            fail("resolveOwner must filter on role='owner', not on row order", seenWhere);
        } else {
            pass("role='owner' resolves regardless of cuid order (filters on the column)");
        }
    }

    // ── 1b. Zero owners → null, never a fall-through to a crew row ──────────
    // The authoritative-miss property the 2026-06-24 audit bought, re-anchored
    // from the retired env pin onto User.role. Zero owners also means the migration's
    // backfill never ran — the owner is locked out, and that must be visible as
    // null rather than silently papered over with somebody else's row.
    __resetOwnerMemo();
    {
        const { client, calls } = makeStubClient([
            { id: "a-crew-one", email: "crew1@owner-auth-smoke.invalid", role: "crew" },
            { id: "b-crew-two", email: "crew2@owner-auth-smoke.invalid", role: "crew" },
        ]);
        const owner = await resolveOwner(client);
        if (owner !== null) {
            fail("zero role='owner' rows must return null, never a crew row", { owner, calls });
        } else if (calls.findFirst !== 1) {
            fail("a miss must NOT issue a second query looking for a substitute row", calls);
        } else {
            pass("zero role='owner' rows → null (authoritative miss, no crew fall-through)");
        }
    }

    // ── 1c. An owner row with a null email is not a usable owner ────────────
    __resetOwnerMemo();
    {
        const { client } = makeStubClient([{ id: "u-nullmail", email: null, role: "owner" }]);
        const owner = await resolveOwner(client);
        if (owner !== null) fail("an owner row with a null email is not a usable owner", owner);
        else pass("role='owner' row with a NULL email → null (not a half-populated owner)");
    }

    // ── 2. 0-users → null, no throw ─────────────────────────────────────────
    __resetOwnerMemo();
    {
        const { client } = makeStubClient([]);
        let threw = false;
        let result: unknown = "unset";
        try { result = await resolveOwner(client); } catch (e) { threw = true; result = e; }
        if (threw) fail("0-users resolveOwner must NOT throw", result);
        else if (result !== null) fail("0-users resolveOwner should return null", result);
        else pass("0 users → resolveOwner returns null (no throw)");
    }

    // ── 3. Memo hit skips the DB ────────────────────────────────────────────
    __resetOwnerMemo();
    {
        const { client, calls } = makeStubClient([{ id: "u-memo", email: "memo@owner-auth-smoke.invalid", role: "owner" }]);
        await resolveOwner(client);            // cold — one findFirst
        const before = calls.findFirst;
        const second = await resolveOwner(client); // warm — memo hit
        if (second?.id !== "u-memo") fail("memo hit should return the cached owner", second);
        else if (calls.findFirst !== before) fail("memo hit must NOT re-query the DB", calls);
        else pass("memo hit returns cached owner without re-querying the DB");
    }

    // ── 4. Memo re-resolves after null (a promotion takes without a restart) ─
    __resetOwnerMemo();
    {
        const rows: Row[] = [{ id: "u-late", email: "late@owner-auth-smoke.invalid", role: "crew" }];
        const { client, calls } = makeStubClient(rows);
        const first = await resolveOwner(client);
        if (first !== null) fail("expected null while nobody holds role='owner'", first);
        // The migration's backfill runs (or the owner is promoted) after boot.
        rows[0].role = "owner";
        const second = await resolveOwner(client);
        if (second?.id !== "u-late") {
            fail("after a null result, resolveOwner must re-resolve (not cache null)", { second, calls });
        } else {
            pass("null result is NOT cached — a later promotion takes without a restart");
        }
    }
    __resetOwnerMemo();

    // ════════════════════════════════════════════════════════════════════════
    // Guards. Since P1.3.2 they resolve through `lib/viewer.ts:resolveViewer()`,
    // NOT `resolveOwner()` — so they are driven with the `__seedViewer` seam. A
    // seeded viewer short-circuits before any header read or DB access, which is
    // what keeps this file DB-free.
    // ════════════════════════════════════════════════════════════════════════
    const OWNER: Viewer = { id: "u-guard", email: "guard@owner-auth-smoke.invalid", role: "owner" };
    const CREW: Viewer = { id: "u-crew-guard", email: "crew-guard@owner-auth-smoke.invalid", role: "crew" };
    const {
        requireSession,
        requireOwner,
        requireOwnerOrService,
        requireSessionOrService,
    } = await import("@/lib/auth-guards");

    process.env.SERVICE_TOKEN_PULSAR = "test-token-owner-auth-smoke";
    process.env.SERVICE_TOKEN_PULSAR_USER_ID = "pulsar-user-123";
    const SERVICE_CONFIG = { tokenEnv: "SERVICE_TOKEN_PULSAR", userIdEnv: "SERVICE_TOKEN_PULSAR_USER_ID" };

    try {
        __seedViewer(OWNER);

        // ── 5. requireSession() ─────────────────────────────────────────────
        {
            const guard = await requireSession();
            if ("error" in guard) {
                fail("requireSession should synthesize a session for the seeded viewer", guard);
            } else if (guard.session.user.id !== OWNER.id || guard.session.user.email !== OWNER.email) {
                fail("requireSession session must carry both id and email", guard.session);
            } else if (guard.session.user.role !== "owner") {
                fail("requireSession session must carry the viewer's role (additive, P1.3.2)", guard.session);
            } else {
                pass("requireSession() → { session: { user: { id, email, role } } }");
            }
        }

        // ── 7. requireSessionOrService service-token branch (unchanged) ─────
        {
            const req = new Request("https://mc.salsquared.xyz/api/calendar/event?onBehalfOf=pulsar-user-123", {
                headers: { authorization: "Bearer test-token-owner-auth-smoke" },
            });
            const guard = await requireSessionOrService(req, SERVICE_CONFIG);
            if ("error" in guard) {
                fail("valid service token should be accepted", guard);
            } else if (guard.userId !== "pulsar-user-123") {
                fail("service-token branch should return the configured user id", guard);
            } else {
                pass("requireSessionOrService() service-token branch → { userId } (byte-for-byte intact)");
            }

            // A bad token still 401s — proves the branch wasn't gutted.
            const badReq = new Request("https://mc.salsquared.xyz/api/calendar/event?onBehalfOf=pulsar-user-123", {
                headers: { authorization: "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxx" },
            });
            const badGuard = await requireSessionOrService(badReq, SERVICE_CONFIG);
            if (!("error" in badGuard)) fail("invalid service token must be rejected", badGuard);
            else pass("requireSessionOrService() rejects an invalid service token");
        }

        // ── 8. requireSessionOrService session branch → { userId } ──────────
        {
            const req = new Request("https://mc.salsquared.xyz/api/calendar/event"); // no Bearer
            const guard = await requireSessionOrService(req, SERVICE_CONFIG);
            if ("error" in guard) {
                fail("session branch should resolve to the seeded viewer", guard);
            } else if (guard.userId !== OWNER.id) {
                fail("session branch should return { userId: viewerId }", guard);
            } else {
                pass("requireSessionOrService() session branch → { userId }");
            }
        }

        // ── 9. requireOwner() — { session } for owner, 403 for crew ─────────
        {
            const guard = await requireOwner();
            if ("error" in guard) {
                fail("requireOwner should admit a role='owner' viewer", guard);
            } else if (guard.session.user.id !== OWNER.id || guard.session.user.role !== "owner") {
                fail("requireOwner must mirror requireSession's { session } shape", guard.session);
            } else {
                pass("requireOwner() → { session } for the owner (same shape as requireSession)");
            }

            __seedViewer(CREW);
            const crewGuard = await requireOwner();
            const crewStatus = denyStatusOf(crewGuard);
            if (!("error" in crewGuard)) {
                fail("requireOwner must REJECT a crew viewer", crewGuard);
            } else if (crewStatus !== 403) {
                fail(`crew on an owner-only route must be 403, got ${crewStatus}`, crewStatus);
            } else {
                pass("requireOwner() → 403 for a crew viewer (authenticated, not permitted — never 401)");
            }
            __seedViewer(OWNER);
        }

        // ── 10. requireOwnerOrService() — { userId }, and Bearer untouched ──
        {
            const req = new Request("https://mc.salsquared.xyz/api/calendar/event"); // no Bearer
            const guard = await requireOwnerOrService(req, SERVICE_CONFIG);
            if ("error" in guard) {
                fail("requireOwnerOrService should admit the owner on the session branch", guard);
            } else if (guard.userId !== OWNER.id) {
                fail("requireOwnerOrService must return { userId }, NOT { session }", guard);
            } else {
                pass("requireOwnerOrService() session branch → { userId } (mirrors requireSessionOrService)");
            }

            __seedViewer(CREW);
            const crewGuard = await requireOwnerOrService(req, SERVICE_CONFIG);
            if (!("error" in crewGuard) || denyStatusOf(crewGuard) !== 403) {
                fail("requireOwnerOrService must 403 a crew viewer on the session branch", crewGuard);
            } else {
                pass("requireOwnerOrService() → 403 for a crew viewer on the session branch");
            }

            // Pulsar is not a viewer and has no role: the Bearer branch must be
            // unaffected by the owner check, even with a crew viewer seeded.
            const serviceReq = new Request("https://mc.salsquared.xyz/api/calendar/event?onBehalfOf=pulsar-user-123", {
                headers: { authorization: "Bearer test-token-owner-auth-smoke" },
            });
            const serviceGuard = await requireOwnerOrService(serviceReq, SERVICE_CONFIG);
            if ("error" in serviceGuard || serviceGuard.userId !== "pulsar-user-123") {
                fail("requireOwnerOrService's Bearer branch must be byte-for-byte the service-token flow", serviceGuard);
            } else {
                pass("requireOwnerOrService() Bearer branch → { userId }, unaffected by the role check");
            }
            __seedViewer(OWNER);
        }

        // ── 11. NO seeded viewer ⇒ every guard denies ───────────────────────
        // The guards have no identity fallback left. Out of a request scope
        // `headers()` throws, and the catch yields 401 — NOT the owner. This is
        // the assertion that would fail if anyone reinstated a `resolveOwner()`
        // fallback "so the smokes pass".
        {
            __resetViewer();
            const s = await requireSession();
            const o = await requireOwner();
            const svc = await requireSessionOrService(new Request("https://mc.salsquared.xyz/api/calendar/event"), SERVICE_CONFIG);
            const statuses = {
                requireSession: denyStatusOf(s),
                requireOwner: denyStatusOf(o),
                requireSessionOrService: denyStatusOf(svc),
            };
            if (Object.values(statuses).some((code) => code !== 401)) {
                fail("with no viewer resolvable every guard must 401 (no owner fallback)", statuses);
            } else {
                pass("no resolvable viewer → all four guards 401 (no resolveOwner fallback survived)");
            }
        }
    } finally {
        // A seam left armed here would leak an identity into the next suite.
        __resetViewer();
        __resetOwnerMemo();
    }
}

/**
 * The exit path lives OUT here, not at the bottom of `main()`, so no future
 * early `return` in the body can skip it. `resume-list-smoke.ts` had exactly
 * that bug: it printed `[FAIL]` and still exited 0, which the pre-push gate
 * reads as a pass.
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().then(finish, (e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
