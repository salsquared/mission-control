// ============================================================================
//  ⚠️  FAIL-CLOSED MODULE — THE ONE PLACE IN THIS REPO THAT MUST NOT DEGRADE. ⚠️
// ============================================================================
//
// Every other shared/remote dependency in this codebase is best-effort by
// design and degrades to "do it directly": `lib/shared-sqlite-cache.ts` falls
// back to an uncached compute, `lib/ai/llm-cache.ts` calls Gemini anyway,
// `lib/arxiv/rate-limit.ts` falls back to a per-process bucket, `lib/cache.ts`
// serves the last good payload. That reflex is CORRECT there and WRONG here.
//
// This module is an authorization gate. An unreachable JWKS, a timed-out fetch,
// an unset env var or a malformed token must all produce "no viewer" — i.e. a
// 401 — and NEVER "trust the header instead". A degrade-to-the-header fallback
// would be the exact bypass this module exists to close, with extra steps
// (design doc risk R4d). The JWKS cache TTL below is what absorbs transient
// upstream failures; there is no second fallback behind it.
//
// The corollary, stated so nobody has to discover it in production: because the
// contract is fail-closed, a WRONG `CF_ACCESS_AUD` is not a degraded mode — it
// is a total lockout of every user on that hostname, the owner included, with
// the loopback break-glass escapes (docs/multi-user-crew.html §2.3) as the only
// way back in. An AUD rotates whenever its Access app is RECREATED (not when it
// is edited), so "re-read the AUD and restart the tier" is part of any Access
// app rebuild, not follow-up work. Re-read it with:
//
//     curl -sI https://mc.salsquared.xyz/     # → Location: …/login/…?kid=<AUD>
//     curl -sI https://mc-dev.salsquared.xyz/
//
// ============================================================================
//
// Layer 2 of the header-authenticity fix (docs/multi-user-crew.html §2.7, P4.2).
//
// `Cf-Access-Authenticated-User-Email` is just a header. Anything that can open
// a TCP connection to the origin can set it to any value — so role gating and
// per-user scoping are decorative without a cryptographic check behind them.
// Layer 1 (P4.1) removes the unauthenticated route to the origin, but that is a
// CONFIGURATION property and configuration regresses: a `next start` tweak, a
// restored Caddyfile, or a new reverse proxy silently reopens it. This module
// is Layer 2 — it makes forgery fail cryptographically regardless of topology.
//
// It is not hypothetical. On 2026-07-28, during the ms-* → mc hostname
// migration, both public hostnames served for ~14 minutes with no Access app in
// front of them. Because the origin trusted the edge and performed no
// independent check, owner-authenticated data was served to anonymous requests
// on the public internet for the whole window — no forged header, no LAN access
// required. With this module in place the same 14 minutes is a stack of 401s:
// an outage, not a breach.
//
// What it does:
//   1. Reads `Cf-Access-Jwt-Assertion` (the token Access stamps alongside the
//      identity header).
//   2. Verifies it against the Access team's public JWKS — RS256 signature,
//      `iss` = the team domain, `aud` = THIS hostname's application AUD, plus
//      `exp`/`nbf`.
//   3. Cross-checks the verified `email` claim against the identity header. A
//      mismatch means one of the two was tampered with → reject. (Once this
//      holds the header is strictly redundant; it is kept because it is the
//      documented, stable surface and the JWT claim shape is Cloudflare's to
//      change.)
//
// Where it is called: exactly one site — `lib/viewer.ts:resolveViewer()`, AFTER
// the break-glass branches and BEFORE the identity-header read. That order is
// load-bearing: a loopback break-glass request carries no JWT, so verifying
// first would make both escapes dead code and fail the integration suites with
// a misleading JWT error.
//
// NO VERIFICATION RESULT IS EVER CACHED. The only module state here is the
// jose-owned JWKS (public keys, no identity) and two log-throttle latches
// holding timestamps/booleans. Caching a verified identity would be the
// cross-tenant leak `lib/viewer.ts`'s header comment exists to prevent.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Minimal structural read seam over the header bag — the same shape
 * `lib/viewer.ts` uses, declared locally so the two modules do not import each
 * other (`viewer` → `access-jwt` is the only direction).
 */
