// P1.1 (OQ1a) — sign-in email allowlist for the Google OAuth provider.
//
// Pure, env-agnostic helpers so the policy is hermetically testable
// (scripts/tests/hermetic/signin-allowlist-smoke.ts) without touching
// NextAuth. The signIn callback in lib/auth.ts is the only production
// caller.
//
// Fail-open-with-warning: when ALLOWED_SIGNIN_EMAILS is unset/empty the
// check admits everyone and the CALLER logs one loud console.warn — same
// class of degradation as the Gmail webhook's PUBSUB_SERVICE_ACCOUNT_EMAIL
// handling. A fresh machine without the var must not brick sign-in.

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
 * True when the allowlist env is set to at least one non-blank entry.
 * Callers use this to decide whether to emit the fail-open warning.
 */
export function isAllowlistConfigured(allowlistEnv: string | undefined): boolean {
    return parseAllowlist(allowlistEnv).length > 0;
}

/**
 * Decide whether `email` may sign in given the raw allowlist env value.
 *
 * - Allowlist unset/empty → TRUE for any email (fail-open; caller warns).
 * - Allowlist set → strict, case-insensitive membership; a null/undefined
 *   email is rejected (no identity to check against).
 */
export function isAllowedSignInEmail(
    email: string | null | undefined,
    allowlistEnv: string | undefined,
): boolean {
    const allowlist = parseAllowlist(allowlistEnv);
    if (allowlist.length === 0) return true;
    if (!email) return false;
    return allowlist.includes(email.trim().toLowerCase());
}
