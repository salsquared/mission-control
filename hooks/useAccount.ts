import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/api-client';

// The viewer's identity, ROLE and Google-connection state — the one fetch every
// client makes before it can decide what to render
// (docs/multi-user-crew.html §2.12, P3.1).
//
// It replaced next-auth's `useSession` under the Cloudflare-Access work, and
// the owner/crew work widened it: a request reaching the origin is no longer
// "the owner by construction", so this hook now answers three questions, not
// one — WHO is signed in, WHAT ROLE they hold, and (when neither) WHICH of the
// two rejections happened.

/**
 * The two roles. Declared here rather than imported from `lib/viewer.ts`
 * ON PURPOSE: that module imports `next/headers` and `@/lib/prisma`, so pulling
 * its `Role` type into a `"use client"` graph drags server-only modules into
 * the bundle (a type-only import would erase, but the invitation to later grab
 * a value from it is the trap). Two string literals are not worth a shared
 * client-safe module; if a third consumer ever needs them, lift them into one
 * rather than importing from `lib/viewer.ts`.
 *
 * Kept structurally identical to `lib/viewer.ts:Role` — if that union ever
 * gains a member, this must too.
 */
export type Role = 'owner' | 'crew';

export interface AccountUser {
    id: string;
    email: string;
    role: Role;
}

export interface AccountResponse {
    user: AccountUser;
    googleConnected: boolean;
}

/**
 * The lifecycle of the account fetch, as ONE value to switch on.
 *
 * This exists because the interesting states are not "loading / loaded /
 * broken" — three of them are terminal and each wants different UI, and the
 * boolean pairs the hook used to return could not express that. Consumers
 * should branch on this, not on `isLoading` + `isError` + a status compare.
 *
 *   'loading'         — the request is in flight. THE ROLE IS NOT KNOWN. This is
 *                       the window P3.3 must not render the shell through: do
 *                       not call `dashesForRole()` (its `role` parameter is
 *                       non-optional precisely so this cannot be papered over),
 *                       do not run `useDashCarousel`, and never substitute
 *                       `role ?? 'crew'` — that is OQ9c, which strands the
 *                       owner on the wrong dash.
 *   'ready'           — 200. `user` and `role` are populated.
 *   'unauthenticated' — 401. No Access-verified identity reached the origin;
 *                       the edge or the JWT config is wrong. NOT the person's
 *                       fault and NOT fixable by provisioning.
 *   'unprovisioned'   — 403. Cloudflare Access authenticated them, but this
 *                       instance has no `User` row for that address (OQ3a's
 *                       deliberate two-step provisioning). `error.detail` names
 *                       the signed-in email — render it, so they can tell the
 *                       owner exactly which address to add (P3.8).
 *   'error'           — anything else: network failure, 5xx, or a payload whose
 *                       `user.role` is missing/unrecognised (a client-newer-
 *                       than-server skew). Deliberately NOT folded into
 *                       'loading': a spinner that never resolves is the bug
 *                       P3.8 exists to remove.
 */
export type AccountState =
    | 'loading'
    | 'ready'
    | 'unauthenticated'
    | 'unprovisioned'
    | 'error';

/**
 * A failed `/api/account` fetch, with the HTTP status preserved.
 *
 * The status is the whole point. `lib/auth-guards.ts` keeps 401 and 403 apart
 * deliberately (§2.3) and a client that collapses them cannot tell "the tunnel
 * is misconfigured" from "you need an account" — so this hook does NOT route
 * through `lib/api-client.ts`'s `jsonFetch`, which throws
 * `new Error(body.error)` and drops the status, the `reason` and the `detail`
 * that names the signed-in email. It is the only fetch in the app that needs
 * the rejection's shape rather than just its failure, so it reads the response
 * itself. Everything else should still go through `api.*`.
 */
export class AccountError extends Error {
    /** HTTP status, or 0 when the request never completed (network failure). */
    readonly status: number;
    /** Machine-readable arm from the guard: 'no-verified-identity' | 'not-provisioned' | … */
    readonly reason: string | null;
    /** Human-readable sentence from the guard. For a 403 it NAMES THE EMAIL. */
    readonly detail: string | null;

