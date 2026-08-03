/**
 * Unit smoke for lib/security/url-guard.ts.
 *
 *   npx tsx scripts/tests/hermetic/url-guard-smoke.ts
 *
 * HERMETIC — no network. The guard's resolution layer (layer 2) is driven
 * through a STUB resolver installed below, so this file never issues a real DNS
 * query. That is deliberate twice over: the pre-push gate must pass offline, and
 * a stub lets us assert on answers a live resolver would not reliably give us.
 * `127.0.0.1.nip.io` and `localtest.me` genuinely resolve to 127.0.0.1 in the
 * wild, but a resolver with rebinding protection (this machine's, as it happens)
 * returns NXDOMAIN for both — so a live-DNS version of these tests would pass
 * for the WRONG reason ("could not resolve") and would keep passing if the
 * address classifier broke.
 */
import {
    assertExternalHttpUrlAsync,
    assertSafeResponseUrlAsync,
    UnsafeURLError,
    __setUrlGuardResolver,
    __resetUrlGuardResolver,
    __clearUrlGuardCache,
    type ResolvedAddress,
} from "@/lib/security/url-guard";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── Stub resolver ───────────────────────────────────────────────────────
// Any host not named here resolves to a public address, so the ordinary
// allow-cases below need no per-host fixture.

const PUBLIC_V4: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];
const NXDOMAIN = Symbol("nxdomain");

