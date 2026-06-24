// Cloudflare-Access-at-edge auth (docs/cloudflare-access-auth.html, P1.1).
//
// Mission-control is single-owner. Once a request reaches the origin it is, by
// construction, either LAN-local or Access-passed — both legitimately the
// owner (see the doc's "trust the edge" section). The guards in
// `lib/auth-guards.ts` therefore stop calling `getServerSession` and instead
// resolve "the owner" through this helper, synthesizing an owner session.
//
// Distinct from `lib/user-scope.ts:resolveOwnerUserId` (which is allowlist-first
// and returns only an id for session-less LAN scoping of the formerly-global
// tables). This helper is OWNER_EMAIL-first and returns `{ id, email }` because
// the rewritten guards must populate BOTH claims (handlers read both).
//
// Resolution order (deterministic, minimal):
//   1. OWNER_EMAIL env set → user.findUnique({ where: { email } }). The pin is
//      authoritative: a miss returns null (re-resolve next call), it NEVER
//      falls through to a non-matching stray row.
//   2. OWNER_EMAIL unset → the single User row (findFirst, stable order) —
//      single-user, so "first" is "the owner".
//   3. else (zero users — fresh machine, no Google connected yet) → null.
//      Callers degrade: the synthesized session is absent, guards 401, and the
//      "Connect Google" affordance is the path forward. MUST NOT throw.

import { prisma } from '@/lib/prisma';

export interface Owner {
    id: string;
    email: string;
}

// Minimal structural slice of PrismaClient this module needs — lets the
// hermetic smoke inject a deterministic stub instead of depending on dev.db.
export interface OwnerResolverClient {
    user: {
        findUnique(args: {
            where: { email: string };
            select: { id: true; email: true };
        }): Promise<{ id: string; email: string | null } | null>;
        findFirst(args: {
            orderBy: { id: 'asc' };
            select: { id: true; email: true };
        }): Promise<{ id: string; email: string | null } | null>;
    };
}

// Module-level memo. Single-user ⇒ effectively immutable for the process
// lifetime, so the DB read happens only on cold start. `null` is NOT cached:
// we re-resolve on every miss so the first Google connect on a fresh machine
// (User row appears after boot) "takes" without a process restart.
let cachedOwner: Owner | null = null;

/**
 * Resolve the single owner account, or null on a fresh (zero-user) machine.
 * Never throws on the 0-users branch.
 *
 * @param client injectable for hermetic tests; defaults to the real prisma.
 *   The `prisma` extended client is structurally compatible with
 *   `OwnerResolverClient`, hence the cast at the default.
 */
export async function resolveOwner(
    client: OwnerResolverClient = prisma as unknown as OwnerResolverClient,
): Promise<Owner | null> {
    if (cachedOwner) return cachedOwner;

    // (1) OWNER_EMAIL pins the owner when a stray second User row could exist.
    const ownerEmail = process.env.OWNER_EMAIL?.trim();
    if (ownerEmail) {
        const user = await client.user.findUnique({
            where: { email: ownerEmail },
            select: { id: true, email: true },
        });
        if (user?.email) {
            cachedOwner = { id: user.id, email: user.email };
            return cachedOwner;
        }
        // OWNER_EMAIL set but no matching row yet (fresh machine before the
        // pinned owner connects). The pin is AUTHORITATIVE: return null WITHOUT
        // falling through to the sole-user heuristic, so a stray non-matching
        // row can never be cached as the owner (which would defeat the whole
        // point of pinning). Not cached → re-resolve next call, so the pinned
        // owner "takes" the moment its row appears, without a process restart.
        return null;
    }

    // (2) No OWNER_EMAIL: sole User row. The User model has no createdAt column, so we order by
    // `id` (always-present cuid) for a deterministic pick if a stray second row
    // ever appears — the design doc named createdAt, but that field doesn't
    // exist on the schema; id is the stable substitute.
    const user = await client.user.findFirst({
        orderBy: { id: 'asc' },
        select: { id: true, email: true },
    });
    if (user?.email) {
        cachedOwner = { id: user.id, email: user.email };
        return cachedOwner;
    }

    // (3) Zero users (or the sole row has a null email — not a usable owner).
    return null;
}

/**
 * Test seam — reset the memo between hermetic fixture phases.
 * Production code never calls this.
 */
export function __resetOwnerMemo(): void {
    cachedOwner = null;
}

/**
 * Test seam — seed the memo directly so the guard-return tests can run
 * DB-free. The guards call `resolveOwner()` with the DEFAULT (real) prisma; in
 * the hermetic smoke there is no dev.db connection we want, so we pre-seed the
 * memo (a cache hit short-circuits before any DB access). Production code never
 * calls this. Pass null to clear (equivalent to __resetOwnerMemo).
 */
export function __seedOwnerMemo(owner: Owner | null): void {
    cachedOwner = owner;
}
