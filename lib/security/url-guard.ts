/**
 * URL guard for any fetch where the URL is user-controlled.
 *
 * `z.string().url()` happily accepts `http://localhost`, `http://10.0.0.1`,
 * `http://169.254.169.254/...` (AWS IMDS), `file:///etc/passwd`, etc. Pass
 * any user-supplied URL through `assertExternalHttpUrlAsync()` before fetching
 * to block the SSRF surfaces.
 *
 * TWO LAYERS, in this order — the cheap one first:
 *
 *   1. LITERAL. Protocol, a hostname blocklist, and a full byte-level parse of
 *      any IP literal in the host (IPv4 and IPv6, including every IPv4-in-IPv6
 *      embedding listed in classifyIPv6). No I/O. This catches
 *      `http://127.0.0.1`, `http://[fc00::1]` and friends without touching the
 *      network, so it must stay first.
 *
 *   2. RESOLUTION (added 2026-08-02). A hostname that is not an IP literal is
 *      resolved with `dns.lookup` and EVERY returned address is run through the
 *      same byte-level classifier. This closes the `nip.io` / `localtest.me` /
 *      `sslip.io` class — wildcard DNS services that encode an arbitrary IP in
 *      a public-looking name — and, more generally, any name an attacker
 *      controls the A/AAAA record for. Results are cached per host, so a probe
 *      batch pays at most one lookup per host per TTL rather than one per probe.
 *
 * FAIL CLOSED. This is a security boundary. Unlike essentially every cache and
 * rate bucket in this repo, it does NOT degrade to "do it anyway": an
 * unresolvable host, a resolver timeout, an empty answer, or an address we
 * cannot parse is a refusal, not an admission. `lib/access-jwt.ts` carries the
 * same rule for the same reason.
 *
 * ─── WHY THE API IS ASYNC, AND WHY THE NAME CARRIES A SUFFIX ───
 *
 * Both entry points are async and both end in `Async`. The suffix is a
 * deliberate tripwire, not decoration. An earlier version of this module kept a
 * SYNCHRONOUS `assertExternalHttpUrl` and did the lookup on a worker thread via
 * `Atomics.wait`, on the theory that the call sites used the guard as a throwing
 * statement where `await` was unavailable. That was simply wrong — all seven
 * call sites (`lib/postings/liveness.ts` ×3, `lib/fetchers/careers-page-
 * fetcher.ts` ×2, `lib/resumes/posting.ts` ×2) sit inside `async` functions, and
 * `await` works fine inside a try/catch. The blocking machinery bought nothing
 * and cost a great deal: it stalled the event loop for up to ~3s at a stretch,
 * and its off-path cache-warming queue was an unbounded fan-out into libuv's
 * 2-thread `getaddrinfo` pool that could starve DNS for the WHOLE process
 * (measured: 300 queued warms delayed an unrelated lookup by 4.5s), degrading
 * Gemini and Google API calls that had nothing to do with this guard.
 *
 * Awaiting is also what supplies the back-pressure that the fire-and-forget
 * version lacked: in-flight lookups are now bounded by the caller's own
 * concurrency (a probe profile's 1–8), not by how fast an attacker can name
 * hosts. Combined with the single-flight map below, a 200-probe batch over two
 * hosts issues two lookups.
 *
 * Keeping the `Async` suffix means a stale synchronous call site — the one
 * mis-wiring risk worth guarding, since a floating promise is not a `tsc`
 * error — fails to COMPILE rather than silently becoming a no-op. Do not add a
 * sync alias.
 *
 * ─── WHAT THIS STILL DOES NOT FIX — read before assuming SSRF is closed ───
 *
 *   - TRUE DNS REBINDING. Layer 2 is resolve-then-fetch, which is TOCTOU: we
 *     resolve the name, decide it is public, and then `fetch()` RE-RESOLVES it
 *     independently. A record with a ~0 TTL can answer public to our lookup and
 *     127.0.0.1 to the one undici makes microseconds later, and nothing here
 *     would see it. Our per-host cache widens that window on purpose (that is
 *     the cost of not paying a lookup per probe). Closing this needs
 *     CONNECT-time enforcement, not check-time: a custom undici dispatcher
 *     whose `connect.lookup` returns only the vetted address, so the socket is
 *     opened against the IP we actually validated. That is a change at the
 *     FETCH call sites, not in this module, and it is NOT implemented. Treat
 *     layer 2 as raising the cost of the attack from "register a nip.io
 *     hostname" to "run an authoritative nameserver with a rebinding record" —
 *     a real improvement, not a proof.
 *   - Domain reputation. The goal here is "no internal probe", not "no
 *     malicious external host".
 *   - Fetches that never pass through this guard at all.
 *
 * Redirect chains ARE covered, but only because callers do the work:
 * `lib/postings/liveness.ts:fetchWithGuardedRedirects` fetches with
 * `redirect: "manual"` and re-runs this guard on every hop target. Callers that
 * use `redirect: "follow"` must call `assertSafeResponseUrlAsync()` afterwards,
 * which is strictly weaker (the intermediate hops were already fetched).
 *
 * ─── ENV ───
 *   MC_ALLOW_PRIVATE_FETCH=1     Skip BOTH layers. Hermetic fixtures bind
 *                                127.0.0.1. Production MUST NOT set this.
 *   MC_URL_GUARD_DNS_TIMEOUT_MS  Per-lookup budget (default 2000). The lookup
 *                                runs BEFORE the caller's own fetch timeout, so
 *                                without this a wedged resolver would hang a
 *                                probe past its profile budget.
 *   MC_URL_GUARD_DNS_TTL_MS      Cache TTL for an ALLOW verdict (default
 *                                60000). A DENY is cached 5× longer — a denial
 *                                is always safe to keep. A resolution FAILURE
 *                                is cached only briefly (see FAILURE_TTL_MS).
 *
 * There is deliberately NO env switch that turns layer 2 off. An earlier draft
 * had one, for the hermetic smokes; it was removed because a variable that
 * disables an SSRF control process-wide is exactly the kind of thing that ends
 * up set in production "to unblock something". The two mechanisms that replaced
 * it — the reserved-name carve-out and `__setUrlGuardResolver` — are
 * respectively unreachable by an attacker and unreachable from production code.
 */
