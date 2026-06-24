/**
 * Hermetic smoke for the Cloudflare-Access owner-resolution auth model
 * (docs/cloudflare-access-auth.html, P1.1–P1.2 + P3.1).
 *
 *   npx tsx scripts/tests/hermetic/owner-auth-smoke.ts
 *
 * Asserts:
 *   1. OWNER_EMAIL path — resolveOwner() pins the owner by email.
 *   1b. OWNER_EMAIL set but unmatched → null (authoritative pin, no fallthrough).
 *   2. Single-user path — no OWNER_EMAIL → findFirst picks the sole row.
 *   3. 0-users → null (no throw).
 *   4. Memo hit skips the DB (a second call doesn't re-query the stub).
 *   5. Memo re-resolves after a null result (fresh-machine first-connect).
 *   6. requireSession() returns { session: { user: { id, email } } } with NO
 *      NextAuth session present (seeded memo → no DB).
 *   7. requireSessionOrService() service-token branch still works (byte-for-byte).
 *   8. requireSessionOrService() session branch returns { userId }.
 *   Plus: requireLocalOrSession() returns { ok, session } for any request.
 *
 * Genuinely hermetic + deterministic: NO network, NO PM2, and it NEVER reads or
 * mutates dev.db / prod.db. resolveOwner() takes an injectable `client` stub for
 * the resolution tests; the guards call resolveOwner() with the DEFAULT real
 * prisma, so for the guard-return tests we pre-seed the module memo via
 * __seedOwnerMemo() — a memo hit short-circuits before any DB access, so prisma
 * is never touched. (lib/prisma is never even imported here.)
 */

// Pin a throwaway DATABASE_URL purely so that if some transitive import loads
// lib/prisma it points at a non-existent file rather than dev.db. The seeded
// memo means no query ever runs, but this is belt-and-suspenders against the
// "phantom prisma/prisma/dev.db" footgun.
process.env.DATABASE_URL = `file:/tmp/owner-auth-smoke-${process.pid}.db`;
delete process.env.OWNER_EMAIL;

import {
    resolveOwner,
    __resetOwnerMemo,
    __seedOwnerMemo,
    type OwnerResolverClient,
} from "@/lib/owner";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

/**
 * Deterministic in-memory stand-in for PrismaClient's `user` delegate. Counts
 * calls so we can prove the memo skips the DB. `rows` is the fixture set.
 */
function makeStubClient(rows: Array<{ id: string; email: string | null }>) {
    const calls = { findUnique: 0, findFirst: 0 };
    const client: OwnerResolverClient = {
        user: {
            async findUnique({ where }) {
                calls.findUnique++;
                return rows.find((r) => r.email === where.email) ?? null;
            },
            async findFirst() {
                calls.findFirst++;
                // Stable order by id (mirrors resolveOwner's orderBy: { id: 'asc' }).
                const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
                return sorted[0] ?? null;
            },
        },
    };
    return { client, calls };
}

