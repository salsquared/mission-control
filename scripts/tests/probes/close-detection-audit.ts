/**
 * C0 · Close-detection audit (closed-jobs feature, Track B).
 *
 * Design: docs/closed-jobs-feature.html → "Pillar C — sharper close-detection"
 * → C0. A DIAGNOSTIC probe (lives under scripts/tests/probes/ → NOT in the
 * pre-push gate; exit-zero is not a contract). Its job is to MEASURE the real
 * closure signals so C1's marker lists come from observed pages, not hunches.
 *
 * What it does:
 *   1. Samples JobPosting rows per ATS kind from dev.db (a mix of status="new"
 *      — the population Gap A lives in — and status="closed", whose source
 *      pages are the most likely to actually show a closure banner to read).
 *   2. Optionally prepends a small hand-seeded list of KNOWN-DEAD URLs
 *      (constant below, or via `--seed <url> --seed <url>` / a `seeds.txt`
 *      arg) so the sample is guaranteed to contain closed examples even if
 *      the live DB sample is all-alive.
 *   3. Re-probes each via the real `probePostingLiveness` from
 *      lib/postings/liveness.ts — so the verdict is exactly what production
 *      would draw.
 *   4. For EVERY non-`closed` verdict it CAPTURES + prints the raw page body
 *      (truncated) and the final (post-redirect) URL. Reporting verdict
 *      COUNTS alone can't reveal a MISSING phrase — dumping the body of
 *      alive/unknown pages that are really closed is the whole point: it
 *      surfaces the exact wording ("no longer accepting applications", "this
 *      job has expired", …) C1 should add to the tier-3 marker lists.
 *   5. Summarizes: closed-but-still-listed rate per kind + the unmatched
 *      closure-ish phrases observed across all dumped bodies.
 *
 * Body capture is done by wrapping globalThis.fetch for the duration of the
 * run (a tee that records {finalUrl, body} per request) — liveness.ts itself
 * only returns a verdict, and this script deliberately does NOT modify it.
 *
 * Resilience: live runs WILL rate-limit / time out. The sample is small by
 * default, every probe is in its own try/catch, and the script's value is
 * being correct + runnable for the operator even when a given run yields
 * little data.
 *
 * Run (small live sample; tolerate network failures):
 *   DATABASE_URL="file:./dev.db" EMAIL_ENABLED=0 \
 *     npx tsx scripts/tests/probes/close-detection-audit.ts
 *
 * Flags:
 *   --per-kind N      sample size per kind (default 6)
 *   --closed-frac F   fraction of each kind's sample drawn from status="closed"
 *                     rows (default 0.5) — closed pages are likelier to show a
 *                     readable closure banner
 *   --kind K          restrict to one kind (repeatable)
 *   --seed URL        add a known-dead URL to probe (repeatable)
 *   --body-chars N    body-dump truncation length (default 1200)
 */
import { prisma } from "@/lib/prisma";
import { probePostingLiveness, type LivenessResult, type WatchlistKind } from "@/lib/postings/liveness";
import { WATCHLIST_KINDS } from "@/lib/schemas/watchlists";

// ─── Seed known-dead URLs ─────────────────────────────────────────────────
// Hand-seeded postings believed dead, so the sample is guaranteed to contain
// closed examples whose bodies are worth reading. The manual mark-closed
// control (Track C) gives a growing supply — append confirmed-dead URLs here
// as they accumulate. `kind` must be one of WATCHLIST_KINDS so the right probe
// handler runs. Empty by default — populate from observed dead postings.
const SEED_DEAD: Array<{ kind: WatchlistKind; sourceUrl: string }> = [
    // Example shape (commented — fill with real dead URLs as found):
    // { kind: "greenhouse", sourceUrl: "https://job-boards.greenhouse.io/acme/jobs/0000000000" },
    // { kind: "linkedin",   sourceUrl: "https://www.linkedin.com/jobs/view/0000000000" },
];

