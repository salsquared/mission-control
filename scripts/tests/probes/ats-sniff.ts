/**
 * ATS sniffer — given a company URL or name, probe its careers surface and
 * report which (if any) of our supported ATSes it actually uses. Verifies the
 * extracted slug against the live job-board API so the report distinguishes
 * "marker on page" from "marker resolves to a working board".
 *
 *   npx tsx scripts/tests/probes/ats-sniff.ts https://relativityspace.com
 *   npx tsx scripts/tests/probes/ats-sniff.ts relativityspace.com
 *   npx tsx scripts/tests/probes/ats-sniff.ts "Firefly Aerospace"
 *   npx tsx scripts/tests/probes/ats-sniff.ts firefly stoke "Sierra Space"
 *
 * Why this exists: my first-pass "is X custom?" probe missed three companies
 * (Relativity, Stoke, Firefly) because I only hit /careers and grepped a
 * fixed list of ATS hostnames. This script covers the long tail by:
 *   - Probing /careers + ~10 sibling paths the major ATSes typically live on.
 *   - One-hop following same-origin links matching career/job/opening/etc.
 *   - Greppign a wider ATS marker set (16 ATSes).
 *   - Live-verifying the extracted slug against the canonical API.
 *
 * Diagnostic — exit-zero is not a contract. Lives under scripts/tests/probes/
 * intentionally; not wired into the hermetic pre-push suite (hits live external
 * APIs, results are observational, no assertions).
 */

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HOPS = 6;        // cap one-hop crawl breadth so a weirdly-linked page can't blow up
const POLITE_DELAY_MS = 80; // small breather between same-host requests

// Sibling paths that the major ATSes typically embed on, even when /careers
// itself is decorative marketing copy. Order matters: top of the list is
// where we expect the embed most often.
const SIBLING_PATHS = [
    "/careers",
    "/careers/",
    "/jobs",
    "/jobs/",
    "/careers/openings",
    "/careers/openings/",
    "/careers/current-openings",
    "/careers/current-openings/",
    "/careers/positions",
    "/careers/positions/",
    "/careers/open-roles",
    "/careers/open-positions",
    "/openings",
    "/positions",
    "/work-with-us",
    "/join-us",
    "/join",
    "/hiring",
];

interface ATSMarker {
    name: string;
    /** Capture group 1 = slug (or siteId/tenant). Use `g` flag — script handles
     *  resetting lastIndex via fresh RegExp construction per scan. */
    regex: RegExp;
    /** For Workday only — group 2 = career site. */
    secondCapture?: "careerSite";
    /** Optional live-verifier. Returns job count on success. Skip if the ATS
     *  doesn't have a trivial unauthenticated read endpoint (Workday, etc.). */
    verify?: (slug: string) => Promise<{ ok: boolean; jobs?: number; note?: string }>;
}

