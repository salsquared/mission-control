// P2.2 (OQ2a) — per-user scoping for the formerly-global tables
// (Task / LifeGoal / GlobalSetting / SavedPaper).
//
// THE WRINKLE THIS MODULE WAS BUILT FOR NO LONGER EXISTS. It used to read:
// "`requireLocalOrSession` admits LAN requests with NO session (the kiosk
// use-case — localhost / mc.local skip auth entirely)", and an owner fallback
// existed so those session-less requests still resolved to a concrete userId.
// That has been false since P1.3 (docs/multi-user-crew.html): the LAN is no
// longer a trust boundary, the LAN branch is gone, and as of P1.3.2 so is the
// guard itself. Every guard in `lib/auth-guards.ts` resolves through
// `lib/viewer.ts:resolveViewer()` and either synthesizes a session for a
// verified viewer or returns 401/403 — so a guard result that reaches
// `resolveScopedUserId` ALWAYS carries a session.
//
// THE OWNER FALLBACK IS NOW DELETED, not merely unreachable. It walked an
// allowlist → sole-user → legacy-singleton chain, none of which reads the
// authoritative `User.role` column, so with crew rows in the table it could
// resolve to someone who is not the owner. Unreachable dead code that would
// hand out another account's rows if it ever became reachable is worth removing
// outright rather than documenting: `session` is now REQUIRED on
// `ScopedGuardResult`, which makes the bad branch impossible to express instead
// of merely unvisited. For "who is the owner" in a request-less context use
// `lib/owner.ts:resolveOwner()`.

import { prisma } from '@/lib/prisma';

/**
 * A successful guard result, as far as scoping is concerned.
 *
 * `session` is REQUIRED. It was optional while the LAN branch could return a
 * session-less success; since P1.3 no guard can, so requiring it here is what
 * makes "fall back to the owner" unrepresentable rather than just unreachable.
 */
export interface ScopedGuardResult {
    session: { user?: { id?: string | null; email?: string | null } | null } | null;
}

/**
 * The userId every scoped query in tasks/goals/settings/research-saved routes
 * runs under: the viewer the guard resolved. Null ⇒ caller should respond 401.
 *
 * There is NO owner fallback — a request that carries a session must never be
 * scoped to the owner, since that would hand a crew member (or a stranger) the
 * owner's rows. A session missing the id claim (shouldn't happen; the guards
 * always populate it from the resolved viewer) resolves by the session email
 * instead, and 401s if that fails too.
 */
export async function resolveScopedUserId(guard: ScopedGuardResult): Promise<string | null> {
    const sessionUser = guard.session?.user as { id?: string | null; email?: string | null } | null | undefined;
    if (!sessionUser) return null;

    if (typeof sessionUser.id === 'string' && sessionUser.id.length > 0) return sessionUser.id;
    if (typeof sessionUser.email === 'string' && sessionUser.email.length > 0) {
        const user = await prisma.user.findUnique({ where: { email: sessionUser.email }, select: { id: true } });
        return user?.id ?? null;
    }
    return null;
}
