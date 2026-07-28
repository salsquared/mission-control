// ============================================================================
//  ⚠️  DANGER — READ THIS BEFORE EDITING. DO NOT MEMOIZE A VIEWER. ⚠️
// ============================================================================
//
// `lib/owner.ts` memoizes its result at module level (`let cachedOwner`,
// lib/owner.ts:50). That is CORRECT there: the owner genuinely never changes
// for a process lifetime, so the memo is a pure optimization.
//
// Copying that pattern into this file is a TOTAL AUTHORIZATION BYPASS (design
// doc risk R2). The first request after a restart would populate the memo, and
// every subsequent request — from ANYONE — would be served that identity: a
// crew member's request would return the owner's rows, and the owner's request
// would return a crew member's. There is no partial version of this bug; it is
// a full cross-tenant leak on the first cache fill.
//
// So: v1 uses NO viewer memo at all. One `findUnique` on an indexed unique
// column, against a local SQLite file, is sub-millisecond and is not worth
// risking. If a memo is ever added it must be a bounded Map keyed by email
// with a short TTL, and `scripts/tests/hermetic/viewer-resolution-smoke.ts`
// (which resolves two different header emails back-to-back and asserts two
// different viewers) must still pass.
//
// The ONLY module-level mutable state permitted in this file is:
//   1. `seededViewer` — the explicit `__seedViewer()` test seam (P1.2.4), which
//      no production code path ever writes; and
//   2. the two `…BreakGlassWarned` booleans, which hold a boolean, never an
//      identity, and exist purely to keep a per-request warning from flooding
//      the 500-deep log ring buffer.
// Neither is ever populated by a real request's identity.
//
// ============================================================================
//
// Viewer resolution — the one new chokepoint (docs/multi-user-crew.html §2.3).
//
// Mission-control is multi-user as of the owner/crew work. Cloudflare Access at
// the edge authenticates the human and stamps the verified address onto
// `Cf-Access-Authenticated-User-Email`; this module turns that header into the
// `User` row it names, and nothing else. There is exactly ONE identity source
// and ZERO fallback branches on the normal request path (OQ2a) — in particular
// there is no `resolveOwner()` fallback, which is the whole point: the previous
// design trusted the edge so completely that ANY request reaching the origin
// was served as the owner.
//
// Resolution order:
//   0. `__seedViewer()` test override, if a hermetic smoke armed one.
//   1. Break-glass escapes (P1.2.3) — checked BEFORE the strict path so that
//      P4.2's JWT verification is skipped on them (a loopback request carries
//      no `Cf-Access-Jwt-Assertion` to verify). Off by default.
//   2. Verify `Cf-Access-Jwt-Assertion` (P4.2) — `lib/access-jwt.ts`. Signature,
//      issuer, this hostname's AUD, exp/nbf, and the `email` claim cross-checked
//      against the identity header. Fail-closed: any failure is 401.
//   3. `cf-access-authenticated-user-email` → trim + lowercase → findUnique.
//      Header absent → 401. Row miss → 403 carrying the email + one loud warn.
//
// 401 and 403 are NOT interchangeable, and each is a separately-decided open
// question. 401 means "I do not know who you are" (no identity header, or one
// that fails JWT verification — OQ2a). 403 means "I know exactly who you are,
// and you have no account on this instance" — a verified Access identity with
// no `User` row, which is the deliberate two-step provisioning of OQ3a. A 403
// with a named email in the log is the owner's cue to run
// `scripts/manage-crew.ts add`; a 401 means the edge or the JWT config is
// wrong. Collapsing them destroys that signal, which is why this module returns
// a result union rather than `Viewer | null` — a bare null cannot carry the
// distinction and the guards have no second source for it.
//
// Why `headers()` and not a threaded `req`: `requireSession()` takes no request
// argument and has 72 call sites (104 across all three guards). `next/headers`
// was imported nowhere in this codebase before this file — a new dependency,
// but the standard Route-Handler mechanism, available in Next 16.2.9 (async
// `headers()`), and it keeps this change the same shape as the original
// Cloudflare Access change: rewrite the guards, touch no handler. (OQ1a.)

import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { resolveOwner } from '@/lib/owner';
import { verifyAccessJwt } from '@/lib/access-jwt';

export type Role = 'owner' | 'crew';

export interface Viewer {
    id: string;
    email: string;
    role: Role;
}