// Keep this list in sync with WATCHLIST_KINDS in lib/schemas/watchlists.ts.
// Extras at the bottom (clearcompany, icims, taleo, …) aren't wired yet but
// they're worth flagging — a hit means "we need a new fetcher to support it,"
// not "give up." See lib/custom-integrations.ts for the parking lot.
const MARKERS: ATSMarker[] = [
    {
        name: "greenhouse",
        // boards-api.greenhouse.io/v1/boards/<slug>                        (API path)
        // (boards.)?greenhouse.io/(embed/)?job_board(/js)?(.js)?\?for=<slug>  (embed URL variants)
        //
        // Most modern Greenhouse embeds use the JS-injecting form
        //   boards.greenhouse.io/embed/job_board/js?for=<slug>
        // The /js subpath is what we were missing on the first cut; without
        // it Relativity, Stoke, LeoLabs all looked custom.
        regex: /(?:boards-api\.greenhouse\.io\/v1\/boards\/|(?:boards\.)?greenhouse\.io\/(?:embed\/)?job_board(?:\/js|\.js)?\?for=)([a-zA-Z0-9_-]+)/g,
        verify: async (slug) => {
            const r = await jsonFetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
            if (!r || !r.ok) return { ok: false };
            const j = await r.json().catch(() => null) as { jobs?: unknown[] } | null;
            if (!j || !Array.isArray(j.jobs)) return { ok: false };
            return { ok: true, jobs: j.jobs.length };
        },
    },
    {
        name: "lever",
        // jobs.lever.co/<slug> | api.lever.co/v0/postings/<slug>
        regex: /(?:api\.lever\.co\/v0\/postings|jobs\.lever\.co)\/([a-zA-Z0-9_-]+)/g,
        verify: async (slug) => {
            const r = await jsonFetch(`https://api.lever.co/v0/postings/${slug}`);
            if (!r || !r.ok) return { ok: false };
            const j = await r.json().catch(() => null);
            if (!Array.isArray(j)) return { ok: false };
            return { ok: true, jobs: j.length };
        },
    },
    {
        name: "ashby",
        // jobs.ashbyhq.com/<slug> | api.ashbyhq.com/posting-api/job-board/<slug>
        regex: /(?:api\.ashbyhq\.com\/posting-api\/job-board|jobs\.ashbyhq\.com)\/([a-zA-Z0-9_-]+)/g,
        verify: async (slug) => {
            const r = await jsonFetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
            if (!r || !r.ok) return { ok: false };
            const j = await r.json().catch(() => null) as { jobs?: unknown[] } | null;
            if (!j || !Array.isArray(j.jobs)) return { ok: false };
            return { ok: true, jobs: j.jobs.length };
        },
    },
    {
        name: "workday",
        // <tenant>.wd<N>.myworkdayjobs.com/<careerSite> — careerSite is a
        // second capture; we report it but don't verify (would need POST).
        regex: /([a-zA-Z0-9-]+\.wd\d+\.myworkdayjobs\.com)\/([a-zA-Z0-9_-]+)/g,
        secondCapture: "careerSite",
    },
    {
        name: "smartrecruiters",
        // api.smartrecruiters.com/v1/companies/<slug> | jobs.smartrecruiters.com/<slug>
        // Case-sensitive slugs — preserve case in capture.
        regex: /(?:api\.smartrecruiters\.com\/v1\/companies|jobs\.smartrecruiters\.com|careers\.smartrecruiters\.com)\/([a-zA-Z0-9_-]+)/g,
        verify: async (slug) => {
            const r = await jsonFetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`);
            if (!r || !r.ok) return { ok: false };
            const j = await r.json().catch(() => null) as { totalFound?: number } | null;
            if (!j) return { ok: false };
            // SmartRecruiters returns totalFound=0 for unknown slugs as a soft-404.
            return { ok: (j.totalFound ?? 0) > 0, jobs: j.totalFound };
        },
    },
    {
        name: "workable",
        // apply.workable.com/<companySlug>  (candidate page)
        // apply.workable.com/api/v1/widget/accounts/<companySlug>  (JSON API)
        // The negative lookahead excludes apply.workable.com/j/<jobShortcode>,
        // which would otherwise be mis-extracted as slug "j".
        regex: /apply\.workable\.com\/(?!j\/)(?:api\/v1\/widget\/accounts\/)?([a-zA-Z0-9_-]+)/g,
        verify: async (slug) => {
            const r = await jsonFetch(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
            if (!r || !r.ok) return { ok: false };
            const j = await r.json().catch(() => null) as { jobs?: unknown[] } | null;
            if (!j || !Array.isArray(j.jobs)) return { ok: false };
            return { ok: j.jobs.length > 0, jobs: j.jobs.length };
        },
    },
    {
        name: "recruitee",
        // <slug>.recruitee.com — exclude generic www./api. subdomains.
        regex: /(?:^|[\W])([a-zA-Z0-9_-]+)\.recruitee\.com/g,
        verify: async (slug) => {
            if (slug === "www" || slug === "api") return { ok: false };
            const r = await jsonFetch(`https://${slug}.recruitee.com/api/offers/`);
            if (!r || !r.ok) return { ok: false };
            const j = await r.json().catch(() => null) as { offers?: unknown[] } | null;
            if (!j || !Array.isArray(j.offers)) return { ok: false };
            return { ok: true, jobs: j.offers.length };
        },
    },
    {
        name: "personio",
        // <slug>.jobs.personio.com
        regex: /(?:^|[\W])([a-zA-Z0-9_-]+)\.jobs\.personio\.com/g,
        verify: async (slug) => {
            const r = await jsonFetch(`https://${slug}.jobs.personio.com/xml`);
            if (!r || !r.ok || r.status >= 300) return { ok: false };
            const text = await r.text();
            const m = text.match(/<position>/g);
            return { ok: text.includes("workzag-jobs"), jobs: m?.length ?? 0 };
        },
    },
    // ─── Not wired yet — flagging means "needs a new fetcher" ────────────────
    {
        name: "clearcompany (NOT WIRED)",
        // careers-content.clearcompany.com/js/v1/career-site.js?siteId=<uuid>
        // careers-api.clearcompany.com/v1/<uuid>
        regex: /(?:careers-(?:api|content)\.clearcompany\.com[^"'\s]*?(?:siteId=|\/v1\/))([a-f0-9-]{20,})/g,
        verify: async (siteId) => {
            const r = await jsonFetch(`https://careers-api.clearcompany.com/v1/${siteId}`);
            if (!r || !r.ok) return { ok: false };
            const j = await r.json().catch(() => null) as { results?: unknown[] } | null;
            if (!j || !Array.isArray(j.results)) return { ok: false };
            return { ok: true, jobs: j.results.length, note: "ClearCompany ATS — fetcher not wired yet" };
        },
    },
    {
        name: "icims (NOT WIRED)",
        // careers-<co>.icims.com or jobs-<co>.icims.com
        regex: /(?:careers|jobs)-([a-zA-Z0-9_-]+)\.icims\.com/g,
    },
    {
        name: "taleo (NOT WIRED)",
        // <tenant>.taleo.net/careersection
        regex: /([a-zA-Z0-9_-]+)\.taleo\.net/g,
    },
    {
        name: "successfactors (NOT WIRED)",
        regex: /(?:[a-zA-Z0-9_-]+\.successfactors\.com|sapsf\.com\/sf\/jobreq|career\.sapsf)/g,
    },
    {
        name: "jobvite (NOT WIRED)",
        regex: /jobs\.jobvite\.com\/([a-zA-Z0-9_-]+)/g,
    },
    {
        name: "breezy (NOT WIRED)",
        regex: /([a-zA-Z0-9_-]+)\.breezy\.hr/g,
    },
    {
        name: "teamtailor (NOT WIRED)",
        regex: /([a-zA-Z0-9_-]+)\.teamtailor\.com/g,
    },
    {
        name: "bamboohr (NOT WIRED)",
        regex: /([a-zA-Z0-9_-]+)\.bamboohr\.com\/(?:jobs|careers)/g,
    },
    {
        name: "jazzhr (NOT WIRED)",
        regex: /([a-zA-Z0-9_-]+)\.applytojob\.com|jobs\.jazzhr\.com/g,
    },
    {
        name: "paycom (NOT WIRED)",
        regex: /paycomonline\.net\/v4\/ats|paycom\.com\/careers\/[a-zA-Z0-9_-]+/g,
    },
    {
        name: "paylocity (NOT WIRED)",
        regex: /recruiting\.paylocity\.com\/Recruiting\/Jobs\/Details/g,
    },
];

async function timedFetch(url: string, init?: RequestInit): Promise<Response | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                ...(init?.headers ?? {}),
            },
            redirect: "follow",
        });
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