import { lookup as dnsLookup } from "node:dns";

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
    // GCE's metadata alias. Resolves to 169.254.169.254, so layer 2 would also
    // catch it — but only on a host whose resolver knows the name, and this
    // costs one line.
    "metadata.google.internal",
]);

// ─── Address classification ───────────────────────────────────────────────
//
// Everything below works on BYTES, not strings, because the string forms are
// not canonical and the old string-matching version had holes:
//
//   - WHATWG `new URL()` re-serializes an IPv4-mapped IPv6 literal into hex, so
//     `http://[::ffff:127.0.0.1]/` arrives here as `[::ffff:7f00:1]`. The old
//     `h.startsWith("::ffff:") -> isPrivateIPv4(h)` branch then handed
//     `7f00:1` to a dotted-quad parser, which returned false. EVERY IPv4-mapped
//     literal was admitted — verified against the pre-2026-08-02 code.
//   - `[64:ff9b::7f00:1]` (NAT64) and `[2002:7f00:1::]` (6to4) embed the same
//     IPv4 in other well-known prefixes and were likewise admitted.
//
// A parse-to-bytes classifier has no such seams: there is exactly one place an
// IPv4 gets judged, and every IPv6 embedding funnels into it.

/** Parse a dotted-quad. Returns 4 bytes, or null if `s` is not one. */
function parseIPv4(s: string): Uint8Array | null {
    const parts = s.split(".");
    if (parts.length !== 4) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
        const p = parts[i];
        if (!/^\d{1,3}$/.test(p)) return null;
        const n = Number(p);
        if (n > 255) return null;
        out[i] = n;
    }
    return out;
}

/**
 * Parse an IPv6 literal to 16 bytes. Handles `::` compression, a trailing
 * dotted-quad (`::ffff:127.0.0.1`), surrounding brackets and a `%zone` suffix.
 * Returns null if `s` is not an IPv6 literal.
 *
 * Deliberately LENIENT where leniency is the safe direction: a form we manage
 * to parse gets classified, and a form we reject as "not an IPv6 literal" falls
 * through to the DNS layer rather than being waved past.
 */
