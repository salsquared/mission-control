/**
 * Hermetic smoke for `lib/viewer.ts:resolveViewer()` — the one new chokepoint of
 * the multi-user owner/crew model (docs/multi-user-crew.html §2.3, task P1.4.1).
 *
 *   npx tsx scripts/tests/hermetic/viewer-resolution-smoke.ts
 *
 * THE MEMO TRAP IS THE POINT OF THIS FILE. `lib/owner.ts` memoizes its result at
 * module level and is right to; copying that into `resolveViewer()` is a total
 * authorization bypass (design-doc risk R2) — the first request after a restart
 * would fill the memo and every subsequent viewer would be served that identity.
 * Section 1 below resolves several different verified emails back-to-back and
 * asserts each gets its OWN viewer, and that the DB was consulted once per call.
 * If a future edit adds a viewer memo, that section is the tripwire.
 *
 * The other properties under test, each a separately-decided open question:
 *   1. No viewer memo (R2)                        — §1
 *   2. 401 vs 403 are never collapsed (OQ2a/OQ3a) — §2
 *   3. Out-of-request-scope yields NO identity     — §3
 *   4. Break-glass is inert unless armed (P1.2.3)  — §4
 *   5. The `__seedViewer` seam is inert unless seeded, and `__resetViewer()`
 *      restores the strict path (P1.2.4)           — §5
 *
 * FULLY HERMETIC — NO NETWORK, NO PM2, NO dev.db:
 *   · The header bag and the Prisma slice go in through `resolveViewer`'s
 *     `deps` parameter (`readHeaders` / `client`), so no request scope and no
 *     database are required.
 *   · The strict path runs the REAL `lib/access-jwt.ts` verifier — a stubbed-out
 *     JWT check would let this file "pass" while the header was trusted bare.
 *     Cloudflare's JWKS is never fetched: `globalThis.fetch` is replaced with a
 *     stub that serves a throwaway local RSA public key and THROWS on any other
 *     URL, so an accidental network call fails the suite instead of hiding in it.
 *   · The two break-glass branches reach `resolveOwner()`, which is short-
 *     circuited by `__seedOwnerMemo()` — a memo hit returns before any DB access.
 */

// Belt-and-braces: lib/viewer imports lib/prisma. Point it at a throwaway path
// so an unexpected query fails loudly instead of touching dev.db. No query is
// ever issued — every DB read goes through the injected stub, and the owner
// lookup is served from the seeded memo.
process.env.DATABASE_URL = `file:/tmp/viewer-resolution-smoke-${process.pid}.db`;
// §1–§3 and §5 assert the STRICT path, so both escapes must start disarmed.
// The pre-push hook may run in a shell that has one armed (P5.1.3).
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import {
    resolveViewer,
    __seedViewer,
    __resetViewer,
    type Viewer,
    type ViewerHeaderReader,
    type ViewerResolverClient,
    type ViewerResult,
} from '@/lib/viewer';
import { __seedOwnerMemo, __resetOwnerMemo } from '@/lib/owner';
import { __resetAccessJwtState } from '@/lib/access-jwt';

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ''); fails++; }
function check(msg: string, cond: boolean, detail?: unknown) { cond ? pass(msg) : fail(msg, detail); }

// --- fixture constants -------------------------------------------------------

const TEAM = 'test-team.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'a'.repeat(64);
const KID = 'viewer-smoke-key-1';
const JWKS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

const OWNER_ADDR = 'owner@viewer-smoke.invalid';
const CREW_EMAIL_FIX = 'crew@viewer-smoke.invalid';
const CREW2_EMAIL_FIX = 'crew2@viewer-smoke.invalid';
const GHOST_EMAIL_FIX = 'ghost@viewer-smoke.invalid';   // Access-verified, no User row

const JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

/** The break-glass owner, served from the memo so no DB is touched. */
const BREAK_GLASS_OWNER = { id: 'u-owner-viewer-smoke', email: OWNER_ADDR };

type Row = { id: string; email: string | null; role: string };

