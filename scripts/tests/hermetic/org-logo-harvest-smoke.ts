/**
 * Hermetic smoke for the auto org-logo harvest pipeline
 * (lib/ai/org-logos.ts + lib/ai/lmarena-leaderboard.ts:extractOrgLogoSvgs).
 *
 *   npx tsx scripts/tests/hermetic/org-logo-harvest-smoke.ts
 *
 * No network; harvest writes go to a throwaway os.tmpdir() directory.
 * Covers the sanitizer's reject rules (scripts / handlers / external refs),
 * its color normalization (the CSS-class-themed icons the live site uses),
 * and harvest semantics (new org written, curated/existing skipped,
 * malicious skipped, best-effort no-throw).
 */
import { sanitizeOrgSvg, harvestOrgLogos } from "@/lib/ai/org-logos";
import { extractOrgLogoSvgs } from "@/lib/ai/lmarena-leaderboard";
import { orgSlug } from "@/lib/ai/org-slug";
import { ORG_LOGOS } from "@/components/cards/ai/LLMLeaderboardCard";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
function check(cond: boolean, msg: string, detail?: unknown) { cond ? pass(msg) : fail(msg, detail); }

// --- fixture helpers (mirror the live Model-cell markup) ---

function orgRow(org: string, model: string, svgInner: string, svgAttrs = ""): string {
    return `<tr><td>1</td><td>9</td><td><div>
        <div class="shrink-0"><svg viewBox="0 0 24 24"${svgAttrs} class="pointer-events-none size-4"><title>${org}</title>${svgInner}</svg></div>
        <div><div class="group"><span title="${model}">${model}</span></div><span class="text-xs">${org} · MIT</span></div>
    </div></td><td>1400±5</td><td>1,000</td></tr>`;
}

