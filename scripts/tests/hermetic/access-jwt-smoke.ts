/**
 * Hermetic smoke for Cloudflare Access JWT verification — Layer 2 of the
 * header-authenticity fix (lib/access-jwt.ts; docs/multi-user-crew.html §2.7,
 * task P4.2).
 *
 *   npx tsx scripts/tests/hermetic/access-jwt-smoke.ts
 *
 * FULLY HERMETIC — NO NETWORK. Cloudflare's JWKS is never fetched: the smoke
 * generates its own throwaway RSA keypair with `jose` and injects a LOCAL key
 * set through `verifyAccessJwt`'s `deps.getKey` seam (the same
 * parameters-not-module-state pattern `lib/viewer.ts` and `lib/owner.ts`
 * already use). A smoke that reached out to salsquared.cloudflareaccess.com
 * would fail the pre-push gate on a plane, and would make an Access outage look
 * like a code regression.
 *
 * The property under test is fail-closed: every failure mode — forged header,
 * expired token, wrong audience, wrong issuer, unknown signing key, algorithm
 * confusion, tampered identity, unreachable JWKS, unset config — must produce
 * NO VIEWER. Scenario 1 is the positive control, and it is the most important
 * assertion in the file: a verifier that denies everything also "passes" a
 * deny-only suite while locking the owner out of their own instance.
 *
 * Scenarios:
 *    1. Positive control — valid token, matching identity → ok (and the
 *       header/claim comparison is case- and whitespace-insensitive).
 *    2. Forged identity header with NO JWT → deny. This is the forgery path
 *       the whole task exists to close.
 *    3. Expired token (exp in the past) → deny.
 *    4. Not-yet-valid token (nbf in the future) → deny.
 *    5. Claim/header email mismatch → deny (tampering).
 *    6. Wrong audience — a token minted for the OTHER tier's Access app → deny.
 *    7. Wrong issuer — a different team domain → deny.
 *    8. Unknown signing key — a well-formed token from a foreign keypair → deny.
 *    9. Algorithm confusion — an HS256 token → deny (RS256 only).
 *   10. Verified token with no `email` claim → deny.
 *   11. JWT present but identity header absent → deny (nothing to cross-check).
 *   12. Unconfigured tier (no team domain / AUD) → deny, NOT admit.
 *   13. Unreachable JWKS → deny (fail-closed; never degrades to the header).
 *   14. Config drift — both tracked .env.*.example files declare the recorded
 *       team domain + their own AUD, and the two AUDs differ. An Access app
 *       rebuild rotates its AUD, and a stale AUD in a fail-closed verifier is a
 *       total lockout, so a rotation must surface in the pre-push gate rather
 *       than in production (P4.2.4).
 *   15. End-to-end through resolveViewer() — a forged identity header with no
 *       JWT resolves to { ok: false, status: 401 }, i.e. no viewer, with the
 *       break-glass escapes disarmed.
 */

// Belt-and-braces: if some transitive import pulls lib/prisma (scenario 15
// imports lib/viewer, which imports it), point it at a non-existent throwaway
// file rather than dev.db. No query is ever issued — scenario 15 denies at the
// JWT step, before the user lookup.
process.env.DATABASE_URL = `file:/tmp/access-jwt-smoke-${process.pid}.db`;
// Scenario 15 asserts the STRICT path, so both break-glass escapes must be off
// (the pre-push hook may run with MC_DEV_LOOPBACK_OWNER armed — P5.1.3).
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    SignJWT,
    createLocalJWKSet,
    exportJWK,
    generateKeyPair,
    generateSecret,
    type JWTVerifyGetKey,
    type JWK,
} from 'jose';
import {
    verifyAccessJwt,
    __resetAccessJwtState,
    type AccessJwtDenyReason,
    type AccessJwtHeaderReader,
} from '@/lib/access-jwt';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ''); fails++; }
function check(msg: string, cond: boolean, detail?: unknown) { cond ? pass(msg) : fail(msg, detail); }

// --- fixture constants -------------------------------------------------------

const TEAM = 'test-team.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'a'.repeat(64);          // this tier's Access application
const OTHER_AUD = 'b'.repeat(64);    // the other tier's Access application
const EMAIL = 'crew@example.com';
const KID = 'test-signing-key-1';

// The live values recorded in docs/multi-user-crew.html §2.7, re-read from the
// public Access login redirect on 2026-07-27. Scenario 14 pins them.
const LIVE_TEAM_DOMAIN = 'salsquared.cloudflareaccess.com';
const LIVE_AUD_PROD = '2ed7bc0e82620032d1b9b2cd3ef1f028c554cf3635e147a73f16f158cfb4b10f';
const LIVE_AUD_DEV = '3f95011a1cdada25918c7b92aca8bec36590d0ca0c10da3e95da1e5146a37c96';

/** Header bag stub. Case-insensitive, like the real `Headers`. */
function headers(bag: Record<string, string | undefined>): AccessJwtHeaderReader {
    const lower = new Map(
        Object.entries(bag)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k.toLowerCase(), v as string]),
    );
    return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

const JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

