// P1.1 (OQ1a) — sign-in email allowlist for the Google OAuth provider.
//
// Pure, env-agnostic helpers so the policy is hermetically testable
// (scripts/tests/hermetic/signin-allowlist-smoke.ts) without touching
// NextAuth. The signIn callback in lib/auth.ts is the only production
// caller of the decision; `instrumentation.ts` calls the startup check.
//
// ─── FAIL-CLOSED SINCE 2026-07-29 — THIS USED TO FAIL OPEN ─────────────────
//
// The original contract was "fail-open-with-warning": an unset/blank
// ALLOWED_SIGNIN_EMAILS admitted everyone and the caller logged one warn, on
// the reasoning that a fresh machine should not be bricked out of sign-in.
// That reasoning was sound when it was written and is NOT any more, because
// what a completed sign-in produces changed underneath it:
//
//   BEFORE the multi-user work, a `User` row was near-meaningless — the guards
//   synthesized an owner session from `resolveOwner()` regardless of which rows
//   existed, so an extra row bought an attacker nothing.
//
//   AFTER it (docs/multi-user-crew.html; CLAUDE.md §Auth), A `User` ROW *IS*
//   THE AUTHORIZATION TO USE THE APP. Provisioning is deliberately two-step:
//   the address must be in the hostname's Cloudflare Access policy (edge) AND
//   have a `User` row on this instance (origin). `/api/auth/[...nextauth]` is
//   one of only two unguarded routes, and `PrismaAdapter` mints a row —
//   `role` defaults to `"crew"` — on first successful sign-in. So a blank
//   allowlist is no longer "the allowlist is off": it is SELF-PROVISIONING.
//   Anyone who clears the edge policy walks straight past step two by visiting
//   /api/auth/signin.
//
// Hence: unset/blank now DENIES. It is not a silent deny, though — a silent
// one reads as a Google outage, and Google sign-in is how the OWNER mints and
// refreshes the Gmail + Calendar refresh token, so a confusing failure here is
// expensive. Two things make it legible:
//
//   1. `lib/auth.ts` logs `allowlistUnconfiguredMessage()` — which NAMES the
//      env var, the file, the restart command and the consequence — on EVERY
//      refused attempt (not warn-once: the operator needs the line to appear
//      while they are looking), and returns the NextAuth `Configuration` error
//      page ("Server error … Check the server logs for more information")
//      rather than the generic `AccessDenied` a plain `false` produces.
//   2. `checkSignInAllowlistAtStartup()` puts the same message in the log ring
//      buffer at BOOT, so the gap is visible in the in-app log viewer before
//      anyone tries to sign in.
//
// It deliberately does NOT throw at startup. Unlike `lib/access-jwt.ts` — where
// missing config must take the tier down to 401s because it gates every request
// — this gates one flow (minting the Google token). Killing the web tier over
// it would convert a degraded feature into a total outage, so the startup check
// reports and returns.

/** The env var. Exported so callers and tests never re-type the string. */
export const ALLOWLIST_ENV = 'ALLOWED_SIGNIN_EMAILS';

/** Why a sign-in was refused. Logged; the reason itself is never sent to the client. */
export type SignInDenyReason =
    | 'unconfigured'      // ALLOWED_SIGNIN_EMAILS unset/blank — a config fault, not a user fault
    | 'no-email'          // provider sent no email to check
    | 'not-allowlisted';  // a real address, not on the list

export type SignInDecision =
    | { ok: true; email: string }
    | { ok: false; reason: SignInDenyReason };

/**
 * Parse a comma-separated allowlist env value into normalized
 * (trimmed, lowercased) email entries. Unset/blank → empty list.
 */
export function parseAllowlist(allowlistEnv: string | undefined): string[] {
    if (!allowlistEnv) return [];
    return allowlistEnv
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0);
}

/**
 * True when the allowlist env is set to at least one non-blank entry. False is
 * now the DENY-EVERYTHING state, not the admit-everything one.
 */
export function isAllowlistConfigured(allowlistEnv: string | undefined): boolean {
    return parseAllowlist(allowlistEnv).length > 0;
}

/**
 * Decide whether `email` may sign in given the raw allowlist env value, and say
 * WHY when it may not — the two denials have different fixes (set an env var vs.
 * add an address), so they get different reasons and different surfaces.
 *
 * - Allowlist unset/empty → `{ ok: false, reason: 'unconfigured' }` (fail-CLOSED).
 * - No email               → `{ ok: false, reason: 'no-email' }`.
 * - Allowlist set          → strict, case-insensitive membership.
 */
export function evaluateSignIn(
    email: string | null | undefined,
    allowlistEnv: string | undefined,
): SignInDecision {
    const allowlist = parseAllowlist(allowlistEnv);
    if (allowlist.length === 0) return { ok: false, reason: 'unconfigured' };

    const normalized = email?.trim().toLowerCase();
    if (!normalized) return { ok: false, reason: 'no-email' };
    if (!allowlist.includes(normalized)) return { ok: false, reason: 'not-allowlisted' };
    return { ok: true, email: normalized };
}

/**
 * Boolean form of `evaluateSignIn`, kept because it reads better at a call site
 * that does not care why. NOTE the changed semantics: an unset allowlist is now
 * `false` for every email, including the owner's.
 */
export function isAllowedSignInEmail(
    email: string | null | undefined,
    allowlistEnv: string | undefined,
): boolean {
    return evaluateSignIn(email, allowlistEnv).ok;
}

/**
 * The one actionable message for the unconfigured case — shared by the sign-in
 * refusal and the startup check so an operator sees identical wording wherever
 * they hit it, and so grepping the log for the env var finds both.
 */
export function allowlistUnconfiguredMessage(): string {
    return (
        `[auth] ${ALLOWLIST_ENV} is unset or blank — Google sign-in is REFUSED for everyone ` +
        `(fail-closed since 2026-07-29). This is a server configuration fault, not a Google ` +
        `outage and not a rejected account. WHY IT MATTERS: a completed sign-in mints a User ` +
        `row, and a User row is authorization to use this instance — so an empty allowlist ` +
        `would let anyone past the Cloudflare Access edge provision themselves as crew. ` +
        `FIX: set ${ALLOWLIST_ENV}=<comma-separated addresses> in the untracked .env, then ` +
        `\`pm2 restart mission-control mission-control-dev --update-env\`. Until then the ` +
        `owner cannot mint or refresh the Gmail + Calendar token either.`
    );
}

/**
 * Startup check — call once per web-tier process (`instrumentation.ts`, after
 * `initLogger()` so the line lands in the in-app log viewer's ring buffer).
 *
 * Returns whether the allowlist is configured; logs the loud, actionable error
 * when it is not. NEVER THROWS — see the module header: this gates the Google
 * token flow, not request authorization, so a missing value must not take the
 * tier down. It is the early-warning half of the fix; `lib/auth.ts` is the
 * enforcing half.
 */
export function checkSignInAllowlistAtStartup(
    allowlistEnv: string | undefined = process.env[ALLOWLIST_ENV],
): boolean {
    if (isAllowlistConfigured(allowlistEnv)) return true;
    console.error(allowlistUnconfiguredMessage());
    return false;
}