// Two distinct failures, two distinct status codes — see the header comment.
export type ViewerResult =
    | { ok: true; viewer: Viewer }
    | { ok: false; status: 401 }                  // no / unverifiable identity (OQ2a)
    | { ok: false; status: 403; email: string };  // verified identity, no User row (OQ3a)

/** The Cloudflare Access identity header. Lowercase — `Headers.get` is case-insensitive. */
const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';

/** Env vars for the two break-glass escapes (P1.2.3). Both OFF by default. */
const DEV_LOOPBACK_ENV = 'MC_DEV_LOOPBACK_OWNER';
const PROD_LOOPBACK_ENV = 'MC_PROD_LOOPBACK_OWNER';

// Minimal structural read seam over the header bag, so the hermetic smoke can
// drive the strict path without booting Next (`headers()` throws outside a
// request scope — see `readRequestHeaders` below). Mirrors the shape of
// `ReadonlyHeaders`, narrowed to the one method this module uses.
export interface ViewerHeaderReader {
    get(name: string): string | null | undefined;
}

// Minimal structural slice of PrismaClient this module needs — lets the
// hermetic smoke inject a deterministic stub instead of depending on dev.db.
// Mirrors `OwnerResolverClient` in `lib/owner.ts`.
export interface ViewerResolverClient {
    user: {
        findUnique(args: {
            where: { email: string };
            select: { id: true; email: true; role: true };
        }): Promise<{ id: string; email: string | null; role: string } | null>;
    };
}

/**
 * Injectable dependencies. Production ALWAYS calls `resolveViewer()` with no
 * argument, exactly as the guards do — these exist only so
 * `viewer-resolution-smoke.ts` can exercise the strict path (two different
 * header emails back-to-back, the unknown-email 403, …) hermetically. They are
 * parameters, not module state: a caller must explicitly pass them, so there is
 * no ambient way to activate them. Same risk profile as `OwnerResolverClient`
 * in `lib/owner.ts`, which the repo already relies on.
 */
export interface ViewerResolverDeps {
    /** Header source. Defaults to `next/headers`' async `headers()`. */
    readHeaders?: () => Promise<ViewerHeaderReader>;
    /** Prisma slice. Defaults to the real extended client. */
    client?: ViewerResolverClient;
}

const DENY_401 = { ok: false, status: 401 } as const satisfies ViewerResult;

// ---------------------------------------------------------------------------
// Test seam (P1.2.4) — see `__seedViewer` below for the three properties that
// keep this from being the memo trap in disguise.
// ---------------------------------------------------------------------------
let seededViewer: Viewer | null = null;

// Warn-once-per-process latches for the break-glass branches. Booleans only —
// these never hold an identity. (One warn per REQUEST would flood the 500-deep
// log ring buffer; one per process is enough to make the escape visible in the
// in-app log viewer.)
let devBreakGlassWarned = false;
let prodBreakGlassWarned = false;

/**
 * Resolve the viewer for the current request.
 *
 * Never throws: every failure mode collapses to a `{ ok: false }` result, so
 * the guards in `lib/auth-guards.ts` can translate rather than defend.
 *
 * @param deps injectable for hermetic tests; defaults to the real
 *   `next/headers` + `prisma`. Production passes nothing.
 */