function page(rows: string): string {
    return `<html><body><table><thead><tr><th>Rank</th><th>RS</th><th>Model</th><th>Score</th><th>Votes</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

async function main() {
    // --- sanitizeOrgSvg: rejections ---
    check(sanitizeOrgSvg('<svg><script>alert(1)</script></svg>') === null, "rejects <script>");
    check(sanitizeOrgSvg('<svg onload="x()"><path d="M0 0"></path></svg>') === null, "rejects event-handler attrs");
    check(sanitizeOrgSvg('<svg><foreignObject><div>x</div></foreignObject></svg>') === null, "rejects foreignObject");
    check(sanitizeOrgSvg('<svg><a href="javascript:alert(1)"><path d="M0 0"></path></a></svg>') === null, "rejects javascript: URLs");
    check(sanitizeOrgSvg('<svg><path fill="url(http://evil.example/x)" d="M0 0"></path></svg>') === null, "rejects external url() refs");
    check(sanitizeOrgSvg('<svg><use href="https://evil.example/s.svg#i"></use></svg>') === null, "rejects external href");
    check(sanitizeOrgSvg('<svg><style>path{fill:red}</style><path d="M0 0"></path></svg>') === null, "rejects <style>");
    check(sanitizeOrgSvg('<svg><image href="#x"></image></svg>') === null, "rejects <image>");
    check(sanitizeOrgSvg(`<svg><path d="M${"0 ".repeat(60000)}"></path></svg>`) === null, "rejects oversized svg");
    // SMIL can assemble a javascript: URL indirectly (attributeName="href"
    // + a whitespace-split scheme the literal check misses) — the whole
    // element class is rejected, and split schemes are caught directly.
    check(sanitizeOrgSvg('<svg><a><set attributeName="href" to="java\nscript:alert(1)"></set><path d="M0 0"></path></a></svg>') === null, "rejects SMIL <set>");
    check(sanitizeOrgSvg('<svg><a><animate attributeName="href" values="x"></animate><path d="M0 0"></path></a></svg>') === null, "rejects SMIL <animate>");
    check(sanitizeOrgSvg('<svg><animateTransform attributeName="transform"></animateTransform><path d="M0 0"></path></svg>') === null, "rejects SMIL <animateTransform>");
    check(sanitizeOrgSvg('<svg><path d="M0 0" data-x="java\tscript:alert(1)"></path></svg>') === null, "rejects whitespace-split javascript: scheme anywhere");
    // <setting> etc. must not be caught by the <set\b rule
    check(sanitizeOrgSvg('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#123456" d="M0 0"></path></svg>') !== null, "clean svg still passes after SMIL rules");

    // --- sanitizeOrgSvg: transforms ---
    const grad = sanitizeOrgSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g1"><stop stop-color="#E2167E"></stop></linearGradient></defs><path fill="url(#g1)" d="M0 0"></path></svg>');
    check(grad !== null && grad.includes('url(#g1)'), "local gradient refs pass through intact", grad);

    const clip = sanitizeOrgSvg('<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><g clip-path="url(#c1)"><path fill="currentColor" d="M0 0"></path></g><defs><clipPath id="c1"><rect fill="white"></rect></clipPath></defs></svg>');
    check(clip !== null && clip.includes('url(#c1)') && clip.includes('fill="#FFFFFF"'), "local clipPath passes; currentColor → white");

    const themed = sanitizeOrgSvg('<svg viewBox="0 0 24 24" class="fill-black dark:fill-white size-4"><title>Org</title><path d="M0 0"></path></svg>');
    check(themed !== null && !themed.includes('class=') && !themed.includes('<title>'), "class + <title> stripped");
    check(themed !== null && /<svg[^>]*fill="#FFFFFF"/.test(themed), "CSS-class-themed icon gets explicit white fill");
    check(themed !== null && themed.includes('xmlns="http://www.w3.org/2000/svg"'), "xmlns added when missing");

    // The grok shape: root fill="none", color came from the (stripped) class.
    const noneRoot = sanitizeOrgSvg('<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="fill-black dark:fill-white"><path d="M0 0"></path></svg>');
    check(noneRoot !== null && !noneRoot.includes('fill="none"') && (noneRoot.match(/fill="/g) || []).length === 1,
        'paint-less root fill="none" is REPLACED by white (no duplicate attr → stays valid XML)', noneRoot);

    // The Baidu shape: root fill="none" but stroke-drawn children — keep none.
    const strokeArt = sanitizeOrgSvg('<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path stroke="#2096F2" stroke-width="2" d="M0 0"></path></svg>');
    check(strokeArt !== null && strokeArt.includes('fill="none"') && strokeArt.includes('stroke="#2096F2"'),
        "stroke-drawn icon keeps root fill=none and brand stroke colors");

    // --- extractOrgLogoSvgs ---
    const html = page(
        orgRow("Zetalab", "zeta-1", '<path fill="currentColor" d="M1 1"></path>') +
        orgRow("Zetalab", "zeta-2", '<path fill="currentColor" d="M2 2"></path>') +
        orgRow("Evil Co", "evil-1", '<script>alert(1)</script><path d="M0 0"></path>') +
        orgRow("Anthropic", "claude-x", '<path fill="currentColor" d="M3 3"></path>')
    );
    const svgs = extractOrgLogoSvgs(html);
    check(svgs.size === 3, `extractOrgLogoSvgs: one entry per org (got ${svgs.size})`, [...svgs.keys()]);
    check(svgs.get("Zetalab")?.includes('d="M1 1"') === true, "first svg per org wins");

    // --- harvestOrgLogos ---
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "logo-harvest-smoke-"));
    const curatedDir = path.join(tmpBase, "curated");
    const autoDir = path.join(tmpBase, "auto");
    fs.mkdirSync(curatedDir, { recursive: true });
    fs.writeFileSync(path.join(curatedDir, "anthropic.svg"), "<svg></svg>\n");

    const opts = { curatedDir, autoDir, minIntervalMs: 0 };
    const written = await harvestOrgLogos(html, { ...opts, category: "t1" });
    check(written.length === 1 && written[0] === "zetalab", `harvest writes ONLY the new clean org (got ${JSON.stringify(written)})`);
    const zetaFile = path.join(autoDir, "zetalab.svg");
    check(fs.existsSync(zetaFile), "zetalab.svg exists in autoDir");
    const zeta = fs.readFileSync(zetaFile, "utf8");
    check(zeta.includes('fill="#FFFFFF"') && !zeta.includes("currentColor"), "harvested file is sanitized");
    // cheerio must not lowercase SVG camelCase attrs — <img> parses strictly.
    check(zeta.includes('viewBox="0 0 24 24"'), "viewBox survives the cheerio round-trip", zeta);
    check(!fs.existsSync(path.join(autoDir, "evil-co.svg")), "malicious org NOT written");
    check(!fs.existsSync(path.join(autoDir, "anthropic.svg")), "curated org NOT re-harvested");

    const second = await harvestOrgLogos(html, { ...opts, category: "t2" });
    check(second.length === 0, "second harvest is a no-op (files exist)");

    const debounced = await harvestOrgLogos(html, { curatedDir, autoDir, category: "t3", minIntervalMs: 60_000 });
    const debounced2 = await harvestOrgLogos(page(orgRow("Newer Org", "n-1", '<path fill="currentColor" d="M9 9"></path>')), { curatedDir, autoDir, category: "t3", minIntervalMs: 60_000 });
    check(debounced.length === 0 && debounced2.length === 0 && !fs.existsSync(path.join(autoDir, "newer-org.svg")),
        "per-category debounce suppresses back-to-back harvests");

    const garbage = await harvestOrgLogos("not html at all", { ...opts, category: "t4" });
    check(Array.isArray(garbage) && garbage.length === 0, "garbage input: no throw, nothing written");

    // Disk bound: a page minting many fake orgs writes at most the cap.
    const floodRows = Array.from({ length: 40 }, (_, i) =>
        orgRow(`Flood Org ${i}`, `flood-${i}`, '<path fill="currentColor" d="M0 0"></path>')).join("");
    const floodDir = path.join(tmpBase, "flood-auto");
    const flooded = await harvestOrgLogos(page(floodRows), { curatedDir, autoDir: floodDir, minIntervalMs: 0, category: "t5" });
    check(flooded.length === 25 && fs.readdirSync(floodDir).length === 25,
        `per-harvest cap bounds writes to 25 (wrote ${flooded.length})`);

    check(orgSlug("Mistral AI") === "mistral-ai" && orgSlug("Z.ai") === "z-ai" && orgSlug("01.AI") === "01-ai",
        "orgSlug matches curated file naming");

    // Map ↔ file lockstep, BOTH directions: every map value resolves to a
    // real curated file, and every curated file is reachable via the map
    // (a file without a map entry would block harvest yet never render).
    const curatedRepo = path.join(process.cwd(), "public", "logos");
    const mapValues = new Set(Object.values(ORG_LOGOS));
    const missingFiles = [...mapValues].filter(v => !fs.existsSync(path.join(process.cwd(), "public", v)));
    check(missingFiles.length === 0, "every ORG_LOGOS entry points at an existing file", missingFiles);
    const unmappedFiles = fs.readdirSync(curatedRepo)
        .filter(f => f.endsWith(".svg"))
        .filter(f => !mapValues.has(`/logos/${f}`));
    check(unmappedFiles.length === 0, "every curated logo file is referenced by ORG_LOGOS", unmappedFiles);

    fs.rmSync(tmpBase, { recursive: true, force: true });

    console.log(`\n${passes} passed, ${fails} failed`);
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