function parseIPv6(s: string): Uint8Array | null {
    let h = s.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    const zone = h.indexOf("%");
    if (zone !== -1) h = h.slice(0, zone);
    if (!h.includes(":")) return null;

    const dbl = h.indexOf("::");
    if (dbl !== -1 && h.indexOf("::", dbl + 2) !== -1) return null; // only one "::"

    /** Expand a colon-separated run into bytes; a trailing dotted-quad is 4. */
    const expand = (run: string): number[] | null => {
        if (run === "") return [];
        const groups = run.split(":");
        const out: number[] = [];
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            if (g === "") return null;
            if (g.includes(".")) {
                if (i !== groups.length - 1) return null; // v4 tail only at the end
                const v4 = parseIPv4(g);
                if (!v4) return null;
                out.push(v4[0], v4[1], v4[2], v4[3]);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
            const n = parseInt(g, 16);
            out.push((n >> 8) & 0xff, n & 0xff);
        }
        return out;
    };

    const bytes = new Uint8Array(16);
    if (dbl === -1) {
        const all = expand(h);
        if (!all || all.length !== 16) return null;
        bytes.set(all);
        return bytes;
    }
    const head = expand(h.slice(0, dbl));
    const tail = expand(h.slice(dbl + 2));
    if (!head || !tail) return null;
    if (head.length + tail.length > 16) return null;
    bytes.set(head, 0);
    bytes.set(tail, 16 - tail.length);
    return bytes;
}

/**
 * Classify 4 IPv4 bytes. Returns a human reason when the address is not a safe
 * external target, else null.
 *
 * NOT blocked, deliberately: the TEST-NET documentation ranges (192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24). They are ordinary unroutable-but-not-
 * internal addresses, the smoke has pinned 203.0.113.50 as allowed since this
 * file was written, and blocking them buys nothing — nothing internal lives
 * there.
 */
function classifyIPv4(b: Uint8Array): string | null {
    const [a, c] = [b[0], b[1]];
    if (a === 0) return "0.0.0.0/8 (this network)";
    if (a === 10) return "10.0.0.0/8 (private)";
    if (a === 127) return "127.0.0.0/8 (loopback)";
    if (a === 100 && c >= 64 && c <= 127) return "100.64.0.0/10 (CGNAT)";
    if (a === 169 && c === 254) return "169.254.0.0/16 (link-local / cloud metadata)";
    if (a === 172 && c >= 16 && c <= 31) return "172.16.0.0/12 (private)";
    if (a === 192 && c === 0 && b[2] === 0) return "192.0.0.0/24 (IETF protocol assignments)";
    if (a === 192 && c === 168) return "192.168.0.0/16 (private)";
    // 192.88.99.0/24 — deprecated 6to4 relay ANYCAST. Never a real host, and it
    // is the IPv4 half of the 2002::/16 embedding handled in classifyIPv6.
    if (a === 192 && c === 88 && b[2] === 99) return "192.88.99.0/24 (6to4 relay anycast)";
    if (a === 198 && (c === 18 || c === 19)) return "198.18.0.0/15 (benchmarking)";
    if (a >= 224 && a <= 239) return "224.0.0.0/4 (multicast)";
    if (a >= 240) return "240.0.0.0/4 (reserved / broadcast)";
    return null;
}

/**
 * Classify 16 IPv6 bytes. Returns a human reason, or null when safe.
 *
 * The IPv4-EMBEDDING branches are meant to be EXHAUSTIVE rather than
 * representative — the module header claims every embedding funnels into
 * `classifyIPv4`, so a missing prefix makes the header a lie. Covered:
 * IPv4-compatible (`::/96`), IPv4-mapped (`::ffff:0:0/96`), IPv4-translated
 * (`::ffff:0:0:0/96`, RFC 6052), well-known NAT64 (`64:ff9b::/96`), local-use
 * NAT64 (`64:ff9b:1::/48`, RFC 8215), 6to4 (`2002::/16`) and Teredo
 * (`2001::/32`).
 */