// Closure-ish phrases we scan dumped bodies for, to flag wording the probe's
// current marker lists DON'T catch (the unmatched-phrase report). This is a
// detection net for the audit's OWN reporting — NOT the probe's marker list.
// Deliberately broad: a hit here on an `alive`/`unknown` page is a candidate
// for promotion into liveness.ts's per-kind closed-marker arrays.
const CLOSURE_PHRASE_NET = [
    "no longer accepting applications",
    "no longer accepting",
    "this job has expired",
    "job has expired",
    "this position has been filled",
    "position has been filled",
    "has been filled",
    "position is no longer available",
    "no longer available",
    "no longer active",
    "posting has closed",
    "position has closed",
    "this job is closed",
    "applications are closed",
    "application is closed",
    "we are no longer accepting",
    "this role has been filled",
    "this role is no longer",
    "this opening has been filled",
    "the position you are looking for",
    "job not found",
    "posting could not be found",
    "could not be found",
    "this job is no longer available",
    "this job is no longer accepting",
    "position is closed",
    "vacancy has been filled",
    "this requisition",
    "not currently accepting applications",
];

interface Args {
    perKind: number;
    closedFrac: number;
    kinds: WatchlistKind[];
    seeds: string[];
    bodyChars: number;
}

function parseArgs(argv: string[]): Args {
    const out: Args = { perKind: 6, closedFrac: 0.5, kinds: [], seeds: [], bodyChars: 1200 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--per-kind") out.perKind = Math.max(1, parseInt(next() ?? "6", 10) || 6);
        else if (a === "--closed-frac") out.closedFrac = Math.min(1, Math.max(0, parseFloat(next() ?? "0.5") || 0.5));
        else if (a === "--kind") { const k = next(); if (k && (WATCHLIST_KINDS as readonly string[]).includes(k)) out.kinds.push(k as WatchlistKind); }
        else if (a === "--seed") { const u = next(); if (u) out.seeds.push(u); }
        else if (a === "--body-chars") out.bodyChars = Math.max(120, parseInt(next() ?? "1200", 10) || 1200);
    }
    return out;
}

// ─── fetch tee: record {finalUrl, body} per request without touching liveness ─
interface Capture { finalUrl: string; body: string }
function installFetchTee(): { latestFor: (urlHint: string) => Capture | null; all: () => Capture[]; restore: () => void } {
    const original = globalThis.fetch;
    const captures: Array<{ requestUrl: string } & Capture> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const res = await original(input as RequestInfo | URL, init);
        // Clone so liveness.ts can still call res.text() itself.
        let body = "";
        try { body = await res.clone().text(); } catch { /* body unreadable (binary / aborted) — leave empty */ }
        captures.push({ requestUrl, finalUrl: res.url || requestUrl, body });
        return res;
    }) as typeof fetch;
    return {
        // Best-effort: the last capture whose request or final URL contains the
        // probed sourceUrl (handles the Greenhouse/Lever API indirection where
        // the probed URL differs from the sourceUrl).
        latestFor: (urlHint: string) => {
            for (let i = captures.length - 1; i >= 0; i--) {
                const c = captures[i];
                if (c.requestUrl.includes(urlHint) || urlHint.includes(c.requestUrl) || c.finalUrl.includes(urlHint)) {
                    return { finalUrl: c.finalUrl, body: c.body };
                }
            }
            // Fall back to the most recent capture (single-fetch probes).
            const last = captures[captures.length - 1];
            return last ? { finalUrl: last.finalUrl, body: last.body } : null;
        },
        all: () => captures.map(c => ({ finalUrl: c.finalUrl, body: c.body })),
        restore: () => { globalThis.fetch = original; },
    };
}

function truncate(s: string, n: number): string {
    const clean = s.replace(/\s+/g, " ").trim();
    return clean.length > n ? clean.slice(0, n) + `… [+${clean.length - n} chars]` : clean;
}

