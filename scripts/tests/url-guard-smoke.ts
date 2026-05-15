/**
 * Unit smoke for lib/security/url-guard.ts.
 *
 *   npx tsx scripts/tests/url-guard-smoke.ts
 */
import { assertExternalHttpUrl, UnsafeURLError } from "@/lib/security/url-guard";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function shouldAllow(url: string, label: string) {
    try {
        assertExternalHttpUrl(url);
        pass(`allow: ${label}`);
    } catch (e) {
        fail(`allow: ${label} — but got ${e instanceof Error ? e.message : String(e)}`);
    }
}

function shouldReject(url: string, label: string) {
    try {
        assertExternalHttpUrl(url);
        fail(`reject: ${label} — but accepted`);
    } catch (e) {
        if (e instanceof UnsafeURLError) pass(`reject: ${label}`);
        else fail(`reject: ${label} — wrong error type`, e);
    }
}

// ─── Allowed ─────────────────────────────────────────────────────────────
shouldAllow("https://example.com/jobs", "https example.com");
shouldAllow("http://anthropic.com/careers", "http anthropic.com");
shouldAllow("https://boards-api.greenhouse.io/v1/boards/anthropic/jobs", "greenhouse api");
shouldAllow("https://api.lever.co/v0/postings/spotify?dept=eng", "lever w/ querystring");
shouldAllow("https://203.0.113.50/jobs", "public IP (TEST-NET-3 documentation range)");

// ─── Rejected — protocols ────────────────────────────────────────────────
shouldReject("file:///etc/passwd", "file://");
shouldReject("ftp://example.com/", "ftp://");
shouldReject("javascript:alert(1)", "javascript:");
shouldReject("data:text/html,foo", "data:");
shouldReject("gopher://example.com/", "gopher://");

// ─── Rejected — loopback / literal hostnames ─────────────────────────────
shouldReject("http://localhost/admin", "localhost");
shouldReject("http://127.0.0.1:6379", "127.0.0.1 Redis");
shouldReject("http://127.0.0.1", "127.0.0.1 bare");
shouldReject("http://0.0.0.0/", "0.0.0.0");
shouldReject("http://[::1]/", "IPv6 loopback ::1");
shouldReject("http://host.docker.internal/", "host.docker.internal");

// ─── Rejected — private IPv4 ─────────────────────────────────────────────
shouldReject("http://10.0.0.5/", "10.0.0.0/8");
shouldReject("http://10.255.255.255/", "10.0.0.0/8 upper");
shouldReject("http://172.16.0.1/", "172.16.0.0/12 lower");
shouldReject("http://172.31.255.255/", "172.16.0.0/12 upper");
shouldReject("http://192.168.1.1/", "192.168.0.0/16");

// ─── Rejected — cloud metadata ───────────────────────────────────────────
shouldReject("http://169.254.169.254/latest/meta-data/", "AWS IMDS");
shouldReject("http://169.254.169.254/computeMetadata/v1/instance/", "GCP metadata");

// ─── Rejected — IPv6 private ─────────────────────────────────────────────
shouldReject("http://[fc00::1]/", "IPv6 unique-local fc00::/7");
shouldReject("http://[fe80::1]/", "IPv6 link-local fe80::/10");

// ─── Rejected — invalid ──────────────────────────────────────────────────
shouldReject("not a url", "garbage string");
shouldReject("https://", "missing hostname");

// 172.15.x (just outside the private range) should pass — boundary test.
shouldAllow("http://172.15.0.1/", "172.15.x (outside private range)");
shouldAllow("http://172.32.0.1/", "172.32.x (outside private range)");

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
