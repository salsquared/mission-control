/**
 * Hermetic smoke for the lmarena.ai leaderboard HTML parser.
 *
 *   npx tsx scripts/tests/hermetic/llm-leaderboard-parse-smoke.ts
 *
 * Fixture HTML replicates the two Model-cell variants observed on the live
 * site after the 2026-07 redesign (which broke the old a[title]-only parse):
 *   - linkless rows: name in <span title>, org logo <svg><title>
 *   - linked rows (image categories): name in <a title>, svg without <title>
 * plus the new "Org · License" subtitle span, the "1509±9" score format,
 * comma-grouped votes, and the extra Price/Context columns.
 */
import { parseLmarenaLeaderboard } from "@/lib/ai/lmarena-leaderboard";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
function check(cond: boolean, msg: string, detail?: unknown) { cond ? pass(msg) : fail(msg, detail); }

function modelCellSpanTitle(org: string | null, name: string, subtitle: string | null): string {
    return `<td><div class="flex">
        <div class="shrink-0"><svg viewBox="0 0 24 24">${org ? `<title>${org}</title>` : ""}<path d="M0 0"></path></svg></div>
        <div class="flex flex-col">
            <div class="group"><span class="font-mono text-sm" title="${name}">${name}</span></div>
            ${subtitle ? `<span class="text-xs">${subtitle}</span>` : ""}
        </div>
    </div></td>`;
}

function modelCellLinked(name: string, subtitle: string): string {
    return `<td><div class="flex">
        <div class="shrink-0"><svg viewBox="0 0 16 16"><path d="M0 0"></path></svg></div>
        <div class="flex flex-col">
            <div class="group"><a href="https://example.com" title="${name}"><span class="truncate">${name}</span><svg viewBox="0 0 24 24"><path d="M6 19"></path></svg></a></div>
            <span class="text-xs">${subtitle}</span>
        </div>
    </div></td>`;
}

function row(rank: string, modelCell: string, score: string, votes: string, extraCells = ""): string {
    return `<tr><td>${rank}</td><td>16</td>${modelCell}<td>${score}</td><td>${votes}</td>${extraCells}</tr>`;
}

const FIXTURE = `<html><body><table>
<thead><tr><th>Rank</th><th>Rank Spread</th><th>Model</th><th>Score</th><th>Votes</th><th>Price $/M</th><th>Context</th></tr></thead>
<tbody>
${row("3", modelCellSpanTitle("Anthropic", "claude-fable-5", "Anthropic · Proprietary"), "1490±4", "58,968", "<td>$10 / $50</td><td>1M</td>")}
${row("2", modelCellLinked("gpt-image-2 (medium)", "OpenAI · Proprietary"), "1385±5", "60,382")}
${row("1", modelCellSpanTitle("Anthropic", "claude-fable-5", "Anthropic · Proprietary"), "1509±9", "4,299", "<td>$10 / $50</td><td>1M</td>")}
${row("4", modelCellSpanTitle(null, "mistral-small-x", null), "1301±7", "12,345")}
${row("5", modelCellSpanTitle(null, "llama-5-behemoth", "Meta · Llama 3.1 · Community"), "1288±6", "9,001")}
${row("6", `<td><div class="flex">
    <div class="shrink-0"><svg viewBox="0 0 24 24"><path d="M0 0"></path></svg></div>
    <div class="flex flex-col">
        <div class="group"><span class="font-mono text-sm">fallback-model</span></div>
        <span class="text-xs">SomeOrg · MIT</span>
    </div>
</div></td>`, "1200±3", "777")}
<tr><td>—</td><td></td><td><div><span class="text-xs">Org · License</span></div></td><td>n/a</td><td>n/a</td></tr>
</tbody>
</table></body></html>`;

async function main() {
    const models = parseLmarenaLeaderboard(FIXTURE, "fixture");

    // Row with no model name + non-numeric score is skipped; the duplicate
    // claude-fable-5 collapses to one entry → 5 models.
    check(models.length === 5, `5 models parsed (got ${models.length})`, models.map(m => m.id));

    const fable = models.find(m => m.id === "claude-fable-5");
    check(!!fable, "span[title] row parsed (claude-fable-5)");
    if (fable) {
        check(fable.orgName === "Anthropic", `org from svg <title> (got "${fable.orgName}")`);
        check(fable.license === "Proprietary", `license from subtitle (got "${fable.license}")`);
        check(fable.eloScore === 1509, `±spread stripped from score (got ${fable.eloScore})`);
        check(fable.votes === 4299, `comma-grouped votes parsed (got ${fable.votes})`);
        check(fable.rank === 1, `rank parsed (got ${fable.rank})`);
    }

    // The lower-Elo duplicate appears FIRST in the fixture, so a keep-first
    // regression (instead of keep-max-Elo) fails this.
    check(models[0]?.id === "claude-fable-5" && models[0]?.eloScore === 1509,
        "dedupe kept the higher-Elo duplicate and sort is Elo-desc", models[0]);

    const img = models.find(m => m.id === "gpt-image-2 (medium)");
    check(!!img, "a[title] (linked/image-category) row parsed");
    if (img) {
        check(img.orgName === "OpenAI", `org falls back to subtitle when svg has no <title> (got "${img.orgName}")`);
        check(img.license === "Proprietary", `license parsed on linked row (got "${img.license}")`);
        check(img.eloScore === 1385 && img.votes === 60382, "score/votes on 5-cell (no price/context) row");
    }

    const mistral = models.find(m => m.id === "mistral-small-x");
    check(!!mistral, "row without subtitle/svg-title still parsed");
    if (mistral) {
        check(mistral.orgName === "Mistral AI", `org falls back to name mapping (got "${mistral.orgName}")`);
        check(mistral.license === undefined, `license undefined when no subtitle (got "${mistral.license}")`);
    }

    const fallback = models.find(m => m.id === "fallback-model");
    check(!!fallback, "titleless name span parsed via the leaf-span fallback");
    if (fallback) {
        check(fallback.orgName === "SomeOrg" && fallback.license === "MIT",
            `fallback row org/license (got "${fallback.orgName}"/"${fallback.license}")`);
    }

    const llama = models.find(m => m.id === "llama-5-behemoth");
    check(!!llama, "multi-separator subtitle row parsed");
    if (llama) {
        check(llama.orgName === "Meta", `org is text before the FIRST separator (got "${llama.orgName}")`);
        check(llama.license === "Llama 3.1 · Community", `license keeps later separators (got "${llama.license}")`);
    }

    console.log(`\n${passes} passed, ${fails} failed`);
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
