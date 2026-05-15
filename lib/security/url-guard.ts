/**
 * URL guard for any fetch where the URL is user-controlled.
 *
 * `z.string().url()` happily accepts `http://localhost`, `http://10.0.0.1`,
 * `http://169.254.169.254/...` (AWS IMDS), `file:///etc/passwd`, etc. Pass
 * any user-supplied URL through `assertExternalHttpUrl()` before fetching to
 * block the obvious SSRF surfaces.
 *
 * Caveats this layer does NOT cover (yet):
 *   - DNS rebinding (`evil.com` that resolves to 127.0.0.1). Would need a
 *     pre-resolve + lookup-then-fetch with the resolved IP pinned.
 *   - Redirect chains landing on internal targets. Use `assertSafeResponse()`
 *     after fetch to re-check `response.url`.
 *   - Domain reputation. The goal here is "no obvious internal probe", not
 *     "no malicious external host".
 */

const LITERAL_BLOCKLIST = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "::",
    // Common dev/k8s hostnames.
    "host.docker.internal",
    "kubernetes.default.svc",
    "kubernetes",
]);

/** Returns true if the IP literal is in a private / link-local / loopback range. */
function isPrivateIPv4(host: string): boolean {
    // host is e.g. "192.168.1.5" or "::ffff:192.168.1.5" or "[::ffff:192.168.1.5]"
    const cleaned = host.replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
    const parts = cleaned.split(".");
    if (parts.length !== 4) return false;
    const octets = parts.map(p => parseInt(p, 10));
    if (octets.some(o => Number.isNaN(o) || o < 0 || o > 255)) return false;
    const [a, b] = octets;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 — loopback
    if (a === 127) return true;
    // 169.254.0.0/16 — link-local (cloud metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 100.64.0.0/10 — CGN
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
}

/** Returns true if the IPv6 literal is in a private / link-local / loopback range. */
function isPrivateIPv6(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (!h.includes(":")) return false;
    // Loopback
    if (h === "::1" || h === "::") return true;
    // Unique local (fc00::/7) — fc00 through fdff
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
    // Link-local (fe80::/10)
    if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
    // IPv4-mapped IPv6: ::ffff:<v4>
    if (h.startsWith("::ffff:")) return isPrivateIPv4(h);
    return false;
}

export class UnsafeURLError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsafeURLError";
    }
}

/**
 * Validates that `raw` is a safe external http(s) URL. Throws `UnsafeURLError`
 * with a user-actionable message otherwise.
 */
/**
 * Test-only escape hatch. When `MC_ALLOW_PRIVATE_FETCH=1` is set in the env,
 * the private-network checks are skipped. The hermetic test fixtures point at
 * 127.0.0.1; without this they'd be (correctly) blocked. Production deployments
 * MUST NOT set this. The protocol check still fires either way.
 */
function privateFetchAllowed(): boolean {
    return process.env.MC_ALLOW_PRIVATE_FETCH === "1";
}

export function assertExternalHttpUrl(raw: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new UnsafeURLError(`Not a valid URL: ${raw}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        throw new UnsafeURLError(`Only http and https URLs are allowed (got ${parsed.protocol}).`);
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) {
        throw new UnsafeURLError("URL has no hostname.");
    }
    if (privateFetchAllowed()) return parsed;
    if (LITERAL_BLOCKLIST.has(host)) {
        throw new UnsafeURLError(`Refusing to fetch internal host: ${host}`);
    }
    // host could be a bracketed IPv6 in some parsers; URL.hostname strips brackets.
    if (isPrivateIPv4(host)) {
        throw new UnsafeURLError(`Refusing to fetch private IPv4 address: ${host}`);
    }
    if (isPrivateIPv6(host)) {
        throw new UnsafeURLError(`Refusing to fetch private IPv6 address: ${host}`);
    }
    return parsed;
}

/**
 * After a fetch, re-validate the response's final URL (in case redirects
 * landed on an internal target). Throws `UnsafeURLError` if so.
 */
export function assertSafeResponseUrl(response: Response): void {
    if (!response.url) return; // some fetch impls don't populate this
    assertExternalHttpUrl(response.url);
}
