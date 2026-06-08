/**
 * Daily Gmail push-watch renewal. Gmail watch subscriptions expire after ~7
 * days; this re-arms every Google-linked user's watch so real-time ingestion
 * never goes silent. Daily cadence = ~7x safety margin; the 10s startup
 * stagger in scheduler/index.ts also self-heals the watch within seconds of
 * any scheduler restart.
 *
 * Stateless sweep (no schema state). Idempotent — re-arming points at the same
 * shared topic, so running it in both tiers is safe (see lib/gmail/watch.ts +
 * docs/archive/gmail-realtime-push.html).
 *
 * `register` is injectable so the hermetic smoke can exercise account selection
 * + per-user error isolation without touching the live Gmail API.
 */
import { prisma } from "@/lib/prisma";
import { registerGmailWatch, type RegisterGmailWatchFn } from "@/lib/gmail/watch";

export interface GmailWatchRenewResult {
    processed: number;
    renewed: number;
    failed: number;
    /** Subset of `failed` whose error looks like a transient network/DNS fault
     *  (so the scheduler should retry it). The cold-boot case: PM2's boot
     *  LaunchDaemon resurrects this scheduler before the network/DNS is up, so
     *  the startup re-arm fails with ENOTFOUND and push goes dark until the next
     *  daily tick unless we retry. See scheduler/index.ts. */
    networkFailures: number;
}

// Error codes/messages that mean "the network wasn't reachable", not "Gmail
// rejected us" — the ones worth retrying. A revoked token / 4xx is NOT here, so
// the scheduler's retry loop falls through immediately instead of looping.
const TRANSIENT_NETWORK_PATTERNS = [
    "ENOTFOUND",     // DNS name not yet resolvable (the cold-boot race)
    "EAI_AGAIN",     // DNS temporary failure
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "fetch failed",  // undici wrapper when the underlying cause is a network error
    "socket hang up",
];

function isTransientNetworkError(e: unknown): boolean {
    const code = (e as { code?: unknown })?.code;
    const causeCode = (e as { cause?: { code?: unknown } })?.cause?.code;
    const haystack = [
        typeof code === "string" ? code : "",
        typeof causeCode === "string" ? causeCode : "",
        (e as Error)?.message ?? String(e),
    ].join(" ");
    return TRANSIENT_NETWORK_PATTERNS.some((p) => haystack.includes(p));
}

export async function runGmailWatchRenew(
    register: RegisterGmailWatchFn = registerGmailWatch,
): Promise<GmailWatchRenewResult> {
    const accounts = await prisma.account.findMany({
        where: { provider: "google", refresh_token: { not: null } },
        select: { userId: true },
    });
    const userIds = [...new Set(accounts.map((a) => a.userId))];

    let renewed = 0;
    let failed = 0;
    let networkFailures = 0;
    for (const userId of userIds) {
        try {
            if (await register(userId)) renewed++;
        } catch (e) {
            failed++;
            if (isTransientNetworkError(e)) networkFailures++;
            console.warn(`[gmail-watch-renew] failed for user ${userId}:`, (e as Error)?.message ?? e);
        }
    }

    return { processed: userIds.length, renewed, failed, networkFailures };
}