const ROWS: Row[] = [
    { id: 'u-owner-viewer-smoke', email: OWNER_ADDR, role: 'owner' },
    { id: 'u-crew-viewer-smoke', email: CREW_EMAIL_FIX, role: 'crew' },
    { id: 'u-crew2-viewer-smoke', email: CREW2_EMAIL_FIX, role: 'crew' },
];

/** Case-insensitive header bag, like the real `Headers`. */
function headerBag(bag: Record<string, string | undefined>): ViewerHeaderReader {
    const lower = new Map(
        Object.entries(bag)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k.toLowerCase(), v as string]),
    );
    return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/**
 * Deterministic stand-in for the `user` delegate. Counts lookups so §1 can prove
 * the resolver hits the DB once PER CALL — the observable signature of "no memo".
 */
function stubClient(rows: Row[], override?: (email: string) => Row | null) {
    const calls = { findUnique: 0 };
    const seen: string[] = [];
    const client: ViewerResolverClient = {
        user: {
            async findUnique({ where }) {
                calls.findUnique++;
                seen.push(where.email);
                if (override) return override(where.email);
                return rows.find((r) => r.email === where.email) ?? null;
            },
        },
    };
    return { client, calls, seen };
}

/** Narrow a result to its viewer, or `null` — keeps the assertions one-liners. */
function viewerOf(r: ViewerResult): Viewer | null {
    return r.ok ? r.viewer : null;
}

/** `{ ok: false, status }` → the status; `null` when the call admitted. */
function denyStatus(r: ViewerResult): number | null {
    return r.ok ? null : r.status;
}