export async function resolveViewer(deps: ViewerResolverDeps = {}): Promise<ViewerResult> {
    // (0) Test seam. Inert unless a smoke explicitly called `__seedViewer()`.
    if (seededViewer) return { ok: true, viewer: seededViewer };

    const readHeaders = deps.readHeaders ?? readRequestHeaders;
    const client = deps.client ?? (prisma as unknown as ViewerResolverClient);

    let h: ViewerHeaderReader;
    try {
        h = await readHeaders();
    } catch {
        // P1.2.2 — THE OUT-OF-REQUEST-SCOPE CATCH MUST YIELD "NO VIEWER".
        //
        // `headers()` throws outside a request scope. Ten hermetic smokes drive
        // route handlers in-process (`require("@/app/api/…").GET(req)`) and are
        // in exactly that position — `route-auth-smoke.ts:8` documents it
        // verbatim ("Calling a route handler directly from a standalone tsx
        // script throws 'headers() called outside a request scope'").
        //
        // This catch resolves to 401 and NEVER to `resolveOwner()`. Wiring it to
        // an identity "so the smokes pass" would silently reinstate the exact
        // bypass OQ2 exists to remove — and it would do so on a path with no
        // request at all, i.e. reachable from anything that imports a guard.
        // The break-glass branches below are separate, explicit, env-gated
        // branches; they are never this catch block. The smokes are served by
        // the `__seedViewer` seam (P1.2.4), a deliberate injection point rather
        // than a weakened catch.
        return DENY_401;
    }

    // (1) Break-glass escapes. Evaluated BEFORE the strict path so P4.2's JWT
    // check is skipped on them — a loopback request has no
    // `Cf-Access-Jwt-Assertion` to verify, so checking the JWT first would make
    // both escapes dead code and fail the integration suites with a misleading
    // JWT error.
    const breakGlass = await tryBreakGlass(h);
    if (breakGlass) return breakGlass;

    // ------------------------------------------------------------------
    // (2) P4.2 — Cloudflare Access JWT verification (`lib/access-jwt.ts`).
    //
    // Everything below this line trusts a header, and a header is forgeable by
    // anything that can open a TCP connection to the origin. This is the check
    // that makes the strict path mean something: RS256 signature against the
    // team's JWKS, `iss`, this hostname's `aud`, `exp`/`nbf`, and the verified
    // `email` claim cross-checked against the identity header.
    //
    // FAIL-CLOSED and never throws — an absent, forged or expired token, a
    // claim/header mismatch, an unreachable JWKS and unset config ALL land
    // here as `ok: false`, i.e. 401. It never degrades to "trust the header".
    //
    // Placement is load-bearing: AFTER the break-glass branches (a loopback
    // request carries no JWT, so verifying first would make both escapes dead
    // code and fail the integration suites with a misleading JWT error) and
    // BEFORE the identity-header read below. Do not move it.
    // ------------------------------------------------------------------
    const accessJwt = await verifyAccessJwt(h);
    if (!accessJwt.ok) return DENY_401;

    // (3) The strict path. One identity source, zero fallback branches (OQ2a).
    const rawEmail = h.get(ACCESS_EMAIL_HEADER);
    const email = rawEmail?.trim().toLowerCase();
    if (!email) {
        // No identity at all → "I do not know who you are".
        return DENY_401;
    }

    let row: { id: string; email: string | null; role: string } | null;
    try {
        row = await client.user.findUnique({
            where: { email },
            select: { id: true, email: true, role: true },
        });
    } catch (err) {
        // A DB failure is not an identity. Fail closed, but loudly — otherwise a
        // SQLite outage is indistinguishable from "the edge stopped stamping the
        // header", and both surface as a bare 401.
        console.error(`[VIEWER] user lookup failed for ${email} — denying (401):`, err);
        return DENY_401;
    }

    if (!row?.email) {
        // OQ3a — verified identity, no User row (or a row with no email, which
        // is not a usable viewer). This is the deliberate two-step provisioning:
        // Access lets them past the edge, but this instance has no account for
        // them. ONE loud warn naming the email, because it is the owner's cue to
        // run `scripts/manage-crew.ts add <email>`.
        console.warn(
            `[VIEWER] Access-verified identity with no User row: ${email} — denying (403). ` +
            `Provision with: npx tsx scripts/manage-crew.ts add ${email}`,
        );
        return { ok: false, status: 403, email };
    }

    return { ok: true, viewer: { id: row.id, email: row.email, role: normalizeRole(row.role) } };
}

/**
 * Default header source: Next's async `headers()`. Isolated into a named
 * function so the `deps.readHeaders` default reads as a seam rather than an
 * inline lambda, and so the throwing call has exactly one site.
 */
async function readRequestHeaders(): Promise<ViewerHeaderReader> {
    return await headers();
}

/**
 * `User.role` is a plain `String @default("crew")` column, so the DB can hand
 * back anything. Narrow to the union with a least-privilege default: only the
 * exact string `owner` grants owner, and every other value (typo, future role,
 * NULL-ish) degrades to `crew`. Never widen this to a cast.
 */
function normalizeRole(raw: string | null | undefined): Role {
    return raw === 'owner' ? 'owner' : 'crew';
}