async function main() {
    // Throwaway signing key (the "team") + a foreign one (an attacker's).
    const teamKeys = await generateKeyPair('RS256', { extractable: true });
    const foreignKeys = await generateKeyPair('RS256', { extractable: true });

    const publicJwk: JWK = { ...(await exportJWK(teamKeys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
    const localJwks = createLocalJWKSet({ keys: [publicJwk] }) as unknown as JWTVerifyGetKey;

    const deps = { getKey: localJwks, teamDomain: TEAM, aud: AUD };

    /** Mint an RS256 token as the team's Access app would. */
    async function mint(claims: {
        email?: string;
        aud?: string;
        iss?: string;
        expSec?: number;
        nbfSec?: number;
        key?: CryptoKey;
        kid?: string;
    } = {}) {
        const now = Math.floor(Date.now() / 1000);
        const payload: Record<string, unknown> = { type: 'app' };
        if (claims.email !== undefined) payload.email = claims.email;
        return await new SignJWT(payload)
            .setProtectedHeader({ alg: 'RS256', kid: claims.kid ?? KID })
            .setIssuer(claims.iss ?? ISSUER)
            .setAudience(claims.aud ?? AUD)
            .setIssuedAt(now)
            .setNotBefore(claims.nbfSec ?? now - 60)
            .setExpirationTime(claims.expSec ?? now + 3600)
            .sign(claims.key ?? teamKeys.privateKey);
    }

    async function expectDeny(name: string, h: AccessJwtHeaderReader, reason: AccessJwtDenyReason, d = deps) {
        const res = await verifyAccessJwt(h, d);
        check(
            `${name} → no viewer (${reason})`,
            res.ok === false && res.reason === reason,
            res.ok ? 'verifier ADMITTED the request' : `reason=${(res as { reason: string }).reason}`,
        );
    }

    // ---- 1. Positive control ------------------------------------------------
    {
        const token = await mint({ email: EMAIL });
        // Mixed case + padding on the header: the comparison normalizes both.
        const res = await verifyAccessJwt(
            headers({ [JWT_HEADER]: token, [EMAIL_HEADER]: `  Crew@Example.COM ` }),
            deps,
        );
        check(
            'valid token + matching identity → viewer admitted',
            res.ok === true && res.email === EMAIL,
            res.ok ? res.email : `denied: ${(res as { reason: string }).reason}`,
        );
    }

    // ---- 2. THE FORGERY PATH: identity header, no JWT -----------------------
    await expectDeny(
        'forged identity header with no JWT',
        headers({ [EMAIL_HEADER]: 'owner@example.com' }),
        'missing-assertion',
    );

    // ---- 3/4. exp / nbf -----------------------------------------------------
    {
        const now = Math.floor(Date.now() / 1000);
        await expectDeny(
            'expired token (exp 1h in the past)',
            headers({ [JWT_HEADER]: await mint({ email: EMAIL, expSec: now - 3600, nbfSec: now - 7200 }), [EMAIL_HEADER]: EMAIL }),
            'invalid-token',
        );
        await expectDeny(
            'not-yet-valid token (nbf 1h in the future)',
            headers({ [JWT_HEADER]: await mint({ email: EMAIL, nbfSec: now + 3600 }), [EMAIL_HEADER]: EMAIL }),
            'invalid-token',
        );
    }

    // ---- 5. Claim/header mismatch — tampering -------------------------------
    await expectDeny(
        'valid token whose email claim ≠ identity header',
        headers({ [JWT_HEADER]: await mint({ email: EMAIL }), [EMAIL_HEADER]: 'owner@example.com' }),
        'email-mismatch',
    );

    // ---- 6/7. Wrong audience / issuer ---------------------------------------
    await expectDeny(
        'token minted for the OTHER tier\'s Access app (wrong aud)',
        headers({ [JWT_HEADER]: await mint({ email: EMAIL, aud: OTHER_AUD }), [EMAIL_HEADER]: EMAIL }),
        'invalid-token',
    );
    await expectDeny(
        'token from a different team domain (wrong iss)',
        headers({ [JWT_HEADER]: await mint({ email: EMAIL, iss: 'https://evil.cloudflareaccess.com' }), [EMAIL_HEADER]: EMAIL }),
        'invalid-token',
    );

    // ---- 8. Foreign signing key ---------------------------------------------
    await expectDeny(
        'well-formed token signed by an unknown key',
        headers({ [JWT_HEADER]: await mint({ email: EMAIL, key: foreignKeys.privateKey }), [EMAIL_HEADER]: EMAIL }),
        'invalid-token',
    );

    // ---- 9. Algorithm confusion ---------------------------------------------
    {
        const secret = await generateSecret('HS256');
        const now = Math.floor(Date.now() / 1000);
        const hsToken = await new SignJWT({ email: EMAIL })
            .setProtectedHeader({ alg: 'HS256', kid: KID })
            .setIssuer(ISSUER)
            .setAudience(AUD)
            .setIssuedAt(now)
            .setExpirationTime(now + 3600)
            .sign(secret);
        await expectDeny(
            'HS256 token (algorithm confusion)',
            headers({ [JWT_HEADER]: hsToken, [EMAIL_HEADER]: EMAIL }),
            'invalid-token',
        );
    }

    // ---- 10/11. Claim + header presence -------------------------------------
    await expectDeny(
        'verified token with no email claim',
        headers({ [JWT_HEADER]: await mint(), [EMAIL_HEADER]: EMAIL }),
        'missing-email-claim',
    );
    await expectDeny(
        'JWT present but identity header absent',
        headers({ [JWT_HEADER]: await mint({ email: EMAIL }) }),
        'missing-identity',
    );

    // ---- 12. Unconfigured tier ----------------------------------------------
    {
        const savedTeam = process.env.CF_ACCESS_TEAM_DOMAIN;
        const savedAud = process.env.CF_ACCESS_AUD;
        delete process.env.CF_ACCESS_TEAM_DOMAIN;
        delete process.env.CF_ACCESS_AUD;
        __resetAccessJwtState();
        try {
            // No deps AND no env: the fail-closed contract's least intuitive
            // branch — it must deny, not fall back to trusting the header.
            const res = await verifyAccessJwt(
                headers({ [JWT_HEADER]: await mint({ email: EMAIL }), [EMAIL_HEADER]: EMAIL }),
                {},
            );
            check(
                'unconfigured tier → no viewer (fail-closed, not fail-open)',
                res.ok === false && res.reason === 'unconfigured',
                res.ok ? 'verifier ADMITTED with no config' : `reason=${(res as { reason: string }).reason}`,
            );
        } finally {
            if (savedTeam === undefined) delete process.env.CF_ACCESS_TEAM_DOMAIN;
            else process.env.CF_ACCESS_TEAM_DOMAIN = savedTeam;
            if (savedAud === undefined) delete process.env.CF_ACCESS_AUD;
            else process.env.CF_ACCESS_AUD = savedAud;
            __resetAccessJwtState();
        }
    }

    // ---- 13. Unreachable JWKS → deny, never degrade -------------------------
    {
        const throwingKeys: JWTVerifyGetKey = async () => {
            throw new Error('simulated JWKS fetch failure (ENOTFOUND)');
        };
        await expectDeny(
            'unreachable JWKS',
            headers({ [JWT_HEADER]: await mint({ email: EMAIL }), [EMAIL_HEADER]: EMAIL }),
            'invalid-token',
            { ...deps, getKey: throwingKeys },
        );
    }

    // ---- 14. Config drift in the tracked env examples -----------------------
    {
        const devExample = readFileSync(resolve(REPO_ROOT, '.env.development.example'), 'utf8');
        const prodExample = readFileSync(resolve(REPO_ROOT, '.env.production.example'), 'utf8');
        const readVar = (text: string, key: string) =>
            text.match(new RegExp(`^${key}=["']?([^"'\\s#]+)`, 'm'))?.[1];

        const devTeam = readVar(devExample, 'CF_ACCESS_TEAM_DOMAIN');
        const prodTeam = readVar(prodExample, 'CF_ACCESS_TEAM_DOMAIN');
        const devAud = readVar(devExample, 'CF_ACCESS_AUD');
        const prodAud = readVar(prodExample, 'CF_ACCESS_AUD');

        check('dev example declares the recorded team domain', devTeam === LIVE_TEAM_DOMAIN, devTeam);
        check('prod example declares the recorded team domain', prodTeam === LIVE_TEAM_DOMAIN, prodTeam);
        check('dev example carries the mc-dev.salsquared.xyz AUD', devAud === LIVE_AUD_DEV, devAud);
        check('prod example carries the mc.salsquared.xyz AUD', prodAud === LIVE_AUD_PROD, prodAud);
        check(
            'the two tiers declare DIFFERENT Access applications',
            !!devAud && !!prodAud && devAud !== prodAud,
            `${devAud} vs ${prodAud}`,
        );
    }

    // ---- 15. End-to-end: resolveViewer() denies the forged header -----------
    {
        // The module reads env, not deps, on this path — configure it so the
        // denial is the JWT check, not the unconfigured branch.
        process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
        process.env.CF_ACCESS_AUD = AUD;
        __resetAccessJwtState();
        const { resolveViewer, __resetViewer } = await import('@/lib/viewer');
        __resetViewer();
        const res = await resolveViewer({
            readHeaders: async () => headers({ [EMAIL_HEADER]: 'owner@example.com' }),
            client: {
                user: {
                    async findUnique() {
                        fail('resolveViewer reached the DB on a JWT-less request — the gate is not wired');
                        return { id: 'u_owner', email: 'owner@example.com', role: 'owner' };
                    },
                },
            },
        });
        check(
            'resolveViewer(): forged identity header with no JWT → 401, no viewer',
            res.ok === false && res.status === 401,
            res.ok ? `ADMITTED as ${res.viewer.email}` : `status=${res.status}`,
        );
    }

    console.log(`\n${fails === 0 ? 'ALL PASS' : 'FAILURES'} — ${passes} passed, ${fails} failed`);
    if (fails > 0) process.exit(1);
}

main().catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
});
