// P2.2 (OQ2a) — per-user scoping for the formerly-global tables
// (Task / LifeGoal / GlobalSetting / SavedPaper).
//
// The wrinkle this module exists for: `requireLocalOrSession` admits LAN
// requests with NO session (the kiosk use-case — localhost / mc.local skip
// auth entirely). Scoped queries from those requests must still resolve to a
// concrete userId, so session-less requests fall back to the OWNER account
// instead of 401ing the kiosk.
//
// Resolution order (memoized after first success — the owner never changes
// within a process lifetime):
//   1. the session's user id (tunnel requests with a NextAuth session),
//   2. the first ALLOWED_SIGNIN_EMAILS entry with a User row (deterministic
//      even when throwaway smoke users coexist in dev.db),
//   3. the sole User row when exactly one exists (fresh setups without the
//      allowlist env),
//   4. the userId of the legacy id='global' GlobalSetting row (backfilled to
//      the owner by migration 20260612235207 — survives multi-user DBs with
//      no allowlist configured).
// All four failing returns null; route handlers turn that into a 401.

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
 * Resolve the owner account for session-less (LAN) requests. Memoized.
 * Returns null when no owner is resolvable (empty DB, ambiguous users).
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

// Shape-compatible with requireLocalOrSession's success result: LAN bypass
// returns { ok: true } (no session), tunnel returns { ok: true, session }.
export interface ScopedGuardResult {
    session?: { user?: { id?: string | null; email?: string | null } | null } | null;
}

/**
 * The userId every scoped query in tasks/goals/settings/research-saved routes
 * runs under: the session's user when one exists, else the owner account
 * (LAN single-user fallback). Null ⇒ caller should respond 401.
 *
 * A request that DOES carry a session never falls back to the owner — that
 * would hand a stranger the owner's rows. A session missing the id claim
 * (shouldn't happen; lib/auth.ts's session callback attaches it) resolves by
 * the session email instead, and 401s if that fails too.
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
