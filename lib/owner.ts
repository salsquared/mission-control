// The identity of the OWNER, for contexts that have no request at all
// (docs/multi-user-crew.html, P1.3.3).
//
// NOT ON THE REQUEST PATH ANY MORE. Until P1.3 the guards in
// `lib/auth-guards.ts` called this helper for every request and synthesized an
// owner session from it — that is exactly the bypass the owner/crew work exists
// to remove (OQ2a). Requests now resolve their identity through
// `lib/viewer.ts:resolveViewer()`, which reads the Access-verified identity
// header and has ZERO fallback branches. Do not reintroduce a call to this
// module from anything that has a request in hand.
//
// The two sanctioned callers are contexts where there genuinely is no request
// and "the owner" is the right answer:
//   1. session-less scheduler reads, which act on the owner's behalf; and
//   2. the two env-gated break-glass branches in `lib/viewer.ts:tryBreakGlass`
//      (the dev-tier integration-suite escape and on-box prod recovery).
//
// Ownership is a STORED FACT — `User.role = 'owner'`, written by the migration
// that added the column (its hand-added `UPDATE "User" SET role = 'owner';`).
// `OWNER_EMAIL` is retired: there is no env pin and no row-order heuristic, and
// both of those branches were DELETED here at P1.3.3. Invariant: exactly one
// `role='owner'` row per DB (asserted by user-scoping-smoke.ts).
//
// Two properties are load-bearing — keep them through any future edit:
//   1. A miss returns null and NEVER falls through to a stray row. This is the
//      2026-06-24 audit's hardening, re-anchored from the env var onto the
//      column, and it matters MORE now than it did then: with crew rows in the
//      table, the old `findFirst({ orderBy: { id: 'asc' } })` heuristic would
//      resolve to whichever cuid sorted first — potentially a crew member.
//   2. `null` is never cached, so an owner row appearing later (a fresh machine,
//      a backfill that had not run yet) "takes" without a process restart.
//
// Distinct from `lib/user-scope.ts:resolveOwnerUserId` (allowlist-and-heuristic,
// id only, deprecated). This helper returns `{ id, email }` because its callers
// need both claims.

import { prisma } from '@/lib/prisma';

export interface Owner {
    id: string;
    email: string;
}

// Minimal structural slice of PrismaClient this module needs — lets the
// hermetic smoke inject a deterministic stub instead of depending on dev.db.
export interface OwnerResolverClient {
    user: {
        findFirst(args: {
            where: { role: 'owner' };
            select: { id: true; email: true };
        }): Promise<{ id: string; email: string | null } | null>;
    };
}

// Module-level memo. The owner never changes for a process lifetime, so the DB
// read happens only on cold start. `null` is NOT cached: we re-resolve on every
// miss so an owner row that appears after boot "takes" without a restart.
//
// This memo is CORRECT here and would be a total authorization bypass in
// `lib/viewer.ts` — see that file's opening danger callout. The difference is
// that this function answers one fixed question ("who is the owner"), not a
// per-request one ("who is calling").
let cachedOwner: Owner | null = null;

/**
 * Resolve the owner account, or null when no `role='owner'` row exists.
 * Never throws on the no-owner branch.
 *
 * @param client injectable for hermetic tests; defaults to the real prisma.
 *   The `prisma` extended client is structurally compatible with
 *   `OwnerResolverClient`, hence the cast at the default.
 */
export async function resolveOwner(
    client: OwnerResolverClient = prisma as unknown as OwnerResolverClient,
): Promise<Owner | null> {
    if (cachedOwner) return cachedOwner;

    const user = await client.user.findFirst({
        where: { role: 'owner' },
        select: { id: true, email: true },
    });
    if (user?.email) {
        cachedOwner = { id: user.id, email: user.email };
        return cachedOwner;
    }

    // No owner row (the migration's backfill never ran), or the owner row has a
    // null email — not a usable owner either way. Return null WITHOUT looking at
    // any other row: a crew row is never a substitute for the owner. Not cached,
    // so a promotion takes effect without a restart.
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
 * Test seam — seed the memo directly so a smoke can run DB-free against code
 * that calls `resolveOwner()` with the DEFAULT (real) prisma: a memo hit
 * short-circuits before any DB access, so prisma is never touched. (Since P1.3
 * that means the break-glass path in `lib/viewer.ts`, not the guards — those
 * resolve through `resolveViewer()` and are seeded with `__seedViewer` instead.)
 * Production code never calls this. Pass null to clear (equivalent to
 * __resetOwnerMemo).
 */
export function __seedOwnerMemo(owner: Owner | null): void {
    cachedOwner = owner;
}