export interface AccessJwtHeaderReader {
    get(name: string): string | null | undefined;
}

/** Why a request was refused. Logged; never returned to the client. */
export type AccessJwtDenyReason =
    | 'unconfigured'        // CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD not set
    | 'missing-assertion'   // no Cf-Access-Jwt-Assertion header
    | 'missing-identity'    // no Cf-Access-Authenticated-User-Email to cross-check
    | 'invalid-token'       // signature / iss / aud / exp / nbf / alg failure
    | 'missing-email-claim' // verified token carries no usable `email`
    | 'email-mismatch';     // verified claim ≠ identity header ⇒ tampering

export type AccessJwtResult =
    | { ok: true; email: string }
    | { ok: false; reason: AccessJwtDenyReason };

/**
 * The Cloudflare Access token header. Lowercase — `Headers.get` is
 * case-insensitive.
 */
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/**
 * The identity header, cross-checked against the verified `email` claim.
 * Deliberately duplicated from `lib/viewer.ts` rather than shared: each module
 * reads its own inputs, and a shared-constants module for one string would be
 * more indirection than the duplication costs. If one moves, move both.
 */
const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';

/** Env: the Zero Trust team domain, e.g. `salsquared.cloudflareaccess.com`. */
const TEAM_DOMAIN_ENV = 'CF_ACCESS_TEAM_DOMAIN';

/** Env: the per-application AUD. Prod and dev are DIFFERENT applications. */
const AUD_ENV = 'CF_ACCESS_AUD';

/** Team-scoped JWKS path (same for every application on the team). */
const JWKS_PATH = '/cdn-cgi/access/certs';

// JWKS caching. `createRemoteJWKSet` owns the fetch, the in-memory cache, the
// refresh-on-unknown-`kid` path (so key rotation needs no restart) and the
// cooldown that keeps an unknown-kid flood from turning into a fetch storm —
// see the delegation note at the bottom of this file.
const JWKS_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1h — the transient-failure buffer
const JWKS_COOLDOWN_MS = 30_000;              // floor between kid-miss refetches
const JWKS_TIMEOUT_MS = 5_000;                // request timeout → verification fails

/** Clock-skew tolerance for `exp`/`nbf`, in seconds. */
const CLOCK_TOLERANCE_S = 5;

/**
 * Injectable dependencies. Production ALWAYS calls `verifyAccessJwt()` with no
 * second argument. These exist only so `access-jwt-smoke.ts` can drive the
 * verifier hermetically — with a throwaway RSA keypair and a LOCAL key set —
 * instead of reaching Cloudflare over the network. Same shape and same risk
 * profile as `ViewerResolverDeps` in `lib/viewer.ts` and `OwnerResolverClient`
 * in `lib/owner.ts`: parameters, not module state, so there is no ambient way
 * to activate them.
 */
export interface AccessJwtDeps {
    /** Key resolver. Defaults to the team's remote JWKS. */
    getKey?: JWTVerifyGetKey;
    /** Team domain override. Defaults to `CF_ACCESS_TEAM_DOMAIN`. */
    teamDomain?: string;
    /** Application AUD override. Defaults to `CF_ACCESS_AUD`. */
    aud?: string;
}

// --- module state: public keys and log latches only, never an identity -------

/** One jose remote key set per team domain (in practice: exactly one). */
const jwksByDomain = new Map<string, JWTVerifyGetKey>();

/** Warn-throttle per deny reason — the ring buffer is 500 deep; see below. */
const lastWarnedAt = new Map<AccessJwtDenyReason, number>();
const WARN_WINDOW_MS = 60_000;

/** The config error is static, so it warrants exactly one line per process. */
let configErrorWarned = false;