function classifyIPv6(b: Uint8Array): string | null {
    const zeros = (from: number, to: number) => {
        for (let i = from; i < to; i++) if (b[i] !== 0) return false;
        return true;
    };
    const tail4 = () => classifyIPv4(b.subarray(12, 16));

    // ::/96 — covers `::` (unspecified), `::1` (loopback) and the deprecated
    // IPv4-compatible form `::a.b.c.d`. Nothing routable lives here, but run the
    // embedded quad through classifyIPv4 anyway so the reason names the target.
    if (zeros(0, 12)) return tail4() ?? "::/96 (unspecified / IPv4-compatible)";

    // ::ffff:0:0/96 — IPv4-mapped. The real workhorse: this is the form
    // `dns.lookup` hands back for a v4 address on a v6-preferring stack, and the
    // form WHATWG normalizes `[::ffff:127.0.0.1]` into.
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) {
        const v4 = tail4();
        return v4 ? `IPv4-mapped ${v4}` : null;
    }

    // ::ffff:0:0:0/96 — IPv4-TRANSLATED (RFC 6052 §2). One bit-pattern away from
    // IPv4-mapped above, and written `::ffff:0:7f00:1` rather than
    // `::ffff:7f00:1` — which is exactly how it slips past a check that only
    // knows the mapped form.
    if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) {
        const v4 = tail4();
        return v4 ? `IPv4-translated ${v4}` : null;
    }

    // 64:ff9b:1::/48 — RFC 8215 local-use NAT64. Checked BEFORE the well-known
    // prefix below (which requires bytes 4..11 to be zero and so would not match
    // anyway) and blocked as a WHOLE prefix rather than only when the embedded
    // quad is private: it is defined for local translation only, so it is never a
    // legitimate external destination, and RFC 6052 permits the v4 at several
    // offsets inside it — enumerating them invites exactly the near-miss this
    // branch exists to stop.
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) {
        const v4 = tail4();
        return `64:ff9b:1::/48 (local-use NAT64${v4 ? `, embedding ${v4}` : ""})`;
    }

    // 64:ff9b::/96 — the well-known NAT64 prefix. On a NAT64 network this is a
    // live route to the embedded IPv4.
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
        const v4 = tail4();
        return v4 ? `NAT64-embedded ${v4}` : null;
    }

    // 2002::/16 — 6to4, embedding the IPv4 in bytes 2..5.
    if (b[0] === 0x20 && b[1] === 0x02) {
        const v4 = classifyIPv4(b.subarray(2, 6));
        return v4 ? `6to4-embedded ${v4}` : null;
    }

    // 2001::/32 — Teredo. Whole-prefix block: Teredo is a legacy transition
    // tunnel, never a legitimate destination for this app, and its layout
    // obfuscates the client IPv4 (bitwise-NOT of the last 32 bits) so a
    // per-field classification would be its own footgun. The check requires
    // bytes 2..3 to be ZERO, so 2001:db8::/32 documentation space and ordinary
    // public 2001:4860::/32-style addresses are untouched.
    if (b[0] === 0x20 && b[1] === 0x01 && zeros(2, 4)) return "2001::/32 (Teredo)";

    if ((b[0] & 0xfe) === 0xfc) return "fc00::/7 (unique local)";
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "fe80::/10 (link-local)";
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return "fec0::/10 (site-local, deprecated)";
    if (b[0] === 0xff) return "ff00::/8 (multicast)";
    return null;
}

/**
 * Classify one address STRING (an IP literal from a URL host, or one entry from
 * a resolver answer). Returns a reason when unsafe, null when safe.
 *
 * `unparseable` is deliberately UNSAFE: an address we cannot read is an address
 * we cannot vouch for, and this module fails closed.
 */
function classifyAddress(addr: string): string | null {
    const v4 = parseIPv4(addr);
    if (v4) return classifyIPv4(v4);
    const v6 = parseIPv6(addr);
    if (v6) return classifyIPv6(v6);
    return `unparseable address: ${addr}`;
}

