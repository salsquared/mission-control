/**
 * A/B probe: can these callsites survive being moved from MODEL_LITE
 * (gemini-3.1-flash-lite) down to MODEL_LITE_CHEAP (gemini-2.5-flash-lite)?
 *
 * Background: only the employment-type classifier currently uses
 * MODEL_LITE_CHEAP. The cheap tier might be invisible-quality for other
 * picker/enum-shaped callsites too — but the only way to know is to run
 * the existing Promptfoo suite under each model and diff pass-rates.
 *
 * How it works:
 *   1. Run `promptfoo eval` once with no overrides → baseline (MODEL_LITE).
 *   2. Run it again with MC_EVAL_DOWNGRADE_CALLSITES + MC_EVAL_DOWNGRADE_MODEL
 *      set, which makes `chatJSON` in lib/ai/gemini.ts swap the model for the
 *      named callsites only (other callsites stay on their hardcoded models).
 *   3. Parse both results.json files, filter to the candidate callsites, and
 *      print a per-callsite × per-assertion pass-rate comparison.
 *
 * Cost: ~60 Gemini calls total (full suite × 2 passes), ~$0.02-0.05.
 * Wall time: 1-3 min (discovery-suggest dominates with its HTTP probes).
 *
 * Run:
 *   npx tsx scripts/tests/probes/eval-downgrade-probe.ts
 *
 * Override the candidate list (default = the three flagged in the
 * 2026-05-26 conversation):
 *   PROBE_CALLSITES=bullet-tags-from-posting,posting-parse \
 *     npx tsx scripts/tests/probes/eval-downgrade-probe.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_CANDIDATES = [
    "bullet-tags-from-posting",
    "bullet-tags-from-profile",
    "discovery-suggest",
];

const CANDIDATES = (process.env.PROBE_CALLSITES ?? DEFAULT_CANDIDATES.join(","))
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const DOWNGRADE_MODEL = process.env.PROBE_MODEL ?? "gemini-2.5-flash-lite";

const OUTPUT_DIR = resolve(process.cwd(), "eval/output");
const BASELINE_PATH = resolve(OUTPUT_DIR, "probe-baseline.json");
const DOWNGRADE_PATH = resolve(OUTPUT_DIR, "probe-downgrade.json");

function runPass(label: string, outputPath: string, extraEnv: Record<string, string>) {
    console.log(`\n=== ${label} ===`);
    console.log(`  output: ${outputPath}`);
    if (Object.keys(extraEnv).length > 0) {
        console.log(`  env:    ${Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
    try {
        execSync(
            `npx promptfoo eval -c eval/promptfooconfig.yaml --output ${JSON.stringify(outputPath)}`,
            {
                stdio: "inherit",
                env: { ...process.env, ...extraEnv },
            },
        );
    } catch (err) {
        // Promptfoo exits non-zero (exit 100) when ANY assertion fails — that's
        // expected here; failed assertions are the whole point of the diff. Only
        // re-throw if the results file wasn't written (real harness error).
        if (!existsSync(outputPath)) {
            throw err;
        }
    }
}

interface ResultRow {
    success?: boolean;
    vars?: { callsite?: string; [k: string]: unknown };
    description?: string;
    error?: string;
    gradingResult?: {
        componentResults?: Array<{ pass?: boolean; reason?: string; assertion?: { type?: string; value?: unknown } }>;
    };
}

interface ResultsJson {
    results?: { results?: ResultRow[] } | ResultRow[];
}

function loadResults(path: string): ResultRow[] {
    if (!existsSync(path)) {
        throw new Error(`results file missing: ${path}`);
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as ResultsJson;
    // Promptfoo nests { results: { results: [...] } } in current versions; older
    // versions had a flat { results: [...] }. Handle both.
    const inner = raw.results;
    if (Array.isArray(inner)) return inner;
    if (inner && Array.isArray((inner as { results?: ResultRow[] }).results)) {
        return (inner as { results: ResultRow[] }).results;
    }
    throw new Error(`unexpected results.json shape at ${path}`);
}

interface SummaryRow {
    callsite: string;
    cases: number;
    passed: number;
    failed: { description: string; reasons: string[] }[];
}

function summarize(rows: ResultRow[]): Map<string, SummaryRow> {
    const out = new Map<string, SummaryRow>();
    for (const r of rows) {
        const callsite = r.vars?.callsite;
        if (!callsite || !CANDIDATES.includes(callsite)) continue;
        let entry = out.get(callsite);
        if (!entry) {
            entry = { callsite, cases: 0, passed: 0, failed: [] };
            out.set(callsite, entry);
        }
        entry.cases++;
        if (r.success) {
            entry.passed++;
        } else {
            const reasons = (r.gradingResult?.componentResults ?? [])
                .filter(c => !c.pass)
                .map(c => c.reason ?? "(no reason)")
                .map(s => s.slice(0, 120));
            if (r.error) reasons.unshift(`provider error: ${r.error.slice(0, 120)}`);
            entry.failed.push({
                description: r.description ?? "(no description)",
                reasons: reasons.length > 0 ? reasons : ["(unknown failure)"],
            });
        }
    }
    return out;
}

function printDiff(baseline: Map<string, SummaryRow>, downgrade: Map<string, SummaryRow>) {
    console.log(`\n${"=".repeat(72)}`);
    console.log("DOWNGRADE PROBE — pass-rate comparison");
    console.log(`Baseline:  inherited model (MODEL_LITE for these callsites)`);
    console.log(`Downgrade: ${DOWNGRADE_MODEL}`);
    console.log("=".repeat(72));

    const callsiteWidth = Math.max(28, ...CANDIDATES.map(c => c.length + 2));
    console.log(
        `\n  ${"callsite".padEnd(callsiteWidth)}  baseline   downgrade   delta`,
    );
    console.log(`  ${"-".repeat(callsiteWidth)}  ---------  ---------   -----`);

    for (const callsite of CANDIDATES) {
        const b = baseline.get(callsite);
        const d = downgrade.get(callsite);
        if (!b || !d) {
            console.log(`  ${callsite.padEnd(callsiteWidth)}  (no fixtures found in suite)`);
            continue;
        }
        const baseStr = `${b.passed}/${b.cases}`;
        const downStr = `${d.passed}/${d.cases}`;
        const delta = d.passed - b.passed;
        const deltaStr = delta === 0 ? " 0" : delta > 0 ? `+${delta}` : `${delta}`;
        const verdict = delta < 0 ? "  ← regressed" : delta > 0 ? "  ← improved?" : "";
        console.log(
            `  ${callsite.padEnd(callsiteWidth)}  ${baseStr.padEnd(9)}  ${downStr.padEnd(9)}   ${deltaStr}${verdict}`,
        );
    }

    console.log("\nFailure detail (downgrade run only):");
    for (const callsite of CANDIDATES) {
        const d = downgrade.get(callsite);
        if (!d || d.failed.length === 0) continue;
        console.log(`\n  [${callsite}]`);
        for (const f of d.failed) {
            console.log(`    × ${f.description}`);
            for (const reason of f.reasons) {
                console.log(`        - ${reason}`);
            }
        }
    }

    console.log(`\n${"=".repeat(72)}`);
    console.log("Verdict guide:");
    console.log("  delta = 0   → safe to consider downgrading (no regressions on covered cases)");
    console.log("  delta < 0   → downgrade breaks at least one assertion — keep MODEL_LITE");
    console.log("  delta > 0   → suspicious; investigate (cheaper model shouldn't outperform)");
    console.log("=".repeat(72));
    console.log("\nNote: pass-rates only reflect what the existing Promptfoo suite covers.");
    console.log("Before flipping a callsite for real, eyeball Lunary samples on the");
    console.log("downgraded model to catch failure modes the suite doesn't assert against.\n");
}

async function main() {
    if (!existsSync(OUTPUT_DIR)) {
        mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log("Candidates:", CANDIDATES.join(", "));
    console.log("Downgrade model:", DOWNGRADE_MODEL);

    runPass("PASS 1/2 — baseline (no overrides)", BASELINE_PATH, {});
    runPass("PASS 2/2 — downgrade", DOWNGRADE_PATH, {
        MC_EVAL_DOWNGRADE_CALLSITES: CANDIDATES.join(","),
        MC_EVAL_DOWNGRADE_MODEL: DOWNGRADE_MODEL,
    });

    const baseline = summarize(loadResults(BASELINE_PATH));
    const downgrade = summarize(loadResults(DOWNGRADE_PATH));
    printDiff(baseline, downgrade);
}

main().catch(err => {
    console.error("[eval-downgrade-probe] failed:", err);
    process.exit(1);
});