// `NODE_ENV` is typed narrowly by next-env.d.ts; §4 has to flip it to prove the
// dev escape's hard code condition, so go through the widened view.
const mutableEnv = process.env as Record<string, string | undefined>;
function setNodeEnv(value: string | undefined): void {
    if (value === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = value;
}

async function main() {
    const teamKeys = await generateKeyPair('RS256', { extractable: true });
    const publicJwk: JWK = { ...(await exportJWK(teamKeys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

    // --- network lockdown: serve the JWKS locally, throw on anything else ----
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetched.push(url);
        if (url !== JWKS_URL) {
            throw new Error(`viewer-resolution-smoke made a NON-HERMETIC network call to ${url}`);
        }
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof globalThis.fetch;

    // Point the real verifier at the fixture team/AUD and drop any memoized key
    // set so the stubbed fetch (not a leftover) serves the keys.
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
    process.env.CF_ACCESS_AUD = AUD;
    __resetAccessJwtState();

    /** Mint an RS256 token exactly as the tier's Access app would. */
    async function mint(email: string): Promise<string> {
        const now = Math.floor(Date.now() / 1000);
        return await new SignJWT({ email, type: 'app' })
            .setProtectedHeader({ alg: 'RS256', kid: KID })
            .setIssuer(ISSUER)
            .setAudience(AUD)
            .setIssuedAt(now)
            .setNotBefore(now - 60)
            .setExpirationTime(now + 3600)
            .sign(teamKeys.privateKey);
    }

    /** A fully Access-shaped request: verified JWT + matching identity header. */
    async function accessHeaders(email: string, extra: Record<string, string> = {}) {
        return headerBag({ [JWT_HEADER]: await mint(email), [EMAIL_HEADER]: email, ...extra });
    }

    const originalNodeEnv = process.env.NODE_ENV;

    try {
        // ════════════════════════════════════════════════════════════════════
        // §1 — THE MEMO TRAP (R2). The most important section in this file.
        // ════════════════════════════════════════════════════════════════════
        {
            const { client, calls, seen } = stubClient(ROWS);
            const readOwner = await accessHeaders(OWNER_ADDR);
            const readCrew = await accessHeaders(CREW_EMAIL_FIX);

            // Back-to-back, no reset of any kind between them.
            const first = await resolveViewer({ readHeaders: async () => readOwner, client });
            const second = await resolveViewer({ readHeaders: async () => readCrew, client });

            check(
                'R2: two different header emails back-to-back → two DIFFERENT viewers',
                viewerOf(first)?.id === 'u-owner-viewer-smoke' &&
                viewerOf(second)?.id === 'u-crew-viewer-smoke',
                { first: viewerOf(first), second: viewerOf(second) },
            );
            check(
                'R2: the second viewer carries its OWN email (not the first request\'s)',
                viewerOf(second)?.email === CREW_EMAIL_FIX,
                viewerOf(second),
            );
            check(
                'R2: the second viewer carries its OWN role (a memo would leak owner→crew)',
                viewerOf(first)?.role === 'owner' && viewerOf(second)?.role === 'crew',
                { first: viewerOf(first)?.role, second: viewerOf(second)?.role },
            );

            // A third, then the FIRST email again — a memo keyed on "already
            // resolved once" would serve a stale identity on the repeat.
            const third = await resolveViewer({
                readHeaders: async () => await accessHeaders(CREW2_EMAIL_FIX),
                client,
            });
            const repeat = await resolveViewer({ readHeaders: async () => readOwner, client });
            check(
                'R2: a third email resolves to itself, and re-resolving the first still returns the first',
                viewerOf(third)?.id === 'u-crew2-viewer-smoke' && viewerOf(repeat)?.id === 'u-owner-viewer-smoke',
                { third: viewerOf(third), repeat: viewerOf(repeat) },
            );
            check(
                'R2: the DB is consulted once PER CALL (4 resolutions → 4 lookups; a memo would show fewer)',
                calls.findUnique === 4,
                { calls, seen },
            );
            check(
                'R2: each lookup used its own request\'s email',
                seen.join(',') === [OWNER_ADDR, CREW_EMAIL_FIX, CREW2_EMAIL_FIX, OWNER_ADDR].join(','),
                seen,
            );
        }

        // Header normalization — mixed case / padding resolves the same row, so
        // a viewer cannot be duplicated (or missed) by the shape of the header.
        {
            const { client } = stubClient(ROWS);
            const h = headerBag({
                [JWT_HEADER]: await mint(CREW_EMAIL_FIX),
                [EMAIL_HEADER]: `  Crew@Viewer-Smoke.INVALID `,
            });
            const res = await resolveViewer({ readHeaders: async () => h, client });
            check(
                'strict path: identity header is trimmed + lowercased before lookup',
                viewerOf(res)?.id === 'u-crew-viewer-smoke',
                res,
            );
        }

        // ════════════════════════════════════════════════════════════════════
        // §2 — 401 vs 403 ARE NEVER COLLAPSED (OQ2a vs OQ3a).
        // ════════════════════════════════════════════════════════════════════
        {
            // No identity at all → "I do not know who you are".
            const { client, calls } = stubClient(ROWS);
            const res = await resolveViewer({ readHeaders: async () => headerBag({}), client });
            check('no identity header → 401', denyStatus(res) === 401, res);
            check('no identity header → carries no viewer and no email', !res.ok && !('email' in res), res);
            check('no identity header → no DB lookup at all', calls.findUnique === 0, calls);
        }
        {
            // A verified identity with NO User row is 403 CARRYING THE EMAIL —
            // not 401. Collapsing them loses the owner's cue to provision.
            const { client, calls } = stubClient(ROWS);
            const h = await accessHeaders(GHOST_EMAIL_FIX);
            const res = await resolveViewer({ readHeaders: async () => h, client });
            check('Access-verified email with no User row → 403 (NOT 401)', denyStatus(res) === 403, res);
            check(
                'the 403 carries the unprovisioned email',
                !res.ok && res.status === 403 && res.email === GHOST_EMAIL_FIX,
                res,
            );
            check('the 403 case did query the DB (it is a miss, not a short-circuit)', calls.findUnique === 1, calls);
        }
        {
            // A row with a null email is not a usable viewer: 403, never a
            // half-populated `Viewer` and never a throw.
            const { client } = stubClient(ROWS, () => ({ id: 'u-nullmail', email: null, role: 'owner' }));
            const h = await accessHeaders(CREW_EMAIL_FIX);
            const res = await resolveViewer({ readHeaders: async () => h, client });
            check('User row with a NULL email → 403, not a viewer', denyStatus(res) === 403, res);
        }
        {
            // The identity header without a JWT is exactly the forgery shape.
            // It must be 401 ("I cannot verify you"), NOT 403 ("I know you, you
            // just have no row") — and certainly not a viewer.
            const { client, calls } = stubClient(ROWS);
            const h = headerBag({ [EMAIL_HEADER]: OWNER_ADDR });   // no JWT
            const res = await resolveViewer({ readHeaders: async () => h, client });
            check('bare identity header with no Access JWT → 401 (forgery path)', denyStatus(res) === 401, res);
            check('unverified header never reaches the user lookup', calls.findUnique === 0, calls);
        }
        {
            // A DB failure is not an identity — fail closed rather than throw.
            const { client } = stubClient(ROWS, () => { throw new Error('simulated SQLite failure'); });
            const h = await accessHeaders(OWNER_ADDR);
            let threw = false;
            let res: ViewerResult | null = null;
            try { res = await resolveViewer({ readHeaders: async () => h, client }); } catch { threw = true; }
            check('user lookup failure → 401, and resolveViewer never throws', !threw && denyStatus(res!) === 401, { threw, res });
        }

        // ════════════════════════════════════════════════════════════════════
        // §3 — OUT-OF-REQUEST-SCOPE YIELDS NO IDENTITY (P1.2.2).
        // ════════════════════════════════════════════════════════════════════
        {
            // `headers()` throws outside a request scope — the position ten
            // hermetic smokes and the scheduler are in.
            const { client, calls } = stubClient(ROWS);
            const throwingRead = async (): Promise<ViewerHeaderReader> => {
                throw new Error('headers() was called outside a request scope');
            };
            let threw = false;
            let res: ViewerResult | null = null;
            try { res = await resolveViewer({ readHeaders: throwingRead, client }); } catch { threw = true; }
            check('headers() throwing → 401, never a throw out of resolveViewer', !threw && denyStatus(res!) === 401, { threw, res });
            check('headers() throwing → no user lookup (no fallback identity is sought)', calls.findUnique === 0, calls);

            // THE TEETH: with an owner sitting in the memo, the catch STILL
            // yields 401. Wiring it to resolveOwner() "so the smokes pass" is
            // the exact bypass OQ2 removed, on a path with no request at all.
            __seedOwnerMemo(BREAK_GLASS_OWNER);
            try {
                const withOwner = await resolveViewer({ readHeaders: throwingRead, client });
                check(
                    'headers() throwing → 401 EVEN WITH an owner resolvable (no resolveOwner fallback)',
                    denyStatus(withOwner) === 401,
                    withOwner,
                );
            } finally {
                __resetOwnerMemo();
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // §4 — BREAK-GLASS IS INERT UNLESS ARMED (P1.2.3).
        // ════════════════════════════════════════════════════════════════════
        // A loopback, identity-less request: exactly what an integration suite
        // or an on-box console request looks like.
        const loopback = headerBag({ 'x-forwarded-for': '127.0.0.1' });
        {
            const { client } = stubClient(ROWS);
            __seedOwnerMemo(BREAK_GLASS_OWNER);   // an owner IS resolvable…
            try {
                delete process.env.MC_DEV_LOOPBACK_OWNER;
                delete process.env.MC_PROD_LOOPBACK_OWNER;
                const res = await resolveViewer({ readHeaders: async () => loopback, client });
                check(
                    'break-glass DISARMED: loopback + no identity → 401 (both branches inert)',
                    denyStatus(res) === 401,
                    res,
                );
            } finally {
                __resetOwnerMemo();
            }
        }
        {
            // Positive control — without it the "inert" assertions above could
            // pass on a branch that is simply dead.
            const { client } = stubClient(ROWS);
            __seedOwnerMemo(BREAK_GLASS_OWNER);
            try {
                process.env.MC_DEV_LOOPBACK_OWNER = '1';
                setNodeEnv('development');
                const res = await resolveViewer({ readHeaders: async () => loopback, client });
                check(
                    'break-glass ARMED (dev tier): loopback + no identity → the owner',
                    viewerOf(res)?.id === BREAK_GLASS_OWNER.id && viewerOf(res)?.role === 'owner',
                    res,
                );

                // The hard code condition: the DEV escape can never fire on prod.
                setNodeEnv('production');
                const onProd = await resolveViewer({ readHeaders: async () => loopback, client });
                check(
                    'dev break-glass does NOT fire when NODE_ENV=production (hard code condition)',
                    denyStatus(onProd) === 401,
                    onProd,
                );

                // Armed, dev tier, but the request is not loopback → no escape.
                setNodeEnv('development');
                const remote = await resolveViewer({
                    readHeaders: async () => headerBag({ 'x-forwarded-for': '203.0.113.9' }),
                    client,
                });
                check('dev break-glass does NOT fire for a non-loopback request', denyStatus(remote) === 401, remote);

                // Armed, loopback — but the request came through the edge.
                const viaEdge = await resolveViewer({
                    readHeaders: async () => headerBag({ 'x-forwarded-for': '127.0.0.1', 'cf-ray': 'abc123-SJC' }),
                    client,
                });
                check('dev break-glass does NOT fire when a Cloudflare proxy marker is present', denyStatus(viaEdge) === 401, viaEdge);

                // Armed, loopback — but the request DOES carry an identity. It
                // must resolve strictly (JWT + row), not shortcut to the owner.
                const withIdentity = await resolveViewer({
                    readHeaders: async () => await accessHeaders(CREW_EMAIL_FIX, { 'x-forwarded-for': '127.0.0.1' }),
                    client,
                });
                check(
                    'break-glass yields to a real identity: loopback + Access headers → that crew viewer, not the owner',
                    viewerOf(withIdentity)?.id === 'u-crew-viewer-smoke' && viewerOf(withIdentity)?.role === 'crew',
                    withIdentity,
                );
            } finally {
                delete process.env.MC_DEV_LOOPBACK_OWNER;
                setNodeEnv(originalNodeEnv);
                __resetOwnerMemo();
            }
        }
        {
            // The prod recovery escape: its own var, and it is NOT gated on the
            // tier — but it is still inert until explicitly armed.
            const { client } = stubClient(ROWS);
            __seedOwnerMemo(BREAK_GLASS_OWNER);
            try {
                setNodeEnv('production');
                const disarmed = await resolveViewer({ readHeaders: async () => loopback, client });
                check('prod break-glass DISARMED: loopback on prod → 401', denyStatus(disarmed) === 401, disarmed);

                process.env.MC_PROD_LOOPBACK_OWNER = '1';
                const armed = await resolveViewer({ readHeaders: async () => loopback, client });
                check(
                    'prod break-glass ARMED: loopback on prod → the owner',
                    viewerOf(armed)?.id === BREAK_GLASS_OWNER.id,
                    armed,
                );
            } finally {
                delete process.env.MC_PROD_LOOPBACK_OWNER;
                setNodeEnv(originalNodeEnv);
                __resetOwnerMemo();
            }
        }
        {
            // Armed with NO resolvable owner (a migration whose backfill never
            // ran, or an unreachable DB): NEVER a fabricated identity.
            //
            // `resolveOwner()` takes no injectable client here — the break-glass
            // branch calls it with the real prisma — so with the throwaway
            // DATABASE_URL this run raises rather than returning null. Both
            // outcomes are "no viewer", which is the property under test, so the
            // assertion covers them together instead of pinning one.
            //
            // Worth knowing, and NOT papered over: a raise means `resolveViewer`'s
            // "never throws" contract holds for the strict path but not for an
            // ARMED break-glass branch whose DB read fails, so the guards would
            // 500 rather than 401 in that (env-gated, off-by-default) corner.
            const { client } = stubClient(ROWS);
            __resetOwnerMemo();
            let admitted: Viewer | null = null;
            let raised: unknown = null;
            try {
                process.env.MC_DEV_LOOPBACK_OWNER = '1';
                setNodeEnv('development');
                admitted = viewerOf(await resolveViewer({ readHeaders: async () => loopback, client }));
            } catch (e) {
                raised = e;
            } finally {
                delete process.env.MC_DEV_LOOPBACK_OWNER;
                setNodeEnv(originalNodeEnv);
                __resetOwnerMemo();
            }
            check(
                'break-glass ARMED but no owner resolvable → never a viewer',
                admitted === null,
                { admitted, raised: raised ? String(raised) : null },
            );
        }

        // ════════════════════════════════════════════════════════════════════
        // §5 — THE `__seedViewer` SEAM (P1.2.4): inert unless seeded, and
        //      `__resetViewer()` restores the strict path so one smoke cannot
        //      leak a seeded identity into the next.
        // ════════════════════════════════════════════════════════════════════
        {
            const { client, calls } = stubClient(ROWS);
            const crewHeaders = await accessHeaders(CREW_EMAIL_FIX);

            // (a) Unseeded ⇒ the strict path runs. No env var, no implicit arming.
            const beforeSeed = await resolveViewer({ readHeaders: async () => crewHeaders, client });
            check(
                'seam: with NO seed the strict path runs (header identity wins)',
                viewerOf(beforeSeed)?.id === 'u-crew-viewer-smoke',
                beforeSeed,
            );

            // (b) Seeded ⇒ the override wins over ANY headers, with no DB read.
            const seeded: Viewer = { id: 'u-seeded', email: 'seeded@viewer-smoke.invalid', role: 'owner' };
            __seedViewer(seeded);
            const lookupsBefore = calls.findUnique;
            const whileSeeded = await resolveViewer({ readHeaders: async () => crewHeaders, client });
            check(
                'seam: __seedViewer overrides the strict path',
                viewerOf(whileSeeded)?.id === 'u-seeded' && viewerOf(whileSeeded)?.role === 'owner',
                whileSeeded,
            );
            check('seam: a seeded resolution performs no DB lookup', calls.findUnique === lookupsBefore, calls);

            // …including on requests that would otherwise 401 outright.
            const seededNoHeaders = await resolveViewer({
                readHeaders: async () => { throw new Error('headers() outside a request scope'); },
                client,
            });
            check(
                'seam: a seeded viewer survives an out-of-request-scope call (this is what keeps the 10 route smokes green)',
                viewerOf(seededNoHeaders)?.id === 'u-seeded',
                seededNoHeaders,
            );

            // (c) Reset ⇒ the strict path is restored, with no residue.
            __resetViewer();
            const afterReset = await resolveViewer({ readHeaders: async () => crewHeaders, client });
            check(
                'seam: __resetViewer() restores the strict path',
                viewerOf(afterReset)?.id === 'u-crew-viewer-smoke',
                afterReset,
            );
            const afterResetNoIdentity = await resolveViewer({ readHeaders: async () => headerBag({}), client });
            check(
                'seam: after __resetViewer() an identity-less request 401s (no stale seeded identity leaks)',
                denyStatus(afterResetNoIdentity) === 401,
                afterResetNoIdentity,
            );

            // (d) `__seedViewer(null)` is equivalent to a reset.
            __seedViewer(seeded);
            __seedViewer(null);
            const afterNullSeed = await resolveViewer({ readHeaders: async () => headerBag({}), client });
            check(
                'seam: __seedViewer(null) also restores the strict path',
                denyStatus(afterNullSeed) === 401,
                afterNullSeed,
            );
        }

        // The JWKS came from the local stub and nothing else was contacted.
        check(
            `no network beyond the stubbed JWKS (fetched: ${fetched.length})`,
            fetched.length > 0 && fetched.every((u) => u === JWKS_URL),
            fetched,
        );
    } finally {
        __resetViewer();
        __resetOwnerMemo();
        __resetAccessJwtState();
        setNodeEnv(originalNodeEnv);
        globalThis.fetch = realFetch;
    }
}

/**
 * The exit path lives OUT here, not at the bottom of `main()`, so that no future
 * early `return` inside the body can skip it. `resume-list-smoke.ts` had exactly
 * that bug — it printed `[FAIL]` and still exited 0, which the pre-push gate
 * reads as a pass.
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log('All checks passed.');
    process.exit(0);
}

main().then(finish, (e) => {
    console.error('smoke crashed:', e);
    process.exit(2);
});
