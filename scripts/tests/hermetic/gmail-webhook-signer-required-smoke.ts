/**
 * RAH-10 fail-closed smoke — `/api/gmail/webhook` must REFUSE to run when
 * `PUBSUB_SERVICE_ACCOUNT_EMAIL` is unset, rather than accepting any
 * Google-signed OIDC token.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/gmail-webhook-signer-required-smoke.ts
 *
 * WHY THIS EXISTS. `verifyPubSubOIDC` validates issuer + audience + signature
 * only. The audience is this route's PUBLIC URL, not a secret — so "Google
 * signed this" is not "our publisher signed this", and the signer-email check
 * is the only thing separating the two. Until 2026-08-02 an unset env var
 * downgraded that check to a `console.warn` and accepted the request.
 *
 * That shape has already caused one real bug in this repo: `lib/auth-allowlist.ts`
 * treated a blank `ALLOWED_SIGNIN_EMAILS` as "allow everyone" until 2026-07-29,
 * on a route that mints `User` rows — i.e. a missing config value silently
 * became self-provisioning. Same failure mode, same fix: absent config is
 * REFUSAL, and it is loud.
 *
 * This route is one of only TWO under `app/api` carrying no auth-guard at all
 * (it is OIDC-verified instead, and Cloudflare Access has a path-scoped Bypass
 * on it so Pub/Sub can reach the origin at all). There is no second gate behind
 * it, which is why this is asserted behaviourally — by driving the real handler
 * — and not by grepping the source for a string.
 *
 * Hermetic: no network, no Pub/Sub, no real token. Every case returns before
 * `verifyPubSubOIDC` can reach the network, or fails closed inside it.
 */

// Pin DATABASE_URL to a throwaway path BEFORE anything can transitively load
// `lib/prisma` — same belt-and-suspenders as role-matrix-smoke. Nothing here
// should reach the DB (the guard short-circuits first); if that ever stops
// being true, the blast radius is a file in /tmp rather than dev.db.
const SCRATCH_DB = `/tmp/gmail-webhook-signer-smoke-${process.pid}.db`;
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;

import { unlinkSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
    if (cond) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const AUDIENCE = "https://mc.salsquared.xyz/api/gmail/webhook";

/** A POST carrying a syntactically-plausible but bogus bearer token. */
function makeReq(): any {
    return {
        headers: new Headers({
            authorization: "Bearer not.a.real.token",
            "content-type": "application/json",
        }),
        json: async () => ({ message: { data: "e30=", messageId: "smoke-1" } }),
    };
}

async function main() {
    const { POST } = await import("@/app/api/gmail/webhook/route");

    // ── 1. The regression under test: signer email unset → refuse ──────────
    process.env.PUBSUB_AUDIENCE = AUDIENCE;
    delete process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;

    const res1 = await POST(makeReq());
    const body1 = await res1.json();
    check(
        "signer email UNSET → 500 (refuses; does not accept an unverified signer)",
        res1.status === 500,
        `got ${res1.status} ${JSON.stringify(body1)}`,
    );
    // 500 not 401 on purpose: the caller did nothing wrong, the server is
    // misconfigured. Asserted so a future "tidy-up" to 401 has to be deliberate
    // — it would tell an operator Pub/Sub is being rejected, hiding the real
    // cause and sending them to debug GCP instead of their own `.env`.
    check(
        "the refusal reads as misconfiguration, not as a rejected caller",
        body1?.error === "Server misconfigured",
        `got ${JSON.stringify(body1)}`,
    );
    // The critical half: it must not have gone through. A 500 that still ran
    // the ingest would be worse than the warn-and-accept it replaced.
    check(
        "the refusal is terminal — no 200 / no `deduped` ack",
        res1.status !== 200 && body1?.deduped === undefined,
        JSON.stringify(body1),
    );

    // ── 2. Specificity: with the var SET, a bad token is 401, not 500 ──────
    // Without this, `return 500` unconditionally at the top of the handler
    // would pass check 1 while breaking the route for real Pub/Sub traffic.
    process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL = "gmail-push@example.iam.gserviceaccount.com";
    const res2 = await POST(makeReq());
    check(
        "signer email SET + bogus token → 401 (config branch is specific, not blanket)",
        res2.status === 401,
        `got ${res2.status} ${JSON.stringify(await res2.json().catch(() => null))}`,
    );

    // ── 3. The pre-existing sibling branch still fails closed ─────────────
    delete process.env.PUBSUB_AUDIENCE;
    const res3 = await POST(makeReq());
    check("audience UNSET → 500 (unchanged)", res3.status === 500, `got ${res3.status}`);

    // ── 4. No warn-and-accept path survives anywhere in the file ──────────
    // Behavioural checks above cover the two env states; this catches a THIRD
    // being reintroduced (e.g. a `NODE_ENV !== "production"` escape) that the
    // two states above would not exercise.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "app/api/gmail/webhook/route.ts"), "utf-8");
    check(
        "no 'accepting any Google-signed token' fallback remains",
        !/accepting any Google-signed token/i.test(src),
    );
    check(
        "signer comparison is still asserted (email + email_verified)",
        /claims\.email\s*!==\s*expectedSignerEmail/.test(src) && /email_verified\s*!==\s*true/.test(src),
    );
}

main()
    .catch(e => { console.error("[FAIL] unhandled", e); failed++; })
    .finally(() => {
        try { unlinkSync(SCRATCH_DB); } catch { /* never created — expected */ }
        console.log(`\n${passed}/${passed + failed} checks passed`);
        process.exit(failed > 0 ? 1 : 0);
    });
