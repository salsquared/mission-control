/**
 * Live job-board diagnostic. Hits every fetcher with real-world configs and
 * filters the results for a keyword, so you can answer:
 *
 *   "If I say I want 'avionics intern' postings, which sources actually
 *    return matches today?"
 *
 * Sources covered:
 *   1. LinkedIn — keyword-search fetcher with the query directly.
 *   2. Each entry in lib/company-directory.ts — runs the appropriate
 *      Greenhouse / Lever / Ashby / Workday fetcher and case-insensitively
 *      filters titles + snippets for the keyword.
 *
 * Hits real external APIs — DO NOT wire into pre-push. Run on demand.
 *
 *   DATABASE_URL="file:./dev.db" \
 *   npx tsx scripts/tests/job-search-live.ts \
 *     --query "avionics intern" \
 *     [--location "Remote"] \
 *     [--source linkedin|greenhouse|workday]  # filter to one fetcher type
 *
 * Exit codes: 0 if at least one source returned ≥ 1 matching posting,
 * 1 if every source returned 0 matches (helpful for "are my keywords too
 * narrow?" sanity checks), 2 on hard error.
 */
import { COMPANY_DIRECTORY } from "@/lib/company-directory";
import { fetchLinkedin } from "@/lib/fetchers/linkedin-fetcher";
import { fetchGreenhouse } from "@/lib/fetchers/greenhouse-fetcher";
import { fetchLever } from "@/lib/fetchers/lever-fetcher";
import { fetchAshby } from "@/lib/fetchers/ashby-fetcher";
import { fetchWorkday } from "@/lib/fetchers/workday-fetcher";
import type { RawPosting } from "@/lib/fetchers/careers-page-fetcher";

interface Args {
    query: string;
    location?: string;
    source?: string;
    /** LinkedIn time window: 24h (default for recurring crawls), week, month, any. */
    timeRange: "24h" | "week" | "month" | "any";
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    // Default --time-range to "week" for one-shot discovery — the production
    // LinkedIn fetcher uses 24h, which is too narrow for "does this query
    // ever match anything" validation.
    const out: Args = { query: "avionics intern", timeRange: "week" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--location") out.location = argv[++i];
        else if (a === "--source") out.source = argv[++i]?.toLowerCase();
        else if (a === "--time-range") {
            const v = argv[++i] as Args["timeRange"];
            if (["24h", "week", "month", "any"].includes(v)) out.timeRange = v;
        }
    }
    return out;
}


// Same matching shape as the watchlist negative-filter feature uses.
function postingMatches(p: RawPosting, q: string): boolean {
    if (!q) return true;
    const haystack = `${p.title}\n${p.snippet ?? ""}\n${p.location ?? ""}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).every(token => haystack.includes(token));
}

interface SourceReport {
    label: string;
    kind: string;
    ok: boolean;
    error?: string;
    totalFetched: number;
    matches: RawPosting[];
    elapsedMs: number;
}

async function runSource(label: string, kind: string, fn: () => Promise<{ ok: boolean; postings?: RawPosting[]; error?: string }>, query: string): Promise<SourceReport> {
    const t0 = Date.now();
    try {
        const res = await fn();
        const elapsedMs = Date.now() - t0;
        if (!res.ok) return { label, kind, ok: false, error: res.error ?? "unknown", totalFetched: 0, matches: [], elapsedMs };
        const all = res.postings ?? [];
        const matches = all.filter(p => postingMatches(p, query));
        return { label, kind, ok: true, totalFetched: all.length, matches, elapsedMs };
    } catch (e) {
        const elapsedMs = Date.now() - t0;
        return { label, kind, ok: false, error: e instanceof Error ? e.message : String(e), totalFetched: 0, matches: [], elapsedMs };
    }
}

function printReport(r: SourceReport, query: string) {
    const ts = `${r.elapsedMs}ms`.padStart(7);
    if (!r.ok) {
        console.log(`  ${ts}  [${r.kind.padEnd(10)}] ${r.label.padEnd(20)} ✗ ${r.error}`);
        return;
    }
    const headline = `  ${ts}  [${r.kind.padEnd(10)}] ${r.label.padEnd(20)} → ${r.totalFetched} fetched · ${r.matches.length} match "${query}"`;
    console.log(r.matches.length > 0 ? headline : `\x1b[2m${headline}\x1b[0m`);
    for (const p of r.matches.slice(0, 5)) {
        console.log(`               • ${p.title}${p.location ? ` (${p.location})` : ""}`);
    }
    if (r.matches.length > 5) console.log(`               …and ${r.matches.length - 5} more`);
}

async function main() {
    const args = parseArgs();
    console.log(`Job-board live search: "${args.query}"${args.location ? ` in "${args.location}"` : ""}`);
    if (args.source) console.log(`(filtered to source kind: ${args.source})`);
    console.log("");

    const reports: SourceReport[] = [];

    // 1. LinkedIn (keyword-search, not per-company)
    if (!args.source || args.source === "linkedin") {
        const r = await runSource(
            `linkedin keyword (${args.timeRange})`,
            "linkedin",
            () => fetchLinkedin({
                kind: "linkedin",
                keywords: args.query,
                location: args.location,
                timeRange: args.timeRange,
                companyName: "LinkedIn search",
            }),
            args.query,
        );
        printReport(r, args.query);
        reports.push(r);
    }

    // 2. Per-company directory entries
    for (const entry of COMPANY_DIRECTORY) {
        if (args.source && args.source !== entry.config.kind) continue;
        let promise;
        switch (entry.config.kind) {
            case "greenhouse": promise = fetchGreenhouse(entry.config); break;
            case "lever":      promise = fetchLever(entry.config); break;
            case "ashby":      promise = fetchAshby(entry.config); break;
            case "workday":    promise = fetchWorkday(entry.config); break;
            case "linkedin":   continue; // already handled above
            case "careers-page": continue; // no directory entries today
            default: continue;
        }
        const r = await runSource(entry.name, entry.config.kind, () => promise!, args.query);
        printReport(r, args.query);
        reports.push(r);
    }

    // Summary
    const ok = reports.filter(r => r.ok).length;
    const erroredCount = reports.length - ok;
    const totalFetched = reports.reduce((s, r) => s + r.totalFetched, 0);
    const totalMatches = reports.reduce((s, r) => s + r.matches.length, 0);
    const sourcesWithMatch = reports.filter(r => r.matches.length > 0).length;

    console.log("");
    console.log("─".repeat(64));
    console.log(`Summary: ${ok}/${reports.length} sources responded · ${totalFetched} postings fetched · ${totalMatches} matched "${args.query}" across ${sourcesWithMatch} source(s).`);
    if (erroredCount > 0) console.log(`         ${erroredCount} source(s) errored (see ✗ rows above).`);
    if (totalMatches === 0 && ok > 0) {
        console.log(`         Try widening the query (e.g. just "avionics") or adding --location to refine LinkedIn.`);
    }
    process.exit(totalMatches > 0 ? 0 : 1);
}

main().catch(e => {
    console.error("Unhandled:", e);
    process.exit(2);
});