/** JSON-only variant for verifier calls. Lever (and a few others) return an
 *  HTML challenge page when the Accept header doesn't preference JSON, which
 *  silently breaks every verifier that calls .json(). */
async function jsonFetch(url: string): Promise<Response | null> {
    return timedFetch(url, { headers: { "Accept": "application/json" } });
}

interface Finding {
    ats: string;
    slug?: string;
    careerSite?: string;
    source: string;
    verify?: { ok: boolean; jobs?: number; note?: string };
}

async function sniff(html: string, source: string): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const m of MARKERS) {
        const re = new RegExp(m.regex.source, m.regex.flags.includes("g") ? m.regex.flags : m.regex.flags + "g");
        const seen = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = re.exec(html)) !== null) {
            const slug = match[1];
            const key = slug ?? "(no-slug)";
            if (seen.has(key)) continue;
            seen.add(key);
            const f: Finding = { ats: m.name, slug, source };
            if (m.secondCapture === "careerSite") f.careerSite = match[2];
            if (slug && m.verify) {
                f.verify = await m.verify(slug);
            }
            out.push(f);
        }
    }
    return out;
}

function deriveRoot(input: string): string {
    if (/^https?:\/\//i.test(input)) return input.replace(/\/+$/, "");
    if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(input)) return `https://${input.replace(/\/+$/, "")}`;
    // Heuristic: "Firefly Aerospace" → fireflyaerospace.com. The careers-page
    // probe handles redirects, so if the company uses firefly.com or
    // fireflyspace.com instead, we'll usually still land somewhere useful.
    const slug = input.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `https://${slug}.com`;
}