async function main() {
    // ── 1. OWNER_EMAIL path ─────────────────────────────────────────────────
    __resetOwnerMemo();
    process.env.OWNER_EMAIL = "owner@owner-auth-smoke.invalid";
    {
        const { client, calls } = makeStubClient([
            { id: "u-stranger", email: "stranger@owner-auth-smoke.invalid" },
            { id: "u-owner", email: "owner@owner-auth-smoke.invalid" },
        ]);
        const owner = await resolveOwner(client);
        if (owner?.id !== "u-owner" || owner.email !== "owner@owner-auth-smoke.invalid") {
            fail("OWNER_EMAIL path should pin u-owner by email", owner);
        } else if (calls.findUnique !== 1 || calls.findFirst !== 0) {
            fail("OWNER_EMAIL path should use findUnique, not findFirst", calls);
        } else {
            pass("OWNER_EMAIL → resolveOwner pins the owner by email (findUnique)");
        }
    }

    // ── 1b. OWNER_EMAIL set but unmatched → null (pin is authoritative) ──────
    // Security regression: a set-but-missing OWNER_EMAIL must NOT fall through
    // to findFirst and cache a non-matching stray row as the owner.
    __resetOwnerMemo();
    {
        // OWNER_EMAIL still points at owner@… (set above); rows hold only a
        // stranger, so the pin misses.
        const { client, calls } = makeStubClient([
            { id: "u-stranger", email: "stranger@owner-auth-smoke.invalid" },
        ]);
        const owner = await resolveOwner(client);
        if (owner !== null) {
            fail("OWNER_EMAIL miss must return null, never a non-matching stray row", { owner, calls });
        } else if (calls.findFirst !== 0) {
            fail("OWNER_EMAIL miss must NOT fall through to findFirst", calls);
        } else {
            pass("OWNER_EMAIL set but no matching row → null (pin authoritative, no findFirst fallthrough)");
        }
    }
    delete process.env.OWNER_EMAIL;

    // ── 2. Single-user findFirst path ───────────────────────────────────────
    __resetOwnerMemo();
    {
        const { client, calls } = makeStubClient([{ id: "u-sole", email: "sole@owner-auth-smoke.invalid" }]);
        const owner = await resolveOwner(client);
        if (owner?.id !== "u-sole" || owner.email !== "sole@owner-auth-smoke.invalid") {
            fail("single-user path should pick the sole row via findFirst", owner);
        } else if (calls.findFirst !== 1) {
            fail("single-user path should call findFirst once", calls);
        } else {
            pass("no OWNER_EMAIL + single user → resolveOwner picks the sole row (findFirst)");
        }
    }

    // ── 3. 0-users → null, no throw ─────────────────────────────────────────
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

    // ── 4. Memo hit skips the DB ────────────────────────────────────────────
    __resetOwnerMemo();
    {
        const { client, calls } = makeStubClient([{ id: "u-memo", email: "memo@owner-auth-smoke.invalid" }]);
        await resolveOwner(client);            // cold — one findFirst
        const before = calls.findFirst;
        const second = await resolveOwner(client); // warm — memo hit
        if (second?.id !== "u-memo") fail("memo hit should return the cached owner", second);
        else if (calls.findFirst !== before) fail("memo hit must NOT re-query the DB", calls);
        else pass("memo hit returns cached owner without re-querying the DB");
    }

    // ── 5. Memo re-resolves after null (fresh-machine first connect) ────────
    __resetOwnerMemo();
    {
        const rows: Array<{ id: string; email: string | null }> = [];
        const { client, calls } = makeStubClient(rows);
        const first = await resolveOwner(client);
        if (first !== null) fail("expected null while no users exist", first);
        // The owner connects after boot — a User row appears.
        rows.push({ id: "u-late", email: "late@owner-auth-smoke.invalid" });
        const second = await resolveOwner(client);
        if (second?.id !== "u-late") {
            fail("after a null result, resolveOwner must re-resolve (not cache null)", { second, calls });
        } else {
            pass("null result is NOT cached — first connect takes without a restart");
        }
    }

    // ── 6. requireSession() with no NextAuth session (seeded memo) ──────────
    // The guards call resolveOwner() with the DEFAULT real prisma; seeding the
    // memo means the cache hit returns before any DB access. lib/prisma stays
    // untouched, so this is DB-free.
    const OWNER = { id: "u-guard", email: "guard@owner-auth-smoke.invalid" };
    const { requireSession, requireSessionOrService, requireLocalOrSession } =
        await import("@/lib/auth-guards");

    __seedOwnerMemo(OWNER);
    {
        const guard = await requireSession();
        if ("error" in guard) {
            fail("requireSession should synthesize an owner session (got error)", guard);
        } else if (guard.session.user.id !== OWNER.id || guard.session.user.email !== OWNER.email) {
            fail("requireSession session must carry both owner id and email", guard.session);
        } else {
            pass("requireSession() → { session: { user: { id, email } } } with no NextAuth session");
        }
    }

    // requireLocalOrSession — always { ok, session } past the edge.
    {
        const req = new Request("https://ms-prod.salsquared.xyz/api/profile");
        const guard = await requireLocalOrSession(req);
        if ("error" in guard) {
            fail("requireLocalOrSession should return ok+session past the edge", guard);
        } else if (!guard.ok || guard.session.user.id !== OWNER.id || guard.session.user.email !== OWNER.email) {
            fail("requireLocalOrSession must return { ok, session: owner }", guard);
        } else {
            pass("requireLocalOrSession() → { ok: true, session: owner } for any request");
        }
    }

    // ── 7. requireSessionOrService service-token branch (unchanged) ─────────
    process.env.SERVICE_TOKEN_PULSAR = "test-token-owner-auth-smoke";
    process.env.SERVICE_TOKEN_PULSAR_USER_ID = "pulsar-user-123";
    const SERVICE_CONFIG = { tokenEnv: "SERVICE_TOKEN_PULSAR", userIdEnv: "SERVICE_TOKEN_PULSAR_USER_ID" };
    {
        const req = new Request("https://ms-prod.salsquared.xyz/api/calendar/event?onBehalfOf=pulsar-user-123", {
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
        const badReq = new Request("https://ms-prod.salsquared.xyz/api/calendar/event?onBehalfOf=pulsar-user-123", {
            headers: { authorization: "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxx" },
        });
        const badGuard = await requireSessionOrService(badReq, SERVICE_CONFIG);
        if (!("error" in badGuard)) fail("invalid service token must be rejected", badGuard);
        else pass("requireSessionOrService() rejects an invalid service token");
    }

    // ── 8. requireSessionOrService session branch → { userId } ──────────────
    {
        const req = new Request("https://ms-prod.salsquared.xyz/api/calendar/event"); // no Bearer
        const guard = await requireSessionOrService(req, SERVICE_CONFIG);
        if ("error" in guard) {
            fail("session branch should resolve to the owner", guard);
        } else if (guard.userId !== OWNER.id) {
            fail("session branch should return { userId: ownerId }", guard);
        } else {
            pass("requireSessionOrService() session branch → { userId: ownerId }");
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