/** True when the host is itself an IP literal — i.e. there is nothing to resolve. */
function hostIsIpLiteral(host: string): boolean {
    return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

/**
 * Names IANA has reserved such that they can never designate a real internet
 * host. These skip the RESOLUTION layer (layer 2) — never the literal layer.
 *
 * WHY THIS IS NOT A HOLE. Layer 2 defends against an attacker who controls a
 * DNS record for a domain they own and points it at an internal address
 * (`127.0.0.1.nip.io`, or their own `evil.com` with an A record of 10.0.0.1).
 * That attacker cannot obtain a name under any of these: `.invalid` is defined
 * by RFC 6761 §6.4 to be permanently non-resolvable, and `.example` /
 * `example.com|net|org` are held by IANA under RFC 2606 and are not registrable
 * by anyone. So the carve-out is not reachable by the threat it carves out of.
 * The worst a URL under one of these can do in production is fail at DNS — it
 * names nothing, so it reaches nothing.
 *
 * WHY IT EXISTS. It is a test affordance, stated plainly. `scripts/tests/
 * hermetic/` is defined as "no network", and its fetch fixtures are addressed
 * by exactly these names (`*.example.invalid` in c3-cursor and
 * watchlist-closed-detection, `verdict-*.example` in liveness-probe,
 * `jobs.example.com` in posting-parse-cache). Without the carve-out, layer 2's
 * fail-closed rule refuses every one of them — correctly, since they genuinely
 * do not resolve — and the hermetic tier would have to either issue live DNS or
 * remember a setup call in every future suite that fetches.
 *
 * DELIBERATELY EXCLUDED, and this is the part to preserve if the list is ever
 * edited:
 *   - `.test` (RFC 6761 §6.2). Reserved, but in PRACTICE widely wired to
 *     loopback on developer machines (Laravel Valet and friends map `*.test` →
 *     127.0.0.1). Exempting it would hand back the loopback bypass on exactly
 *     the machines this repo is developed on.
 *   - `.localhost` (RFC 6761 §6.3), which resolvers MUST point at loopback.
 *     Exempting it would be a direct SSRF hole. Note the bare name `localhost`
 *     is caught by LITERAL_BLOCKLIST, but `anything.localhost` is not — it is
 *     layer 2 that stops it, so it must keep reaching layer 2.
 */
const RESERVED_TEST_TLDS = new Set(["invalid", "example"]);
const RESERVED_TEST_DOMAINS = ["example.com", "example.net", "example.org"];

function isReservedNonResolvableName(host: string): boolean {
    // A SINGLE-LABEL host is never exempt, even when the label is itself a
    // reserved TLD. `http://invalid/` is not a name under `.invalid`; it is a
    // bare label, and a bare label is exactly what a DNS search suffix expands
    // into something internal (`invalid` → `invalid.corp.example`). Requiring a
    // dot keeps the carve-out to genuine subdomains of the reserved space.
    const dot = host.lastIndexOf(".");
    if (dot <= 0) return false;
    if (RESERVED_TEST_TLDS.has(host.slice(dot + 1))) return true;
    return RESERVED_TEST_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}

/**
 * `URL.hostname` is close to canonical but not all the way there:
 *   - it keeps the brackets on an IPv6 literal (`[::1]`);
 *   - it keeps a FQDN's trailing dot on a NAME (`localhost.`), which used to
 *     walk straight past LITERAL_BLOCKLIST — `http://localhost./admin` was
 *     admitted by the pre-2026-08-02 code. (It strips the dot on an IP-shaped
 *     host, so `127.0.0.1.` was never affected.)
 * Normalize both away once, here, so no downstream check has to remember.
 */
function normalizeHost(hostname: string): string {
    let h = hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    while (h.endsWith(".")) h = h.slice(0, -1);
    return h;
}

// ─── Resolution layer ─────────────────────────────────────────────────────

export interface ResolvedAddress {
    address: string;
    family: number;
}

/**
 * Host resolver. Throws (or rejects) on any failure — a failed resolver is a
 * refusal, never an admission.
 *
 * The return type accepts a plain array so a hermetic smoke can inject a
 * one-line synchronous stub (`() => [{ address: "93.184.216.34", family: 4 }]`)
 * and still be awaited here. See `__setUrlGuardResolver`.
 */
export type HostResolver = (host: string) => ResolvedAddress[] | Promise<ResolvedAddress[]>;

const DEFAULT_ALLOW_TTL_MS = 60_000;
const DENY_TTL_MULTIPLIER = 5;
/**
 * A resolution FAILURE is cached, but only briefly.
 *
 * Not caching it at all (the previous rule) meant a host that cannot resolve —
 * one dead company with 50 stale postings, say — re-issued a lookup on EVERY
 * probe of EVERY tick, forever. Caching it for the full deny TTL would instead
 * lock out a host for five minutes over one flaky lookup. Ten seconds collapses
 * the repeat-lookup storm while keeping recovery effectively immediate: a host
 * that comes back is admitted on the next tick, and no scheduler cadence in this
 * repo is tighter than that.
 */
const FAILURE_TTL_MS = 10_000;
const DEFAULT_DNS_TIMEOUT_MS = 2_000;
/**
 * Cap on distinct hosts held at once. Crew can point a watchlist at any host
 * and a redirect chain can name more, so this map is attacker-growable and
 * needs a bound.
 */
const HOST_CACHE_MAX = 512;

interface CacheEntry {
    /** null = safe. */
    reason: string | null;
    expiresAt: number;
}

/**
 * Verdict cache, maintained as a true LRU.
 *
 * A `Map` preserves INSERTION order, and `Map.set` on an existing key does NOT
 * move it — so the obvious "evict the first key" policy is FIFO, not LRU, and
 * that is attacker-flushable in the wrong direction: a hot legitimate host keeps
 * aging toward eviction no matter how often it is hit, while cold junk inserted
 * later survives. `readCache()` below deletes before re-setting on every read,
 * which is what makes recency actually track use — so 512 attacker hostnames can
 * no longer evict the handful of hosts the fetchers live on.
 */
const hostCache = new Map<string, CacheEntry>();

function envInt(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read an entry and refresh its LRU recency. Returns null when absent/expired. */
function readCache(host: string): CacheEntry | null {
    const hit = hostCache.get(host);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        hostCache.delete(host);
        return null;
    }
    hostCache.delete(host);
    hostCache.set(host, hit); // delete-then-set == move to most-recently-used
    return hit;
}

function cacheVerdict(host: string, reason: string | null, failed: boolean): void {
    const ttl = envInt("MC_URL_GUARD_DNS_TTL_MS", DEFAULT_ALLOW_TTL_MS);
    const lifetime = failed ? FAILURE_TTL_MS : reason === null ? ttl : ttl * DENY_TTL_MULTIPLIER;
    hostCache.delete(host);
    hostCache.set(host, { reason, expiresAt: Date.now() + lifetime });
    while (hostCache.size > HOST_CACHE_MAX) {
        const lru = hostCache.keys().next().value;
        if (lru === undefined) break;
        hostCache.delete(lru);
    }
}

/** Judge a resolver answer: the FIRST blocked address wins. */
function verdictForAddresses(host: string, addrs: ResolvedAddress[]): string | null {
    if (!addrs.length) return `${host} resolved to no addresses`;
    // EVERY address, not just the first. A name with one public A record and one
    // 127.0.0.1 A record is an internal target — which of the two `fetch()`
    // picks is up to the resolver's ordering, so both must be safe or neither is.
    for (const a of addrs) {
        const reason = classifyAddress(a.address);
        if (reason) return `${host} resolves to ${a.address} — ${reason}`;
    }
    return null;
}

function defaultResolver(host: string): Promise<ResolvedAddress[]> {
    return new Promise<ResolvedAddress[]>((resolve, reject) => {
        dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => {
            if (err) reject(err);
            else resolve(addrs as ResolvedAddress[]);
        });
    });
}

