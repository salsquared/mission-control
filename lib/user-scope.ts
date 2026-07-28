// P2.2 (OQ2a) — per-user scoping for the formerly-global tables
// (Task / LifeGoal / GlobalSetting / SavedPaper).
//
// THE WRINKLE THIS MODULE WAS BUILT FOR NO LONGER EXISTS. It used to read:
// "`requireLocalOrSession` admits LAN requests with NO session (the kiosk
// use-case — localhost / mc.local skip auth entirely)", and the owner fallback
// below was there so those session-less requests still resolved to a concrete
// userId. That is false as of P1.3 (docs/multi-user-crew.html): the LAN is no
// longer a trust boundary and the LAN branch is gone. Every guard in
// `lib/auth-guards.ts` now resolves through `lib/viewer.ts:resolveViewer()` and
// either synthesizes a session for a verified viewer or returns 401/403 — so a
// guard result that reaches `resolveScopedUserId` ALWAYS carries a session.
//
// `resolveScopedUserId` is therefore correct and unchanged: it still takes the
// session branch, which is now the only reachable one. The owner fallback is
// dead code kept for shape compatibility (see `resolveOwnerUserId`'s
// deprecation note) rather than removed inside a security-sensitive change.
//
// Resolution order:
//   1. the session's user id — synthesized by the guards from the
//      Access-verified viewer. This is the branch every request takes.
//   2-4. (unreachable from a request) the legacy owner fallback — see
//      `resolveOwnerUserId` below.

import { prisma } from '@/lib/prisma';
import { parseAllowlist } from '@/lib/auth-allowlist';

let cachedOwnerId: string | null = null;
let warnedUnresolvable = false;

/** Test seam — hermetic smokes reset the memo between fixture phases. */
export function _resetOwnerCache(): void {
    cachedOwnerId = null;
    warnedUnresolvable = false;
}

/**
 * Resolve the owner account for session-less requests. Memoized. Returns null
 * when no owner is resolvable (empty DB, ambiguous users).
 *
 * @deprecated Since P1.3 there are no session-less requests — the LAN branch
 * this existed for is gone (see the module header), so `resolveScopedUserId`
 * never reaches it. The one remaining production caller is
 * `lib/repositories/settings.ts:findGlobalSetting()`, whose own call sites P2.3
 * removes; deletion of this function is deferred cleanup after that, and
 * `user-scoping-smoke.ts` still exercises it meanwhile.
 *
 * Do NOT reach for this in new code. For "who is the owner" in a context with
 * no request, use `lib/owner.ts:resolveOwner()`, which reads the authoritative
 * `User.role = 'owner'` column instead of this allowlist-then-sole-row-then-
 * legacy-singleton chain — a chain that, with crew rows in the table, can
 * resolve to someone who is not the owner.
 */
export async function resolveOwnerUserId(): Promise<string | null> {
    if (cachedOwnerId) return cachedOwnerId;

    // (2) allowlist entries, in order — the first one with a User row wins.
    for (const email of parseAllowlist(process.env.ALLOWED_SIGNIN_EMAILS)) {
        const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (user) {
            cachedOwnerId = user.id;
            return user.id;
        }
    }

    // (3) sole-user fallback.
    const users = await prisma.user.findMany({ select: { id: true }, take: 2 });
    if (users.length === 1) {
        cachedOwnerId = users[0].id;
        return users[0].id;
    }

    // (4) legacy singleton settings row — its userId is the owner by
    // construction (P2.1 backfill).
    const legacy = await prisma.globalSetting.findUnique({
        where: { id: 'global' },
        select: { userId: true },
    });
    if (legacy) {
        cachedOwnerId = legacy.userId;
        return legacy.userId;
    }

    if (!warnedUnresolvable) {
        warnedUnresolvable = true;
        console.warn(
            '[user-scope] no owner account resolvable for session-less request scoping — ' +
            'LAN requests to user-scoped routes will 401. Sign in once (or set ALLOWED_SIGNIN_EMAILS) to fix.'
        );
    }
    return null;
}

// Shape-compatible with requireLocalOrSession's success result. `session` is
// optional only for historical reasons — the guard used to return { ok: true }
// with no session on the LAN branch. Since P1.3 a successful guard result
// always carries one.
export interface ScopedGuardResult {
    session?: { user?: { id?: string | null; email?: string | null } | null } | null;
}

/**
 * The userId every scoped query in tasks/goals/settings/research-saved routes
 * runs under: the viewer the guard resolved. Null ⇒ caller should respond 401.
 *
 * A request that carries a session never falls back to the owner — that would
 * hand a crew member (or a stranger) the owner's rows. Since P1.3 every
 * successful guard result carries a session, so the session branch is the only
 * one a request reaches and the owner fallback is unreachable dead code; it is
 * left in place rather than removed inside the auth rewrite. A session missing
 * the id claim (shouldn't happen; the guards always populate it from the
 * resolved viewer) resolves by the session email instead, and 401s if that
 * fails too.
 */
export async function resolveScopedUserId(guard: ScopedGuardResult): Promise<string | null> {
    const sessionUser = guard.session?.user as { id?: string | null; email?: string | null } | null | undefined;
    if (sessionUser) {
        if (typeof sessionUser.id === 'string' && sessionUser.id.length > 0) return sessionUser.id;
        if (typeof sessionUser.email === 'string' && sessionUser.email.length > 0) {
            const user = await prisma.user.findUnique({ where: { email: sessionUser.email }, select: { id: true } });
            return user?.id ?? null;
        }
        return null;
    }
    return resolveOwnerUserId();
}