function unmatchedPhrasesIn(bodyLower: string): string[] {
    return CLOSURE_PHRASE_NET.filter(p => bodyLower.includes(p));
}

interface SampleItem { kind: WatchlistKind; externalId: string; sourceUrl: string; dbStatus: string }

async function sampleForKind(kind: WatchlistKind, perKind: number, closedFrac: number): Promise<SampleItem[]> {
    const closedTarget = Math.round(perKind * closedFrac);
    const newTarget = perKind - closedTarget;
    const sel = { externalId: true, sourceUrl: true, status: true } as const;

    // Drawing the most-recently-seen rows keeps the sample fresh (URLs less
    // likely to be DB-stale) and is deterministic enough for a diagnostic.
    const closedRows = closedTarget > 0
        ? await prisma.jobPosting.findMany({
            where: { status: "closed", watchlist: { kind } },
            select: sel, orderBy: { lastSeenAt: "desc" }, take: closedTarget,
        })
        : [];
    const newRows = newTarget > 0
        ? await prisma.jobPosting.findMany({
            where: { status: "new", watchlist: { kind } },
            select: sel, orderBy: { lastSeenAt: "desc" }, take: newTarget,
        })
        : [];

    return [...closedRows, ...newRows].map(r => ({
        kind, externalId: r.externalId, sourceUrl: r.sourceUrl, dbStatus: r.status,
    }));
}

interface KindStat {
    probed: number;
    closed: number;
    alive: number;
    unknown: number;
    errored: number;
    /** non-closed verdicts on rows whose DB status is "closed" → Gap B suspects. */
    closedButNotClosedVerdict: number;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const seedUrls = [...args.seeds];
    const targetKinds = args.kinds.length > 0 ? args.kinds : [...WATCHLIST_KINDS];

    console.log("═".repeat(72));
    console.log("CLOSE-DETECTION AUDIT (C0)  —  diagnostic, live network");
    console.log(`per-kind=${args.perKind}  closed-frac=${args.closedFrac}  kinds=[${targetKinds.join(", ")}]`);
    console.log(`seeds(cli)=${seedUrls.length}  seeds(constant)=${SEED_DEAD.length}`);
    console.log("═".repeat(72));

