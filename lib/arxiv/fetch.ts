/**
 * Canonical arXiv API fetch (docs/archive/arxiv-rate-limit-fix.html — recovery layer).
 *
 * Every arXiv-touching route went through the same 4-line dance: acquire a
 * paced slot, loggedFetch, throw on `!res.ok`, throw on a non-XML body (arXiv
 * sometimes 200s with plaintext "Rate exceeded."). This folds it into one place
 * AND wires the circuit breaker: a 429 / "Rate exceeded" trips the cross-tier
 * cooldown (`noteArxivRateLimited`) so BOTH tiers stop calling arXiv long enough
 * for the IP block to clear. Rate-limit and other arXiv failures both surface as
 * `ArxivUnavailableError`, which the routes re-throw so `withSharedCache` serves
 * stale / a benign empty fallback instead of a 500 + error-log cascade.
 */
import { acquireArxivSlot, noteArxivRateLimited } from "@/lib/arxiv/rate-limit";
import { ArxivUnavailableError } from "@/lib/arxiv/errors";
import { loggedFetch } from "@/lib/external-fetch";

/**
 * GET an arXiv API URL and return the raw Atom XML. Paces via the shared bucket
 * (throws `ArxivRateLimitCooldownError` if a cooldown is active — a subclass of
 * `ArxivUnavailableError`), trips the cooldown on a rate-limit signal, and
 * throws `ArxivUnavailableError` on any non-XML / non-OK response.
 */
export async function fetchArxivXml(url: string): Promise<string> {
    await acquireArxivSlot(); // may throw ArxivRateLimitCooldownError (in cooldown)

    const res = await loggedFetch(url);
    if (!res.ok) {
        // 429 is the explicit rate-limit; trip the breaker so we back off.
        if (res.status === 429) await noteArxivRateLimited();
        throw new ArxivUnavailableError(`arXiv responded ${res.status} ${res.statusText} for ${url}`);
    }

    const xml = await res.text();
    // arXiv occasionally returns the plaintext "Rate exceeded." with HTTP 200,
    // bypassing the status check above — treat a non-XML body as a rate-limit.
    if (!xml.trimStart().startsWith("<")) {
        if (/rate exceeded/i.test(xml)) await noteArxivRateLimited();
        throw new ArxivUnavailableError(`arXiv non-XML response (likely rate-limited): ${xml.slice(0, 80)}`);
    }
    return xml;
}
