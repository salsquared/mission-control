/**
 * scripts/tests/probes/gmail-push-receive-probe.ts
 *
 * Live probe for the Gmail real-time push RECEIVE path
 * (docs/archive/gmail-realtime-push.html §5, first-light steps 3-5).
 *
 * Confirms, PER TIER, that Google Pub/Sub can actually deliver a push to the
 * public webhook — i.e. the endpoint is reachable through the cloudflared
 * tunnel, is NOT gated by Cloudflare Access (which would silently swallow every
 * push), and the route's own OIDC verification accepts a genuine signer token:
 *
 *   1. GET  (no auth)      -> 405            our route answers (not an Access login page)
 *   2. POST (no auth)      -> 401            reachable + OIDC enforced + NOT behind Access  <- headline
 *   3. POST (bad Bearer)   -> 401            bogus token rejected
 *   4. POST (real OIDC)    -> 404            full chain accepted (signature + audience +
 *                                            signer-email assertion + envelope parse),
 *                                            then the unknown mailbox short-circuits BEFORE
 *                                            any history.list / ingest / notification email.
 *   5. POST (same msgId)   -> 200 deduped    WebhookDelivery dedup path.
 *
 * Test 4 mints a Google-signed OIDC token by IMPERSONATING the push signer SA,
 * exactly as Pub/Sub does, with the tier's webhook URL as the audience. The only
 * side effect across all tests is ONE harmless WebhookDelivery row per tier
 * (auto-pruned at 30d). No email is sent and prod.db is never written with app data.
 *
 * Diagnostic only — exit code is NOT a contract (scripts/tests/probes/ convention).
 *
 * Usage:
 *   npx tsx scripts/tests/probes/gmail-push-receive-probe.ts
 *   npx tsx scripts/tests/probes/gmail-push-receive-probe.ts --no-positive   # tests 1-3 only (no gcloud)
 *   npx tsx scripts/tests/probes/gmail-push-receive-probe.ts --tier=dev      # one tier only
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// The OIDC signer SA + project created in docs/archive/gmail-realtime-push.html §4.2.
// Must equal PUBSUB_SERVICE_ACCOUNT_EMAIL (the route asserts the token's `email`
// claim == this; app/api/gmail/webhook/route.ts:33).
const SIGNER_SA = "pubsub-mc-publisher@crypto-lexicon-490719-q9.iam.gserviceaccount.com";
const PROJECT = "crypto-lexicon-490719-q9";

// Public webhook URLs == each tier's PUBSUB_AUDIENCE (byte-for-byte). Override
// with --prod-url=/--dev-url= if the hostnames ever change.
const TIERS: Record<string, string> = {
  prod: "https://ms-prod.salsquared.xyz/api/gmail/webhook",
  dev: "https://ms-dev.salsquared.xyz/api/gmail/webhook",
};

const args = process.argv.slice(2);
const noPositive = args.includes("--no-positive");
const tierArg = args.find((a) => a.startsWith("--tier="))?.split("=")[1];
for (const t of ["prod", "dev"]) {
  const ov = args.find((a) => a.startsWith(`--${t}-url=`))?.split("=").slice(1).join("=");
  if (ov) TIERS[t] = ov;
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let pass = 0, warn = 0, fail = 0;
const P = () => (pass++, green("PASS"));
const W = () => (warn++, yellow("WARN"));
const F = () => (fail++, red("FAIL"));

function gcloudBin(): string {
  for (const p of ["/opt/homebrew/bin/gcloud", "/usr/local/bin/gcloud"]) if (existsSync(p)) return p;
  return "gcloud";
}

interface Resp { status: number; finalUrl: string; redirected: boolean; ct: string; body: string; error?: string; }

async function req(url: string, init: RequestInit): Promise<Resp> {
  try {
    const res = await fetch(url, init);
    return {
      status: res.status,
      finalUrl: res.url,
      redirected: res.redirected,
      ct: res.headers.get("content-type") ?? "",
      body: await res.text(),
    };
  } catch (e: any) {
    return { status: 0, finalUrl: url, redirected: false, ct: "", body: "", error: e?.message ?? String(e) };
  }
}

// Cloudflare Access intercepts by 302-ing to <team>.cloudflareaccess.com and
// serving an HTML login. Either signal => the webhook is gated and Pub/Sub
// (which presents only an OIDC bearer) can never get through.
function looksLikeAccess(r: Resp): boolean {
  if (/cloudflareaccess\.com/i.test(r.finalUrl)) return true;
  if (r.ct.includes("text/html") && /cloudflare access|cf-access|sign in to[^<]*access/i.test(r.body)) return true;
  return false;
}

function snippet(body: string, n = 120): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

function mintToken(audience: string): string | null {
  try {
    const out = execFileSync(
      gcloudBin(),
      [
        "auth", "print-identity-token",
        `--impersonate-service-account=${SIGNER_SA}`,
        `--audiences=${audience}`,
        "--include-email",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const tok = out.trim();
    return tok.split(".").length === 3 ? tok : null;
  } catch (e: any) {
    const stderr: string = e?.stderr?.toString?.() ?? "";
    const line = stderr.split("\n").find((l) => /ERROR|PERMISSION|denied/i.test(l)) ?? e?.message ?? "";
    console.log(`    ${red("could not mint OIDC token via SA impersonation")} ${dim("— " + line.trim())}`);
    return null;
  }
}

async function checkTier(name: string, url: string) {
  console.log(`\n=== ${bold(name.toUpperCase())}  ${dim(url)} ===`);

  // 1. GET, no auth -> 405 (route only exports POST)
  {
    const r = await req(url, { method: "GET" });
    if (r.error) console.log(`  1 GET  no-auth     ${F()} unreachable: ${r.error}`);
    else if (looksLikeAccess(r)) console.log(`  1 GET  no-auth     ${F()} ${r.status} ${red("Cloudflare Access login")} ${dim(r.finalUrl)}`);
    else if (r.status === 405) console.log(`  1 GET  no-auth     ${P()} 405 Method Not Allowed — our route answers`);
    else console.log(`  1 GET  no-auth     ${W()} ${r.status} ${dim(snippet(r.body, 80))}`);
  }

  // 2. POST, no auth -> 401 (HEADLINE: reachable + not behind Access + OIDC enforced)
  {
    const r = await req(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (r.error) console.log(`  2 POST no-auth     ${F()} unreachable: ${r.error}`);
    else if (looksLikeAccess(r)) console.log(`  2 POST no-auth     ${F()} ${r.status} ${red("BEHIND CLOUDFLARE ACCESS — Pub/Sub cannot reach this")} ${dim(r.finalUrl)}`);
    else if (r.status === 401) console.log(`  2 POST no-auth     ${P()} 401 Unauthorized — ${green("reachable, OIDC enforced, NOT behind Access")}`);
    else if (r.status === 500) console.log(`  2 POST no-auth     ${W()} 500 — reachable but PUBSUB_AUDIENCE may be unset here ${dim(snippet(r.body, 80))}`);
    else console.log(`  2 POST no-auth     ${W()} ${r.status} ${dim(snippet(r.body, 80))}`);
  }

  // 3. POST, garbage Bearer -> 401
  {
    const r = await req(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not.a.jwt" },
      body: "{}",
    });
    if (r.error) console.log(`  3 POST bad-bearer  ${F()} unreachable: ${r.error}`);
    else if (r.status === 401) console.log(`  3 POST bad-bearer  ${P()} 401 Unauthorized — bogus token rejected`);
    else console.log(`  3 POST bad-bearer  ${W()} ${r.status} ${dim(snippet(r.body, 80))}`);
  }

  if (noPositive) return;

  // 4 + 5. Real impersonated OIDC token -> 404 (unknown mailbox), then dedup -> 200
  const token = mintToken(url);
  if (!token) {
    console.log(dim("    (skipped positive OIDC test 4-5 — remediation printed below)"));
    return;
  }
  const messageId = `probe-receive-${name}-${Date.now()}`;
  const envelope = {
    message: {
      // bogus mailbox -> route 404s at the user lookup, before history.list/ingest
      data: b64({ emailAddress: "gmail-push-probe@example.com", historyId: "1" }),
      messageId,
      publishTime: new Date().toISOString(),
    },
    subscription: `projects/${PROJECT}/subscriptions/gmail-push-${name}`,
  };
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  {
    const r = await req(url, { method: "POST", headers, body: JSON.stringify(envelope) });
    if (r.status === 404) console.log(`  4 POST real-OIDC   ${P()} 404 User-not-found — ${green("full OIDC chain accepted")} (sig+aud+signer-email), no ingest`);
    else if (r.status === 401) console.log(`  4 POST real-OIDC   ${F()} 401 token REJECTED — check PUBSUB_SERVICE_ACCOUNT_EMAIL == ${SIGNER_SA} & audience == URL ${dim(snippet(r.body, 80))}`);
    else if (r.status === 400) console.log(`  4 POST real-OIDC   ${W()} 400 — token OK but envelope rejected ${dim(snippet(r.body, 80))}`);
    else console.log(`  4 POST real-OIDC   ${W()} ${r.status} ${dim(snippet(r.body))}`);
  }
  {
    const r = await req(url, { method: "POST", headers, body: JSON.stringify(envelope) });
    if (r.status === 200 && /deduped/.test(r.body)) console.log(`  5 POST redelivery  ${P()} 200 deduped — WebhookDelivery dedup works`);
    else console.log(`  5 POST redelivery  ${W()} ${r.status} ${dim(snippet(r.body))}`);
  }
}

(async () => {
  console.log(bold("Gmail push receive-path probe") + dim("  (docs/archive/gmail-realtime-push.html §5)"));
  const tiers = tierArg ? { [tierArg]: TIERS[tierArg] } : TIERS;
  let mintFailed = false;
  for (const [name, url] of Object.entries(tiers)) {
    if (!url) { console.log(red(`unknown tier: ${name}`)); continue; }
    const before = fail;
    await checkTier(name, url);
    if (!noPositive && fail === before && warn > 0) mintFailed = true; // heuristic; refined below
  }

  console.log(`\n${green(pass + " pass")}, ${yellow(warn + " warn")}, ${red(fail + " fail")}`);

  if (!noPositive) {
    console.log(dim("\nIf tests 4-5 were skipped (token mint failed), enable + grant ONCE, then re-run:"));
    console.log(dim(`  gcloud services enable iamcredentials.googleapis.com`));
    console.log(dim(`  gcloud iam service-accounts add-iam-policy-binding ${SIGNER_SA} \\`));
    console.log(dim(`    --member="user:$(gcloud config get-value account 2>/dev/null)" --role="roles/iam.serviceAccountTokenCreator"`));
  }
  console.log(dim("\nThis probe validates the RECEIVE handler + edge reachability. The Gmail->Pub/Sub"));
  console.log(dim("delivery hop (the new watch/topic/subscription) is proven only by a real inbound email."));
  void mintFailed;
})();