function sameOriginCareersLinks(html: string, origin: string): string[] {
    const out = new Set<string>();
    // Coarse extraction — good enough to catch the "real openings are on a
    // sibling path I didn't list" case.
    const re = /href=["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        const href = match[1];
        if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) continue;
        let abs: URL;
        try { abs = new URL(href, origin); } catch { continue; }
        if (abs.origin !== origin) continue;
        if (!/career|job|opening|position|hire|join/i.test(abs.pathname)) continue;
        // Trim fragments/query so duplicates collapse.
        abs.hash = ""; abs.search = "";
        out.add(abs.toString().replace(/\/+$/, ""));
    }
    return Array.from(out);
}

function fmtFinding(f: Finding): string {
    const wired = !f.ats.includes("NOT WIRED");
    const lead = wired ? "✓" : "?";
    const slugStr = f.slug ? ` slug=${f.slug}` : "";
    const careerSiteStr = f.careerSite ? ` careerSite=${f.careerSite}` : "";
    let verifyStr = "";
    if (f.verify === undefined && f.slug && wired) {
        verifyStr = " (skipped verify)";
    } else if (f.verify?.ok) {
        verifyStr = ` → ${f.verify.jobs ?? "?"} jobs LIVE`;
    } else if (f.verify && !f.verify.ok) {
        verifyStr = " → live API rejected slug";
    }
    const note = f.verify?.note ? `  [${f.verify.note}]` : "";
    return `    ${lead} ${f.ats}${slugStr}${careerSiteStr}${verifyStr}${note}`;
}