let hostResolver: HostResolver = defaultResolver;

/**
 * In-flight lookups, so N concurrent guard calls for the same cold host issue
 * ONE query rather than N. The Gmail-push / probe-batch fan-out is exactly the
 * shape that produces simultaneous first-touches of the same host.
 */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Cached verdict for a hostname. Resolves to a reason string when the host must
 * be refused, or null when it is safe. Never rejects.
 *
 * Every write to the cache happens INSIDE this function, on the path that owns
 * the lookup — there is no off-path writer, so a stale answer cannot land on top
 * of a fresher verdict. (The deleted `warmHostAsync` could: a warm begun before
 * a host was known-internal could overwrite the 5-minute DENY with a 60-second
 * ALLOW after the fact.)
 */
async function resolveVerdict(host: string): Promise<string | null> {
    const hit = readCache(host);
    if (hit) return hit.reason;

    const pending = inFlight.get(host);
    if (pending) return pending;

    const run = (async (): Promise<string | null> => {
        const timeoutMs = envInt("MC_URL_GUARD_DNS_TIMEOUT_MS", DEFAULT_DNS_TIMEOUT_MS);
        let timer: NodeJS.Timeout | undefined;
        try {
            const addrs = await Promise.race([
                Promise.resolve(hostResolver(host)),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
                }),
            ]);
            const reason = verdictForAddresses(host, addrs);
            cacheVerdict(host, reason, false);
            return reason;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const reason = `could not resolve ${host} (${msg})`;
            cacheVerdict(host, reason, true);
            return reason;
        } finally {
            if (timer) clearTimeout(timer);
            inFlight.delete(host);
        }
    })();

    inFlight.set(host, run);
    return run;
}