/**
 * Verify the Cloudflare Access JWT on the current request.
 *
 * Never throws: every failure mode — including an unreachable JWKS — collapses
 * to `{ ok: false }`, which `resolveViewer()` translates to a 401. Returns the
 * VERIFIED email claim (equal to the identity header by construction, since a
 * mismatch is rejected).
 *
 * @param h header source for this request.
 * @param deps injectable for hermetic tests. Production passes nothing.
 */
export async function verifyAccessJwt(
    h: AccessJwtHeaderReader,
    deps: AccessJwtDeps = {},
): Promise<AccessJwtResult> {
    const teamDomain = normalizeTeamDomain(deps.teamDomain ?? process.env[TEAM_DOMAIN_ENV]);
    const aud = deps.aud?.trim() || process.env[AUD_ENV]?.trim();

    // (0) Configuration. Missing config DENIES — it does not fall through to
    // "trust the header". This is the fail-closed contract's least intuitive
    // branch, so it gets the loudest log line in the module.
    if (!teamDomain || !aud) {
        if (!configErrorWarned) {
            configErrorWarned = true;
            console.error(
                `[ACCESS-JWT] NOT CONFIGURED — ${TEAM_DOMAIN_ENV}${teamDomain ? '' : ' (missing)'} / ` +
                `${AUD_ENV}${aud ? '' : ' (missing)'}. This module is FAIL-CLOSED: every request on ` +
                `this tier will be denied (401) until both are set in the tier's .env file and the ` +
                `process is restarted with --update-env. See .env.{development,production}.example.`,
            );
        }
        return { ok: false, reason: 'unconfigured' };
    }

    // (1) The token itself. Absent ⇒ either a forged/direct request that never
    // passed the edge, or the edge stopped stamping it (an Access
    // misconfiguration). Both are "I do not know who you are".
    const token = h.get(ACCESS_JWT_HEADER)?.trim();
    if (!token) {
        warnThrottled(
            'missing-assertion',
            `[ACCESS-JWT] request carried no ${ACCESS_JWT_HEADER} — denying (401). ` +
            `Either it did not come through Cloudflare Access, or the Access app for this ` +
            `hostname is misconfigured.`,
        );
        return { ok: false, reason: 'missing-assertion' };
    }

    // (2) The identity header we are about to cross-check against. Access sets
    // both or neither; one without the other is not a usable identity.
    const headerEmail = h.get(ACCESS_EMAIL_HEADER)?.trim().toLowerCase();
    if (!headerEmail) {
        warnThrottled(
            'missing-identity',
            `[ACCESS-JWT] ${ACCESS_JWT_HEADER} present but ${ACCESS_EMAIL_HEADER} absent — ` +
            `denying (401). Nothing to cross-check the verified claim against.`,
        );
        return { ok: false, reason: 'missing-identity' };
    }

    // (3) Signature + claims. `jwtVerify` enforces alg / iss / aud / exp / nbf;
    // any failure throws and is caught here.
    let email: unknown;
    try {
        const { payload } = await jwtVerify(token, deps.getKey ?? remoteJwksFor(teamDomain), {
            issuer: `https://${teamDomain}`,
            audience: aud,
            algorithms: ['RS256'],
            clockTolerance: CLOCK_TOLERANCE_S,
        });
        email = payload.email;
    } catch (err) {
        // Covers the unreachable/timed-out JWKS too — deliberately the same
        // branch as a bad signature. An upstream outage denies; it never admits.
        warnThrottled(
            'invalid-token',
            `[ACCESS-JWT] ${ACCESS_JWT_HEADER} failed verification for ${headerEmail} — denying (401): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, reason: 'invalid-token' };
    }

    if (typeof email !== 'string' || !email.trim()) {
        warnThrottled(
            'missing-email-claim',
            `[ACCESS-JWT] verified token for ${headerEmail} carries no usable \`email\` claim — ` +
            `denying (401). Cloudflare may have changed the claim shape.`,
        );
        return { ok: false, reason: 'missing-email-claim' };
    }

    // (4) The cross-check. Signature-valid but claiming a different identity
    // than the header means one of the two was tampered with.
    const claimEmail = email.trim().toLowerCase();
    if (claimEmail !== headerEmail) {
        warnThrottled(
            'email-mismatch',
            `[ACCESS-JWT] TAMPERING: verified token claims "${claimEmail}" but ` +
            `${ACCESS_EMAIL_HEADER} says "${headerEmail}" — denying (401).`,
        );
        return { ok: false, reason: 'email-mismatch' };
    }

    return { ok: true, email: claimEmail };
}