    constructor(message: string, status: number, reason: string | null, detail: string | null) {
        super(message);
        this.name = 'AccountError';
        this.status = status;
        this.reason = reason;
        this.detail = detail;
    }
}

function isRole(value: unknown): value is Role {
    return value === 'owner' || value === 'crew';
}

async function fetchAccount(): Promise<AccountResponse> {
    let res: Response;
    try {
        res = await fetch('/api/account');
    } catch (e) {
        // Status 0 — the request never reached the origin, so there is no
        // verdict to read. Distinct from every server-issued code below.
        throw new AccountError(e instanceof Error ? e.message : 'Network error', 0, null, null);
    }

    if (!res.ok) {
        const body = await res.json().catch(() => null) as
            { error?: string; reason?: string; detail?: string } | null;
        throw new AccountError(
            // `||`, not `??` — HTTP/2 responses carry an EMPTY statusText, and
            // an empty message is as useless as a missing one.
            body?.error || res.statusText || 'Account fetch failed',
            res.status,
            body?.reason ?? null,
            body?.detail ?? null,
        );
    }

    // Typed as raw so the checks below are real validation and not a cast
    // dressed up as one.
    const data = await res.json() as
        { user?: { id?: unknown; email?: unknown; role?: unknown }; googleConnected?: unknown } | null;
    const user = data?.user;

    // Validate `role` at the boundary instead of asserting it. A payload
    // without a recognised role means the client is running against an older
    // build; surfacing that as state 'error' is honest, whereas defaulting it
    // would silently hand a crew UI to the owner (or the reverse) — and
    // resolving it to 'loading' would be the infinite spinner all over again.
    if (typeof user?.id !== 'string' || typeof user.email !== 'string' || !isRole(user.role)) {
        console.error('[useAccount] /api/account returned no usable user:', data);
        throw new AccountError('Account payload missing a valid id/email/role', res.status, 'malformed-payload', null);
    }

    return {
        user: { id: user.id, email: user.email, role: user.role },
        googleConnected: data?.googleConnected === true,
    };
}

export function useAccount() {
    const query = useQuery<AccountResponse, AccountError>({
        queryKey: queryKeys.account,
        queryFn: fetchAccount,
        // Identity and role are process-stable for a session, and connection
        // state flips only on a manual connect/disconnect, so don't churn this
        // on window focus.
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        // 401 and 403 are VERDICTS, not blips — retrying either just delays the
        // terminal state P3.8 renders (and, for a 403, hammers a route that
        // will keep saying no until the owner provisions the address).
        // `refetch` is returned below for the "I've been added now" case.
        retry: false,
    });

    const status = query.error?.status ?? null;
    const state: AccountState = query.isError
        ? status === 401 ? 'unauthenticated'
            : status === 403 ? 'unprovisioned'
                : 'error'
        : query.data
            ? 'ready'
            : 'loading';

    return {
        // ── Identity ────────────────────────────────────────────────────────
        user: query.data?.user,
        /**
         * `Role | undefined` — and `undefined` means NOT KNOWN YET (or the
         * fetch failed), never "crew". Narrow it before use:
         *
         *     const { role } = useAccount();
         *     if (!role) return <Loading />;   // or the P3.8 terminal state
         *     return <Shell dashes={dashesForRole(role)} />;
         *
         * Do NOT write `dashesForRole(role ?? 'crew')`.
         */
        role: query.data?.user.role,
        googleConnected: query.data?.googleConnected ?? false,

        // ── Lifecycle ───────────────────────────────────────────────────────
        /** Prefer this over the booleans below — see `AccountState`. */
        state,
        /** HTTP status of the failure, `0` for a network error, `null` when there is none. */
        status,
        /** Carries `reason` + `detail`; `detail` names the signed-in email on a 403. */
        error: query.error ?? null,
        refetch: query.refetch,

        // Retained so the existing consumers (ApplicationsView, ProfileView,
        // InternalView, CalendarWidget) keep compiling unchanged.
        isLoading: query.isLoading,
        isError: query.isError,
    };
}