export class UnsafeURLError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsafeURLError";
    }
}

/**
 * Test-only escape hatch. When `MC_ALLOW_PRIVATE_FETCH=1` is set in the env,
 * the private-network checks are skipped. The hermetic test fixtures point at
 * 127.0.0.1; without this they'd be (correctly) blocked. Production deployments
 * MUST NOT set this. The protocol check still fires either way.
 */
function privateFetchAllowed(): boolean {
    return process.env.MC_ALLOW_PRIVATE_FETCH === "1";
}

/**
 * Everything both entry points share: parse, protocol, literal host checks.
 * Returns the parsed URL plus the normalized host, or throws `UnsafeURLError`.
 * A null `host` in the result means "already fully judged — no resolution
 * needed" (bypass active, or the host was an IP literal we just cleared).
 */
function assertLiteralsSafe(raw: string): { parsed: URL; host: string | null } {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new UnsafeURLError(`Not a valid URL: ${raw}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        throw new UnsafeURLError(`Only http and https URLs are allowed (got ${parsed.protocol}).`);
    }
    if (!parsed.hostname) {
        throw new UnsafeURLError("URL has no hostname.");
    }
    const host = normalizeHost(parsed.hostname);
    if (!host) {
        throw new UnsafeURLError("URL has no hostname.");
    }
    if (privateFetchAllowed()) return { parsed, host: null };
    if (LITERAL_BLOCKLIST.has(host)) {
        throw new UnsafeURLError(`Refusing to fetch internal host: ${host}`);
    }
    // An IP literal is judged here and never resolved — both because there is
    // nothing to resolve and because this is the cheap path that must stay
    // ahead of any DNS work.
    if (hostIsIpLiteral(host)) {
        const reason = classifyAddress(host);
        if (reason) throw new UnsafeURLError(`Refusing to fetch internal address ${host} — ${reason}`);
        return { parsed, host: null };
    }
    return { parsed, host };
}

/**
 * Validates that `raw` is a safe external http(s) URL. Throws `UnsafeURLError`
 * with a user-actionable message otherwise.
 *
 * MUST be awaited — see "WHY THE API IS ASYNC" at the top of this file.
 */
export async function assertExternalHttpUrlAsync(raw: string): Promise<URL> {
    const { parsed, host } = assertLiteralsSafe(raw);
    if (host === null || isReservedNonResolvableName(host)) return parsed;
    const reason = await resolveVerdict(host);
    if (reason) throw new UnsafeURLError(`Refusing to fetch ${host}: ${reason}`);
    return parsed;
}

/**
 * After a fetch, re-validate the response's final URL (in case redirects
 * landed on an internal target). Throws `UnsafeURLError` if so.
 *
 * Strictly a backstop: by the time this runs the response has already been
 * fetched. `lib/postings/liveness.ts` guards each hop BEFORE following it,
 * which is the check that actually prevents the request.
 */
export async function assertSafeResponseUrlAsync(response: Response): Promise<void> {
    if (!response.url) return; // some fetch impls don't populate this
    await assertExternalHttpUrlAsync(response.url);
}

// ─── Test seams ───────────────────────────────────────────────────────────
// Production never calls these. They exist so hermetic smokes can exercise the
// resolution layer with no network.

/**
 * Swap in a stub resolver. Clears the cache so prior verdicts can't leak in.
 *
 * PLACEMENT NOTE for callers: `hostResolver` is read lazily, at guard-call time,
 * so a top-level `__setUrlGuardResolver(...)` in a smoke takes effect no matter
 * where it sits relative to the `import` statements — even though `tsx` emits
 * CJS and runs statements in source order today, while a move to
 * `"type": "module"` would hoist every import above it. Keep the read lazy: if
 * this module ever captured `hostResolver` at import time, that difference would
 * stop being cosmetic and a smoke's stub could silently fail to apply.
 */
export function __setUrlGuardResolver(fn: HostResolver): void {
    hostResolver = fn;
    hostCache.clear();
    inFlight.clear();
}

/** Restore the real resolver and drop cached verdicts. */
export function __resetUrlGuardResolver(): void {
    hostResolver = defaultResolver;
    hostCache.clear();
    inFlight.clear();
}

/** Drop cached verdicts without changing the resolver. */
export function __clearUrlGuardCache(): void {
    hostCache.clear();
    inFlight.clear();
}