/**
 * Accepts `salsquared.cloudflareaccess.com`, `https://salsquared.cloudflareaccess.com`
 * and a trailing slash alike, because all three are what a human copies out of
 * the Zero Trust dashboard. Returns '' when unset/blank so the caller's
 * fail-closed check is a single falsiness test.
 */
function normalizeTeamDomain(raw: string | undefined): string {
    return (raw ?? '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

/**
 * The team's remote key set, memoized per domain. Public keys only — this
 * memo can never hold or leak an identity.
 */
function remoteJwksFor(teamDomain: string): JWTVerifyGetKey {
    let jwks = jwksByDomain.get(teamDomain);
    if (!jwks) {
        jwks = createRemoteJWKSet(new URL(`https://${teamDomain}${JWKS_PATH}`), {
            cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
            cooldownDuration: JWKS_COOLDOWN_MS,
            timeoutDuration: JWKS_TIMEOUT_MS,
        });
        jwksByDomain.set(teamDomain, jwks);
    }
    return jwks;
}

/**
 * One log line per reason per minute. A denied request is per-request by
 * nature, so an unthrottled `console.warn` would let a single scanner flush the
 * 500-deep log ring buffer (`lib/logger.ts`) — losing exactly the context an
 * operator needs to read the denial. Timestamps only; no identity is retained.
 */
function warnThrottled(reason: AccessJwtDenyReason, message: string): void {
    const now = Date.now();
    if (now - (lastWarnedAt.get(reason) ?? 0) < WARN_WINDOW_MS) return;
    lastWarnedAt.set(reason, now);
    console.warn(message);
}

/**
 * Test seam — drop the memoized key sets and the log latches so one smoke's
 * fixture cannot leak into the next. Production code never calls this; the `__`
 * prefix is this repo's "test seam, not API" marker (`grep -rn '__resetAccessJwt'
 * app lib components scheduler` is the accidental-use check).
 */
export function __resetAccessJwtState(): void {
    jwksByDomain.clear();
    lastWarnedAt.clear();
    configErrorWarned = false;
}

// ---------------------------------------------------------------------------
// Delegated to jose vs. implemented here — so a future reader does not
// re-implement what `createRemoteJWKSet` already does correctly.
//
// DELEGATED (configuration, not code):
//   · JWKS fetch + in-memory cache, TTL'd by `cacheMaxAge` (1h here).
//   · Refresh on unknown `kid` — a rotated Access signing key is picked up on
//     the first token that uses it, with NO process restart. This is why there
//     is no hand-rolled "refresh the key cache" path in this file.
//   · `cooldownDuration` — the floor between kid-miss refetches, so a flood of
//     junk tokens with random `kid`s cannot turn into a JWKS fetch storm.
//   · `timeoutDuration` — a hung JWKS request aborts and the verification
//     fails (fail-closed) instead of hanging the request.
//   · Key selection by `kid` / `alg` / `use` / `key_ops`, and the RS256
//     signature check, `iss`, `aud`, `exp`, `nbf` and clock tolerance via
//     `jwtVerify`'s options.
//
// IMPLEMENTED HERE:
//   · The fail-closed contract itself — jose throws, and translating those
//     throws to "no viewer" (rather than to a fallback) is the whole point.
//   · Header extraction and the `email`-claim ↔ identity-header cross-check,
//     which is application semantics jose knows nothing about.
//   · Config resolution + normalization, and the loud once-per-process error
//     when it is missing.
//   · The per-reason log throttle, sized against this repo's 500-deep ring
//     buffer.
// ---------------------------------------------------------------------------