    // Build the work list.
    const items: SampleItem[] = [];
    for (const { kind, sourceUrl } of SEED_DEAD) {
        if (args.kinds.length === 0 || args.kinds.includes(kind)) {
            items.push({ kind, externalId: `seed:${sourceUrl}`, sourceUrl, dbStatus: "seed-dead" });
        }
    }
    // CLI seeds have no kind — probe them under each requested kind's handler so
    // the operator can compare handler behavior. Default to greenhouse+linkedin
    // when no --kind given (the two with both an API path and an HTML path).
    for (const u of seedUrls) {
        const ks = args.kinds.length > 0 ? args.kinds : (["greenhouse", "linkedin"] as WatchlistKind[]);
        for (const k of ks) items.push({ kind: k, externalId: `seed:${u}`, sourceUrl: u, dbStatus: "seed-dead" });
    }
    for (const kind of targetKinds) {
        try {
            const s = await sampleForKind(kind, args.perKind, args.closedFrac);
            items.push(...s);
        } catch (e) {
            console.warn(`[audit] sampling failed for kind=${kind}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (items.length === 0) {
        console.log("\nNo postings sampled (empty dev.db for these kinds and no seeds). Nothing to probe.");
        await prisma.$disconnect();
        return;
    }

    const stats: Record<string, KindStat> = {};
    const unmatchedPhraseCounts = new Map<string, number>();
    const tee = installFetchTee();

    for (const item of items) {
        const st = (stats[item.kind] ??= { probed: 0, closed: 0, alive: 0, unknown: 0, errored: 0, closedButNotClosedVerdict: 0 });
        let verdict: LivenessResult | "error";
        try {
            verdict = await probePostingLiveness(
                { externalId: item.externalId, sourceUrl: item.sourceUrl },
                item.kind,
            );
        } catch (e) {
            verdict = "error";
            console.warn(`[audit] probe threw kind=${item.kind} url=${item.sourceUrl}: ${e instanceof Error ? e.message : String(e)}`);
        }

        st.probed++;
        if (verdict === "closed") st.closed++;
        else if (verdict === "alive") st.alive++;
        else if (verdict === "unknown") st.unknown++;
        else st.errored++;

        // The crux: dump body + final URL for EVERY non-closed verdict so a
        // MISSING phrase becomes visible. Doubly interesting when dbStatus is
        // already "closed"/"seed-dead" but the verdict isn't "closed" (Gap B).
        if (verdict !== "closed") {
            const cap = tee.latestFor(item.sourceUrl);
            const finalUrl = cap?.finalUrl ?? "(no capture)";
            const body = cap?.body ?? "";
            const bodyLower = body.toLowerCase();
            const hits = unmatchedPhrasesIn(bodyLower);
            for (const h of hits) unmatchedPhraseCounts.set(h, (unmatchedPhraseCounts.get(h) ?? 0) + 1);

            const suspect = item.dbStatus === "closed" || item.dbStatus === "seed-dead";
            if (suspect) st.closedButNotClosedVerdict++;

            console.log("\n" + "─".repeat(72));
            console.log(`[${item.kind}] verdict=${verdict}  dbStatus=${item.dbStatus}${suspect ? "  ⚠ EXPECTED-CLOSED" : ""}`);
            console.log(`  sourceUrl: ${item.sourceUrl}`);
            console.log(`  finalUrl : ${finalUrl}`);
            if (hits.length) console.log(`  ⚑ closure-net phrases present but NOT caught by probe: ${hits.map(h => JSON.stringify(h)).join(", ")}`);
            console.log(`  body (${args.bodyChars} chars):`);
            console.log("  " + (body ? truncate(body, args.bodyChars) : "(empty / unreadable body)"));
        }
    }

    tee.restore();

    // ─── Summary ──────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(72));
    console.log("SUMMARY — closed-but-still-listed rate per kind");
    console.log("═".repeat(72));
    console.log(
        ["kind".padEnd(16), "probed".padStart(7), "closed".padStart(7), "alive".padStart(7), "unknown".padStart(8), "err".padStart(5), "missed*".padStart(8)].join(" "),
    );
    for (const kind of Object.keys(stats).sort()) {
        const s = stats[kind];
        console.log(
            [
                kind.padEnd(16),
                String(s.probed).padStart(7),
                String(s.closed).padStart(7),
                String(s.alive).padStart(7),
                String(s.unknown).padStart(8),
                String(s.errored).padStart(5),
                String(s.closedButNotClosedVerdict).padStart(8),
            ].join(" "),
        );
    }
    console.log("\n* missed = rows whose DB status was closed/seed-dead but the live");
    console.log("  probe did NOT return 'closed' → Gap B suspects (200-but-closed,");
    console.log("  or alive/unknown that needs a sharper marker).");

    console.log("\n" + "═".repeat(72));
    console.log("UNMATCHED CLOSURE PHRASES (present in dumped bodies, not caught by probe)");
    console.log("═".repeat(72));
    if (unmatchedPhraseCounts.size === 0) {
        console.log("(none observed — either no closed pages were sampled, or the existing");
        console.log(" markers already caught every closure banner in this run)");
    } else {
        const sorted = [...unmatchedPhraseCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [phrase, n] of sorted) console.log(`  ${String(n).padStart(4)}×  ${JSON.stringify(phrase)}`);
        console.log("\n→ Promote the recurring ones into the relevant per-kind closed-marker");
        console.log("  array in lib/postings/liveness.ts (C1). Stay conservative: prefer");
        console.log("  phrases unambiguous about closure, and pair generic-kind body checks");
        console.log("  with an alive-marker gate so a 200-but-ambiguous page stays 'unknown'.");
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error("Unhandled error:", e);
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