// ---------------------------------------------------------------------------
// P1.2.3 — the two break-glass branches.
//
// Removing the LAN fallback removed two things that were load-bearing for
// non-browser use. Each gets a purpose-built escape rather than a general trust
// rule. Both are OFF by default, both require a loopback request, and each
// emits ONE warn per process so the escape is visible in the in-app log viewer
// without flooding the ring buffer.
//
//   1. Dev tier (OQ14a) — the 10 integration suites under
//      `scripts/tests/integration/` all call `http://localhost:4101` with no
//      identity header. Gated THREE ways: `MC_DEV_LOOPBACK_OWNER=1`, a loopback
//      request, and `NODE_ENV !== 'production'` as a hard CODE condition, not a
//      convention — this branch can never fire on prod. Dev is owner-only
//      (OQ12), so it grants nothing that is not already the only identity there.
//
//   2. On-box prod recovery — same shape, its own env var, same guards minus
//      the dev-tier condition. For when the tunnel or Access is down and the
//      owner needs the app from the console. Setting it is a deliberate act
//      with a log line attached.
//
// Both are documented commented-out in the `.env.*.example` files only — never
// in a loaded `.env`.
// ---------------------------------------------------------------------------
async function tryBreakGlass(h: ViewerHeaderReader): Promise<ViewerResult | null> {
    const devArmed = process.env[DEV_LOOPBACK_ENV] === '1';
    const prodArmed = process.env[PROD_LOOPBACK_ENV] === '1';
    if (!devArmed && !prodArmed) return null;

    // A break-glass request is by definition an identity-less one: the console
    // (no Access header) or an integration suite hitting :4101 directly. If the
    // edge DID stamp an identity, resolve it strictly — including P4.2's JWT
    // check — instead of shortcutting to the owner. This only narrows the
    // escape; it cannot make it dead code, because neither the console nor the
    // suites ever carry that header.
    if (h.get(ACCESS_EMAIL_HEADER)?.trim()) return null;

    if (!isLoopbackRequest(h)) return null;

    const isDevTier = process.env.NODE_ENV !== 'production';

    if (devArmed && isDevTier) {
        if (!devBreakGlassWarned) {
            devBreakGlassWarned = true;
            console.warn(
                `[VIEWER] BREAK-GLASS ACTIVE: ${DEV_LOOPBACK_ENV}=1 — loopback requests on this ` +
                `non-production tier resolve to the owner with no Access identity. ` +
                `Intended for scripts/tests/integration only. Unset it to restore the strict path.`,
            );
        }
        return await ownerViewer();
    }

    if (prodArmed) {
        if (!prodBreakGlassWarned) {
            prodBreakGlassWarned = true;
            console.warn(
                `[VIEWER] BREAK-GLASS ACTIVE: ${PROD_LOOPBACK_ENV}=1 — on-box loopback requests ` +
                `resolve to the owner with no Access identity. This is the tunnel/Access-outage ` +
                `recovery escape; unset it as soon as the edge is healthy.`,
            );
        }
        return await ownerViewer();
    }

    // Dev var armed but NODE_ENV === 'production' (or the reverse): deliberately
    // no escape, and deliberately no log — this is the hard code condition.
    return null;
}

/**
 * The break-glass identity. `resolveOwner()` is the one remaining sanctioned
 * caller shape for "the owner's identity in a context with no request" (the
 * scheduler's session-less reads are the other). It selects on
 * `role = 'owner'`, so the role is known without a second lookup. Zero owners
 * (a migration whose backfill never ran) → 401 rather than a fabricated
 * identity.
 */
async function ownerViewer(): Promise<ViewerResult> {
    const owner = await resolveOwner();
    if (!owner) {
        console.error('[VIEWER] break-glass fired but resolveOwner() found no owner — denying (401).');
        return DENY_401;
    }
    return { ok: true, viewer: { id: owner.id, email: owner.email, role: 'owner' } };
}