async function probe(rawInput: string) {
    const root = deriveRoot(rawInput);
    let rootUrl: URL;
    try { rootUrl = new URL(root); } catch {
        console.log(`\n=== ${rawInput}: invalid URL after derivation (${root})`);
        return;
    }
    const origin = rootUrl.origin;

    console.log(`\n=== Probing: ${rawInput} (${origin}) ===`);

    const visited = new Set<string>();
    const queue: string[] = [];

    // Seed with the supplied URL + the canonical sibling probe list.
    queue.push(root);
    for (const p of SIBLING_PATHS) queue.push(`${origin}${p}`);

    const allFindings: Finding[] = [];
    let hopsRemaining = MAX_HOPS;

    while (queue.length > 0) {
        const url = queue.shift()!;
        const norm = url.replace(/\/+$/, "");
        if (visited.has(norm)) continue;
        visited.add(norm);

        const res = await timedFetch(url);
        if (!res) {
            console.log(`  --- ${url}  (fetch failed)`);
            continue;
        }
        const status = res.status;
        const html = await res.text().catch(() => "");
        const findings = await sniff(html, url);
        if (findings.length === 0) {
            console.log(`  ${status} ${url}  (no markers, ${html.length}B)`);
        } else {
            console.log(`  ${status} ${url}`);
            for (const f of findings) console.log(fmtFinding(f));
        }
        allFindings.push(...findings);

        // One-hop follow: from this page's HTML, queue any same-origin careers-y
        // links we haven't already enqueued. Capped at MAX_HOPS total to keep
        // the probe bounded.
        if (status >= 200 && status < 400 && hopsRemaining > 0) {
            for (const link of sameOriginCareersLinks(html, origin)) {
                const linkNorm = link.replace(/\/+$/, "");
                if (!visited.has(linkNorm) && !queue.includes(link) && hopsRemaining > 0) {
                    queue.push(link);
                    hopsRemaining--;
                }
            }
        }

        await new Promise(r => setTimeout(r, POLITE_DELAY_MS));
    }

    // ─── Summary ─────────────────────────────────────────────────────────────
    // Dedup by (ats, slug) — finding the same marker on multiple probed paths
    // (e.g. /careers and /jobs both link to the same Greenhouse embed) shouldn't
    // show twice. Earlier finding wins so verify state is preserved.
    const seenPairs = new Set<string>();
    const uniqueFindings: Finding[] = [];
    for (const f of allFindings) {
        const key = `${f.ats}::${f.slug ?? ""}::${f.careerSite ?? ""}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        uniqueFindings.push(f);
    }

    const wired = (f: Finding) => !f.ats.includes("NOT WIRED");
    const verified = uniqueFindings.filter(f => f.verify?.ok);
    // "Found but un-verifiable" = wired ATS we recognize, but no programmatic
    // verifier (Workday lacks a trivial GET endpoint; second-capture markers
    // like the iCIMS fallback can't validate slugs cheaply). These are wins,
    // not failures — the slug is in the page, just trust-but-verify manually.
    const wiredNoVerifier = uniqueFindings.filter(f => wired(f) && f.verify === undefined && !verified.includes(f));
    const wiredVerifyFailed = uniqueFindings.filter(f => wired(f) && f.verify && !f.verify.ok);
    const unwired = uniqueFindings.filter(f => !wired(f));

    console.log(`\n  --- summary for ${rawInput} ---`);
    if (verified.length > 0) {
        console.log(`  VERIFIED — add to lib/company-directory.ts:`);
        for (const f of verified) console.log(fmtFinding(f));
    }
    if (wiredNoVerifier.length > 0) {
        console.log(`  Found in page (no programmatic verifier — open the URL to confirm slug works):`);
        for (const f of wiredNoVerifier) console.log(fmtFinding(f));
    }
    if (wiredVerifyFailed.length > 0) {
        console.log(`  Markers found but live API rejected the slug — likely stale or extracted wrong:`);
        for (const f of wiredVerifyFailed) console.log(fmtFinding(f));
    }
    if (unwired.length > 0 && verified.length === 0) {
        console.log(`  Uses an ATS we don't support yet — add to lib/custom-integrations.ts or build a new fetcher:`);
        for (const f of unwired) console.log(fmtFinding(f));
    }
    if (uniqueFindings.length === 0) {
        console.log(`  No known ATS markers anywhere. Cloudflare-blocked or genuinely custom — candidate for headless.`);
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Usage: npx tsx scripts/tests/probes/ats-sniff.ts <name-or-url> [more...]");
        process.exit(1);
    }
    for (const input of args) {
        await probe(input);
    }
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