// Fixture hosts sit under `.test`, NOT `.example` / `.invalid`. That is
// load-bearing: the guard exempts the IANA-reserved documentation names from
// layer 2 (see isReservedNonResolvableName), so a fixture named `*.example`
// would skip resolution entirely and every assertion below would pass
// vacuously. `.test` is deliberately NOT exempt, so these reach the resolver.
const DNS_FIXTURES: Record<string, ResolvedAddress[] | typeof NXDOMAIN> = {
    // The reported gap: wildcard DNS services that encode an IP in the name.
    "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }],
    "localtest.me": [{ address: "127.0.0.1", family: 4 }],
    "169.254.169.254.nip.io": [{ address: "169.254.169.254", family: 4 }],
    "10-0-0-1.sslip.io": [{ address: "10.0.0.1", family: 4 }],
    // `<anything>.localhost` MUST resolve to loopback per RFC 6761 §6.3, and is
    // not covered by LITERAL_BLOCKLIST (which only holds the bare name). Layer 2
    // is the only thing that stops it — hence the fixture.
    "app.localhost": [{ address: "127.0.0.1", family: 4 }],
    // One public record and one internal record. Which one `fetch` picks is the
    // resolver's business, so the pair must be refused.
    "mixed-records.dns.test": [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
    ],
    "mixed-v6.dns.test": [
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        { address: "fd00::1", family: 6 },
    ],
    // IPv6 shapes a resolver really does return.
    "v6-loopback.dns.test": [{ address: "::1", family: 6 }],
    "v6-mapped.dns.test": [{ address: "::ffff:127.0.0.1", family: 6 }],
    "v6-mapped-hex.dns.test": [{ address: "::ffff:7f00:1", family: 6 }],
    "v6-mapped-metadata.dns.test": [{ address: "::ffff:169.254.169.254", family: 6 }],
    "v6-translated.dns.test": [{ address: "::ffff:0:7f00:1", family: 6 }],
    "v6-ula.dns.test": [{ address: "fd9b:1234::5", family: 6 }],
    "v6-linklocal.dns.test": [{ address: "fe80::1", family: 6 }],
    "v6-nat64.dns.test": [{ address: "64:ff9b::7f00:1", family: 6 }],
    "v6-nat64-local.dns.test": [{ address: "64:ff9b:1::7f00:1", family: 6 }],
    "v6-6to4.dns.test": [{ address: "2002:7f00:1::", family: 6 }],
    "v6-teredo.dns.test": [{ address: "2001::7f00:1", family: 6 }],
    "v6-public.dns.test": [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
    // Failure modes. All must refuse — this module never degrades to "allow".
    "nxdomain.dns.test": NXDOMAIN,
    "empty-answer.dns.test": [],
    "garbage-answer.dns.test": [{ address: "not-an-ip", family: 4 }],
};

let resolverCalls: string[] = [];

function installStubResolver() {
    resolverCalls = [];
    __setUrlGuardResolver((host) => {
        resolverCalls.push(host);
        const fixture = DNS_FIXTURES[host];
        if (fixture === NXDOMAIN) throw new Error("ENOTFOUND");
        return fixture ?? PUBLIC_V4;
    });
}

async function shouldAllow(url: string, label: string) {
    try {
        await assertExternalHttpUrlAsync(url);
        pass(`allow: ${label}`);
    } catch (e) {
        fail(`allow: ${label} — but got ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function shouldReject(url: string, label: string) {
    try {
        await assertExternalHttpUrlAsync(url);
        fail(`reject: ${label} — but accepted`);
    } catch (e) {
        if (e instanceof UnsafeURLError) pass(`reject: ${label}`);
        else fail(`reject: ${label} — wrong error type`, e);
    }
}

async function testLiteralLayer() {
    // ─── Allowed ─────────────────────────────────────────────────────────
    await shouldAllow("https://example.com/jobs", "https example.com");
    await shouldAllow("http://anthropic.com/careers", "http anthropic.com");
    await shouldAllow("https://boards-api.greenhouse.io/v1/boards/anthropic/jobs", "greenhouse api");
    await shouldAllow("https://api.lever.co/v0/postings/spotify?dept=eng", "lever w/ querystring");
    await shouldAllow("https://203.0.113.50/jobs", "public IP (TEST-NET-3 documentation range)");

    // ─── Rejected — protocols ────────────────────────────────────────────
    await shouldReject("file:///etc/passwd", "file://");
    await shouldReject("ftp://example.com/", "ftp://");
    await shouldReject("javascript:alert(1)", "javascript:");
    await shouldReject("data:text/html,foo", "data:");
    await shouldReject("gopher://example.com/", "gopher://");

    // ─── Rejected — loopback / literal hostnames ─────────────────────────
    await shouldReject("http://localhost/admin", "localhost");
    await shouldReject("http://127.0.0.1:6379", "127.0.0.1 Redis");
    await shouldReject("http://127.0.0.1", "127.0.0.1 bare");
    await shouldReject("http://0.0.0.0/", "0.0.0.0");
    await shouldReject("http://[::1]/", "IPv6 loopback ::1");
    await shouldReject("http://host.docker.internal/", "host.docker.internal");

    // ─── Rejected — private IPv4 ─────────────────────────────────────────
    await shouldReject("http://10.0.0.5/", "10.0.0.0/8");
    await shouldReject("http://10.255.255.255/", "10.0.0.0/8 upper");
    await shouldReject("http://172.16.0.1/", "172.16.0.0/12 lower");
    await shouldReject("http://172.31.255.255/", "172.16.0.0/12 upper");
    await shouldReject("http://192.168.1.1/", "192.168.0.0/16");

    // ─── Rejected — cloud metadata ───────────────────────────────────────
    await shouldReject("http://169.254.169.254/latest/meta-data/", "AWS IMDS");
    await shouldReject("http://169.254.169.254/computeMetadata/v1/instance/", "GCP metadata");

    // ─── Rejected — IPv6 private ─────────────────────────────────────────
    await shouldReject("http://[fc00::1]/", "IPv6 unique-local fc00::/7");
    await shouldReject("http://[fe80::1]/", "IPv6 link-local fe80::/10");

    // ─── Rejected — invalid ──────────────────────────────────────────────
    await shouldReject("not a url", "garbage string");
    await shouldReject("https://", "missing hostname");

    // Boundary: just outside the private ranges.
    await shouldAllow("http://172.15.0.1/", "172.15.x (outside private range)");
    await shouldAllow("http://172.32.0.1/", "172.32.x (outside private range)");
}

async function testClosedLiteralBypasses() {
    // All of these were ADMITTED by the pre-2026-08-02 code, verified by running
    // the old file. They never needed DNS — they are string-canonicalization
    // holes.

    // `URL.hostname` keeps a NAME's trailing dot, so `localhost.` walked straight
    // past the literal blocklist. (It strips the dot on an IP-shaped host, which
    // is why `127.0.0.1.` was never affected.)
    await shouldReject("http://localhost./admin", "trailing-dot FQDN localhost.");
    await shouldReject("http://HOST.DOCKER.INTERNAL./", "trailing dot + uppercase");

    // WHATWG re-serializes an IPv4-mapped IPv6 literal into hex, so the old
    // `startsWith("::ffff:")` branch handed `7f00:1` to a dotted-quad parser and
    // got false. Every IPv4-mapped literal was admitted.
    await shouldReject("http://[::ffff:127.0.0.1]/", "IPv4-mapped IPv6 loopback (dotted form)");
    await shouldReject("http://[::ffff:7f00:1]/", "IPv4-mapped IPv6 loopback (hex form)");
    await shouldReject("http://[::ffff:169.254.169.254]/", "IPv4-mapped IMDS");
    await shouldReject("http://[::ffff:c0a8:1]/", "IPv4-mapped 192.168.0.1");
    await shouldReject("http://[0:0:0:0:0:ffff:127.0.0.1]/", "IPv4-mapped, uncompressed");

    // Other IPv4-in-IPv6 embeddings that route to the embedded address on
    // networks that implement them. The `::ffff:0:0:0/96` pair is one bit-pattern
    // from IPv4-mapped and is the near-miss most likely to be missed.
    await shouldReject("http://[64:ff9b::7f00:1]/", "NAT64-embedded 127.0.0.1");
    await shouldReject("http://[2002:7f00:1::]/", "6to4-embedded 127.0.0.1");
    await shouldReject("http://[::127.0.0.1]/", "deprecated IPv4-compatible ::127.0.0.1");
    await shouldReject("http://[::ffff:0:7f00:1]/", "RFC 6052 IPv4-translated 127.0.0.1");
    await shouldReject("http://[::ffff:0:a00:1]/", "RFC 6052 IPv4-translated 10.0.0.1");
    await shouldReject("http://[64:ff9b:1::7f00:1]/", "RFC 8215 local-use NAT64");
    await shouldReject("http://[2001::7f00:1]/", "Teredo 2001::/32");
    await shouldReject("http://192.88.99.1/", "192.88.99.0/24 6to4 relay anycast");

    // Newly-classified ranges (never legitimate fetch targets).
    await shouldReject("http://100.64.0.1/", "100.64.0.0/10 CGNAT");
    await shouldReject("http://198.18.0.1/", "198.18.0.0/15 benchmarking");
    await shouldReject("http://224.0.0.1/", "224.0.0.0/4 multicast");
    await shouldReject("http://255.255.255.255/", "broadcast");
    await shouldReject("http://[ff02::1]/", "IPv6 multicast ff00::/8");
    await shouldReject("http://metadata.google.internal/computeMetadata/v1/", "GCE metadata alias");

    // Public IPv6 must still pass — the classifier is not blanket-denying v6,
    // and the Teredo branch must not swallow ordinary 2001::/16 space.
    await shouldAllow("http://[2606:2800:220:1:248:1893:25c8:1946]/", "public IPv6 literal");
    await shouldAllow("http://[2001:4860:4860::8888]/", "public 2001:4860:: (not Teredo)");
    await shouldAllow("http://[2001:db8::1]/", "2001:db8:: documentation (not Teredo)");
}

async function testResolutionLayer() {
    // The reported gap. Every one of these was ALLOWED before this change.
    await shouldReject("http://127.0.0.1.nip.io/", "nip.io wildcard → 127.0.0.1");
    await shouldReject("http://localtest.me/", "localtest.me → 127.0.0.1");
    await shouldReject("http://169.254.169.254.nip.io/latest/meta-data/", "nip.io → IMDS");
    await shouldReject("http://10-0-0-1.sslip.io/", "sslip.io → 10.0.0.1");
    await shouldReject("http://app.localhost/", "*.localhost resolves to loopback (bare name is blocklisted, this one is not)");

    // Requirement: EVERY resolved address is checked, not just the first.
    await shouldReject("https://mixed-records.dns.test/", "multi-record host, 2nd record is 127.0.0.1");
    await shouldReject("https://mixed-v6.dns.test/", "multi-record host, 2nd record is fd00::1");

    // Requirement: IPv6 coverage through the resolver, not only as a literal.
    await shouldReject("https://v6-loopback.dns.test/", "resolves to ::1");
    await shouldReject("https://v6-mapped.dns.test/", "resolves to ::ffff:127.0.0.1");
    await shouldReject("https://v6-mapped-hex.dns.test/", "resolves to ::ffff:7f00:1");
    await shouldReject("https://v6-mapped-metadata.dns.test/", "resolves to ::ffff:169.254.169.254");
    await shouldReject("https://v6-translated.dns.test/", "resolves to ::ffff:0:7f00:1");
    await shouldReject("https://v6-ula.dns.test/", "resolves to fd9b:1234::5 (fc00::/7)");
    await shouldReject("https://v6-linklocal.dns.test/", "resolves to fe80::1");
    await shouldReject("https://v6-nat64.dns.test/", "resolves to 64:ff9b::7f00:1");
    await shouldReject("https://v6-nat64-local.dns.test/", "resolves to 64:ff9b:1::7f00:1");
    await shouldReject("https://v6-6to4.dns.test/", "resolves to 2002:7f00:1::");
    await shouldReject("https://v6-teredo.dns.test/", "resolves to 2001::7f00:1");
    await shouldAllow("https://v6-public.dns.test/", "resolves to a public IPv6");

    // Requirement: FAIL CLOSED on every flavour of resolution failure.
    await shouldReject("https://nxdomain.dns.test/", "resolution failure (NXDOMAIN) → refused");
    await shouldReject("https://empty-answer.dns.test/", "resolver returned zero addresses → refused");
    await shouldReject("https://garbage-answer.dns.test/", "resolver returned an unparseable address → refused");

    // A throwing resolver must refuse a host that would otherwise be fine.
    __setUrlGuardResolver(() => { throw new Error("EAI_AGAIN"); });
    await shouldReject("https://boards.greenhouse.io/x", "resolver throwing for every host → refused");
    installStubResolver();

    // A REJECTING (async) resolver must be treated identically to a throwing one.
    __setUrlGuardResolver(() => Promise.reject(new Error("ESERVFAIL")));
    await shouldReject("https://boards.greenhouse.io/y", "resolver rejecting for every host → refused");
    installStubResolver();
}

async function testCarveOut() {
    // Reserved IANA names skip layer 2 so the hermetic tier's fetch fixtures
    // keep working. The pairing matters: reserved names are exempt, look-alikes
    // are NOT.
    __clearUrlGuardCache();
    resolverCalls = [];
    for (const u of ["https://verdict-alive.example/x", "https://anything.invalid/x",
                     "https://jobs.example.com/x", "https://boards.example.net/x",
                     "https://x.example.org/x", "https://example.com/x"]) {
        await shouldAllow(u, `reserved fixture name exempt from resolution: ${new URL(u).hostname}`);
    }
    if (resolverCalls.length === 0) pass("carve-out: reserved names issue zero DNS lookups");
    else fail(`carve-out: reserved names issued ${resolverCalls.length} lookups`, resolverCalls);

    // `.test` and `.localhost` are deliberately NOT exempt — `.test` is commonly
    // wired to loopback on dev machines and `.localhost` MUST be, so both have
    // to keep reaching layer 2. `notexample.com` proves the suffix match is
    // anchored; the bare labels prove a single-label host is never exempt (a DNS
    // search suffix turns `invalid` into something internal).
    __clearUrlGuardCache();
    resolverCalls = [];
    await shouldReject("http://app.localhost/", ".localhost is NOT carved out");
    await shouldReject("https://mixed-records.dns.test/", ".test is NOT carved out");
    await assertExternalHttpUrlAsync("https://notexample.com/x");
    await assertExternalHttpUrlAsync("http://invalid/");
    await assertExternalHttpUrlAsync("http://example/");
    if (resolverCalls.length === 5) pass("carve-out: .test / .localhost / notexample.com / bare labels still resolve");
    else fail(`carve-out: expected 5 lookups, got ${resolverCalls.length}`, resolverCalls);
}

async function testOrderingAndCaching() {
    // Literals are judged before any DNS work. Not cosmetic: liveness.ts runs
    // this guard per probe AND per redirect hop, up to 200 probes a batch.
    __clearUrlGuardCache();
    resolverCalls = [];
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/", "http://[fc00::1]/",
                     "http://localhost/", "ftp://example.com/"]) {
        try { await assertExternalHttpUrlAsync(u); } catch { /* expected */ }
    }
    if (resolverCalls.length === 0) pass("ordering: literal rejections issue zero DNS lookups");
    else fail(`ordering: literal rejections issued ${resolverCalls.length} lookups`, resolverCalls);

    // One lookup per host, not one per call.
    __clearUrlGuardCache();
    resolverCalls = [];
    for (let i = 0; i < 50; i++) await assertExternalHttpUrlAsync(`https://cached.dns.test/posting/${i}`);
    if (resolverCalls.length === 1) pass("cache: 50 calls for one host → 1 resolver lookup");
    else fail(`cache: expected 1 lookup for 50 calls, got ${resolverCalls.length}`);

    // A DENIAL is cached too — a blocked host must not re-resolve on every hit.
    resolverCalls = [];
    for (let i = 0; i < 10; i++) {
        try { await assertExternalHttpUrlAsync(`http://localtest.me/${i}`); } catch { /* expected */ }
    }
    if (resolverCalls.length === 1) pass("cache: denials are cached (10 calls → 1 lookup)");
    else fail(`cache: expected 1 lookup for 10 denied calls, got ${resolverCalls.length}`);

    // A resolution FAILURE is cached only briefly (FAILURE_TTL_MS = 10s). Long
    // enough to collapse the repeat-lookup storm a permanently-dead host would
    // otherwise cause on every probe of every tick; short enough that a
    // recovering host is admitted on the next scheduler tick rather than being
    // locked out for the full deny TTL.
    resolverCalls = [];
    for (let i = 0; i < 3; i++) {
        try { await assertExternalHttpUrlAsync(`https://nxdomain.dns.test/${i}`); } catch { /* expected */ }
    }
    if (resolverCalls.length === 1) pass("cache: resolution failures are cached briefly (3 calls → 1 lookup)");
    else fail(`cache: expected 1 lookup for 3 failing calls, got ${resolverCalls.length}`);
}

async function testLruNotFifo() {
    // A Map preserves INSERTION order and `set` on an existing key does not move
    // it, so the naive "evict the first key" policy is FIFO. Under FIFO a hot
    // legitimate host ages out no matter how often it is used, which lets an
    // attacker flush every real verdict with junk hostnames. Assert real LRU:
    // re-reading the hot host must move it to most-recently-used.
    __clearUrlGuardCache();
    resolverCalls = [];
    const HOT = "https://hot.dns.test/x";
    await assertExternalHttpUrlAsync(HOT);            // lookup 1; hot is oldest

    for (let i = 0; i < 300; i++) await assertExternalHttpUrlAsync(`https://junk-a-${i}.dns.test/x`);
    const before = resolverCalls.length;
    await assertExternalHttpUrlAsync(HOT);            // must be a HIT, and refresh recency
    if (resolverCalls.length !== before) {
        fail("LRU: hot host was evicted after only 300 inserts (cache max is 512)");
        return;
    }
    for (let i = 0; i < 300; i++) await assertExternalHttpUrlAsync(`https://junk-b-${i}.dns.test/x`);
    const before2 = resolverCalls.length;
    await assertExternalHttpUrlAsync(HOT);
    if (resolverCalls.length === before2) {
        pass("LRU: a re-read hot host survives 600 junk hostnames (FIFO would have evicted it)");
    } else {
        fail("LRU: hot host evicted despite being re-read — eviction is FIFO, not LRU");
    }
}

async function testSingleFlight() {
    // N concurrent first-touches of one cold host must issue ONE query. The
    // probe-batch / Gmail-push fan-out is exactly that shape.
    __clearUrlGuardCache();
    resolverCalls = [];
    __setUrlGuardResolver(async (host) => {
        resolverCalls.push(host);
        await new Promise(r => setTimeout(r, 20));
        return PUBLIC_V4;
    });
    await Promise.all(
        Array.from({ length: 25 }, (_, i) => assertExternalHttpUrlAsync(`https://burst.dns.test/p/${i}`)),
    );
    if (resolverCalls.length === 1) pass("single-flight: 25 concurrent calls for one cold host → 1 lookup");
    else fail(`single-flight: expected 1 lookup, got ${resolverCalls.length}`);
    installStubResolver();
}

async function testResponseBackstop() {
    __clearUrlGuardCache();
    const internal = new Response("x", { status: 200 });
    Object.defineProperty(internal, "url", { value: "http://127.0.0.1:9999/admin" });
    try {
        await assertSafeResponseUrlAsync(internal);
        fail("response backstop: internal final URL was accepted");
    } catch (e) {
        if (e instanceof UnsafeURLError) pass("response backstop: internal final URL refused");
        else fail("response backstop: wrong error type", e);
    }

    // A response with no `url` (some fetch impls) must not throw.
    const bare = new Response("x", { status: 200 });
    Object.defineProperty(bare, "url", { value: "" });
    try {
        await assertSafeResponseUrlAsync(bare);
        pass("response backstop: empty response.url is a no-op");
    } catch (e) {
        fail("response backstop: empty response.url should not throw", e);
    }
}

async function testEscapeHatch() {
    // MC_ALLOW_PRIVATE_FETCH=1 skips BOTH layers (hermetic fixtures on
    // 127.0.0.1). It is the ONLY env var that can loosen this module.
    __clearUrlGuardCache();
    process.env.MC_ALLOW_PRIVATE_FETCH = "1";
    await shouldAllow("http://127.0.0.1:4101/api/system", "MC_ALLOW_PRIVATE_FETCH=1 admits loopback");
    await shouldAllow("http://127.0.0.1.nip.io/", "MC_ALLOW_PRIVATE_FETCH=1 admits a resolving-internal host");
    await shouldReject("file:///etc/passwd", "MC_ALLOW_PRIVATE_FETCH=1 still enforces the protocol check");
    delete process.env.MC_ALLOW_PRIVATE_FETCH;

    // Restored: the gap is closed again.
    __clearUrlGuardCache();
    await shouldReject("http://127.0.0.1.nip.io/", "gap closed again once the hatch is cleared");
}

async function main() {
    installStubResolver();
    await testLiteralLayer();
    await testClosedLiteralBypasses();
    await testResolutionLayer();
    await testCarveOut();
    await testOrderingAndCaching();
    await testLruNotFifo();
    await testSingleFlight();
    await testResponseBackstop();
    await testEscapeHatch();
    __resetUrlGuardResolver();

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

void main();