// ---------------------------------------------------------------------------
// Loopback detection — an HONEST approximation, and here is exactly how.
//
// `resolveViewer()` takes no `req` argument (that is the whole point of OQ1a:
// 104 guard call sites, none of which thread a request), so there is no socket
// to read `remoteAddress` from. The only signal available through `headers()`
// is `x-forwarded-for`, which Next's Node server sets from the socket itself
// when the client did not supply one:
//
//     req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress
//     (node_modules/next/dist/server/base-server.js:577)
//
// Note the `??=`: a client-supplied XFF is PRESERVED, not overwritten. So this
// value is trustworthy only insofar as the sender is. Three consequences, all
// handled below:
//
//   1. A request proxied by cloudflared arrives on the loopback socket (the
//      tunnel runs on this box), so the SOCKET address alone would say
//      "loopback" for every tunnelled request on the internet. It is not a
//      usable signal by itself. Cloudflare, however, always sets
//      `CF-Connecting-IP` and `CF-Ray` on the proxied request and overwrites
//      any client-supplied copies — so the presence of either is positive
//      evidence the request came through the edge, and disqualifies it.
//   2. Cloudflare APPENDS the real client IP to any XFF the client sent, so a
//      remote attacker spoofing `X-Forwarded-For: 127.0.0.1` produces the chain
//      `127.0.0.1, <real ip>`. We therefore require EVERY hop in the chain to
//      be loopback, not just the first or last.
//   3. A missing XFF proves nothing, so it FAILS CLOSED rather than passing.
//
// The residual limitation, stated plainly: a host that can open a TCP
// connection directly to the origin port (i.e. anything on the LAN, until P4.1
// binds the listener to loopback) can forge `X-Forwarded-For: 127.0.0.1` with
// no CF headers and satisfy this check. That is a real gap, it is bounded by
// (a) both env vars being off by default and (b) P4.1's loopback bind closing
// it structurally, and it is documented here rather than papered over. What
// this check does NOT do is silently always pass — every one of the four
// conditions above can and does reject.
// ---------------------------------------------------------------------------
function isLoopbackRequest(h: ViewerHeaderReader): boolean {
    // Any Cloudflare proxy marker ⇒ the request came through the edge.
    if (h.get('cf-connecting-ip')?.trim() || h.get('cf-ray')?.trim()) return false;

    const xff = h.get('x-forwarded-for')?.trim();
    if (!xff) return false; // fail closed — absence is not evidence of loopback

    const hops = xff.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length === 0) return false;
    return hops.every(isLoopbackAddress);
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopbackAddress(raw: string): boolean {
    let addr = raw.trim().toLowerCase();
    if (!addr) return false;

    // "[::1]:1234" → "::1"
    if (addr.startsWith('[')) {
        const end = addr.indexOf(']');
        if (end === -1) return false;
        addr = addr.slice(1, end);
    } else if ((addr.match(/:/g) ?? []).length === 1) {
        // "127.0.0.1:1234" → "127.0.0.1" (a lone colon can't be IPv6)
        addr = addr.slice(0, addr.indexOf(':'));
    }

    // IPv4-mapped IPv6: "::ffff:127.0.0.1"
    if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);

    return addr === '::1' || addr === '0:0:0:0:0:0:0:1' || LOOPBACK_V4.test(addr);
}

// ---------------------------------------------------------------------------
// P1.2.4 — the test seam.
// ---------------------------------------------------------------------------

/**
 * Test seam — force `resolveViewer()` to return `viewer` for every call until
 * `__resetViewer()` (or `__seedViewer(null)`) clears it. Mirrors
 * `lib/owner.ts`'s `__seedOwnerMemo` / `__resetOwnerMemo`, the seam nine of the
 * affected hermetic smokes already import.
 *
 * Why it exists: ten hermetic smokes drive real route handlers in-process
 * (`require("@/app/api/…").GET(req)`). Once P1.3.2 repoints the guards at
 * `resolveViewer()`, every one of those calls hits `headers()` outside a
 * request scope → the catch → 401, and the pre-push gate goes red. The
 * break-glass branches cannot rescue them: an in-process handler call has no
 * socket and therefore no remote address, so the loopback check can never pass.
 * This seam is the deliberate injection point that keeps them green.
 *
 * Three properties keep this from being the memoization trap in disguise:
 *
 *   1. IT IS NOT A MEMO. A seeded viewer is a test override, never populated by
 *      a real request — no production code path writes `seededViewer` — so the
 *      "first request's identity serves everyone" failure mode has no path to
 *      occur. The no-memo rule for the real resolution path is unchanged.
 *   2. IT IS INERT UNLESS SEEDED. No env var, no implicit activation: the strict
 *      path runs unless a test explicitly called `__seedViewer`. Nothing in
 *      production ever calls it, exactly as nothing in production calls
 *      `__seedOwnerMemo` today.
 *   3. THE `__` PREFIX IS THE REPO'S "TEST SEAM, NOT API" MARKER, which makes
 *      `grep -rn '__seedViewer' app lib components scheduler` a one-line check
 *      for accidental production use.
 *
 * `viewer-resolution-smoke.ts` (P1.4.1) asserts both halves of property 2: an
 * unseeded resolver takes the strict path, and `__resetViewer()` restores it —
 * so a seam left armed by one smoke cannot leak into another.
 */
export function __seedViewer(viewer: Viewer | null): void {
    seededViewer = viewer;
}

/**
 * Test seam — clear any seeded viewer, restoring the strict path. Call this in
 * a `finally` (or between fixture phases) so one smoke cannot leak a seeded
 * identity into the next. Production code never calls this.
 */
export function __resetViewer(): void {
    seededViewer = null;
}
