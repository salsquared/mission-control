/**
 * Validates candidate ATS slugs before we add them to lib/company-directory.ts.
 * Hits the real public endpoints (Greenhouse / Lever / Ashby) and reports
 * pass/fail with the live job count. Skip on Workday — those need POST + tenant
 * host validation, much more brittle to auto-verify; add Workday entries by
 * hand only when we know the tenant.
 *
 *   npx tsx scripts/tests/verify-directory-candidates.ts
 *
 * Output is grouped + sorted so the human running this can copy verified rows
 * straight into the directory.
 */
type Kind = "greenhouse" | "lever" | "ashby";

interface Candidate {
    name: string;
    blurb: string;
    tags: string[];
    kind: Kind;
    slug: string;
}

// Educated guesses + canonical names from each company's public careers page.
// Anything that 404s here gets dropped from the directory PR.
const CANDIDATES: Candidate[] = [
    // ─── AI / ML ─────────────────────────────────────────────────────────────
    { name: "OpenAI",         blurb: "Frontier AI lab (ChatGPT).",      tags: ["ai"], kind: "ashby",      slug: "openai" },
    { name: "Cohere",         blurb: "Enterprise LLM provider.",        tags: ["ai"], kind: "lever",      slug: "cohere" },
    { name: "Hugging Face",   blurb: "Open-source ML hub.",             tags: ["ai"], kind: "greenhouse", slug: "huggingface" },
    { name: "Perplexity",     blurb: "AI answer engine.",               tags: ["ai"], kind: "ashby",      slug: "perplexity" },
    { name: "Scale AI",       blurb: "ML data labeling + RLHF.",        tags: ["ai"], kind: "greenhouse", slug: "scaleai" },
    { name: "Character.AI",   blurb: "Personalized chat AI.",           tags: ["ai"], kind: "greenhouse", slug: "characterai" },
    { name: "Replicate",      blurb: "Hosted ML model APIs.",           tags: ["ai"], kind: "ashby",      slug: "replicate" },
    { name: "LangChain",      blurb: "LLM app framework + LangSmith.",  tags: ["ai"], kind: "ashby",      slug: "langchain" },
    { name: "Notion",         blurb: "Docs + database + AI.",           tags: ["ai", "tech"], kind: "ashby", slug: "notion" },
    { name: "PostHog",        blurb: "Open-source product analytics.",  tags: ["ai", "tech"], kind: "ashby", slug: "posthog" },
    { name: "Mistral AI",     blurb: "Open-weights LLMs (Paris).",      tags: ["ai"], kind: "ashby",      slug: "mistralai" },
    { name: "Together AI",    blurb: "Inference + fine-tuning cloud.",  tags: ["ai"], kind: "ashby",      slug: "togetherai" },
    { name: "Runway",         blurb: "Generative video models.",        tags: ["ai"], kind: "greenhouse", slug: "runwayml" },

    // ─── Space / Aero ────────────────────────────────────────────────────────
    { name: "Astranis",       blurb: "Small geostationary comms sats.", tags: ["space"], kind: "greenhouse", slug: "astranis" },
    { name: "Relativity Space", blurb: "3D-printed rockets (Terran R).", tags: ["space"], kind: "greenhouse", slug: "relativityspace" },
    { name: "Firefly Aerospace", blurb: "Alpha launcher + lunar lander.", tags: ["space"], kind: "greenhouse", slug: "fireflyaerospace" },
    { name: "Planet",         blurb: "Earth-imaging satellites.",       tags: ["space"], kind: "greenhouse", slug: "planetlabs" },
    { name: "Axiom Space",    blurb: "Commercial space station.",       tags: ["space"], kind: "greenhouse", slug: "axiomspace" },
    { name: "Vast",           blurb: "Haven-1 commercial station.",     tags: ["space"], kind: "greenhouse", slug: "vastspace" },
    { name: "Stoke Space",    blurb: "Fully reusable launcher.",        tags: ["space"], kind: "greenhouse", slug: "stokespace" },
    { name: "ABL Space Systems", blurb: "RS1 small launcher.",          tags: ["space"], kind: "greenhouse", slug: "ablspacesystems" },

    // ─── Tech / SaaS ─────────────────────────────────────────────────────────
    { name: "Datadog",        blurb: "Observability + monitoring.",     tags: ["tech"], kind: "greenhouse", slug: "datadog" },
    { name: "Cloudflare",     blurb: "Edge network + Workers.",         tags: ["tech"], kind: "greenhouse", slug: "cloudflare" },
    { name: "GitLab",         blurb: "DevOps platform.",                tags: ["tech"], kind: "greenhouse", slug: "gitlab" },
    { name: "HashiCorp",      blurb: "Terraform / Vault / Consul.",     tags: ["tech"], kind: "greenhouse", slug: "hashicorp" },
    { name: "Dropbox",        blurb: "File sync + collaboration.",      tags: ["tech"], kind: "greenhouse", slug: "dropbox" },
    { name: "Discord",        blurb: "Real-time chat platform.",        tags: ["tech"], kind: "greenhouse", slug: "discord" },
    { name: "Reddit",         blurb: "Social link aggregator.",         tags: ["tech"], kind: "greenhouse", slug: "reddit" },
    { name: "Figma",          blurb: "Collaborative design tool.",      tags: ["tech"], kind: "greenhouse", slug: "figma" },
    { name: "Canva",          blurb: "Visual design platform.",         tags: ["tech"], kind: "greenhouse", slug: "canva" },
    { name: "Asana",          blurb: "Work management.",                tags: ["tech"], kind: "greenhouse", slug: "asana" },
    { name: "Webflow",        blurb: "Visual web builder.",             tags: ["tech"], kind: "greenhouse", slug: "webflow" },
    { name: "Linear",         blurb: "Issue tracking for engineers.",   tags: ["tech"], kind: "ashby",      slug: "linear" },
    { name: "Mercury",        blurb: "Banking for startups.",           tags: ["tech", "finance"], kind: "ashby", slug: "mercury" },
    { name: "Spotify",        blurb: "Music streaming.",                tags: ["tech"], kind: "lever",      slug: "spotify" },
    { name: "Netflix",        blurb: "Streaming video.",                tags: ["tech"], kind: "lever",      slug: "netflix" },
    { name: "Reddit",         blurb: "Dup — drop if first wins.",       tags: ["tech"], kind: "lever",      slug: "reddit" }, // dup, will collide

    // ─── Finance / Crypto ────────────────────────────────────────────────────
    { name: "Coinbase",       blurb: "Crypto exchange.",                tags: ["finance"], kind: "greenhouse", slug: "coinbase" },
    { name: "Robinhood",      blurb: "Retail brokerage.",               tags: ["finance"], kind: "greenhouse", slug: "robinhood" },
    { name: "Brex",           blurb: "Corporate cards + spend mgmt.",   tags: ["finance"], kind: "greenhouse", slug: "brex" },
    { name: "Plaid",          blurb: "Financial data APIs.",            tags: ["finance"], kind: "greenhouse", slug: "plaid" },
    { name: "Ramp",           blurb: "Corporate cards + automation.",   tags: ["finance"], kind: "ashby",      slug: "ramp" },
    { name: "Citadel",        blurb: "Hedge fund + market making.",     tags: ["finance"], kind: "greenhouse", slug: "citadel" },
    { name: "Two Sigma",      blurb: "Quant hedge fund.",               tags: ["finance"], kind: "lever",      slug: "twosigma" },
    { name: "Hudson River Trading", blurb: "Quant prop trading.",       tags: ["finance"], kind: "greenhouse", slug: "hudsonrivertrading" },

    // ─── Biotech ─────────────────────────────────────────────────────────────
    { name: "Recursion",      blurb: "AI-driven drug discovery.",       tags: ["biotech"], kind: "greenhouse", slug: "recursionpharmaceuticals" },
    { name: "Insitro",        blurb: "ML-driven drug discovery.",       tags: ["biotech"], kind: "greenhouse", slug: "insitro" },
    { name: "Tempus AI",      blurb: "Oncology data + AI.",             tags: ["biotech"], kind: "greenhouse", slug: "tempus" },
    { name: "23andMe",        blurb: "Consumer genomics.",              tags: ["biotech"], kind: "greenhouse", slug: "23andme" },
];

interface Result {
    cand: Candidate;
    ok: boolean;
    status?: number;
    jobs?: number;
    error?: string;
}

async function check(c: Candidate): Promise<Result> {
    const url =
        c.kind === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs`
      : c.kind === "lever"      ? `https://api.lever.co/v0/postings/${c.slug}?mode=json`
      :                           `https://api.ashbyhq.com/posting-api/job-board/${c.slug}`;
    try {
        const t0 = Date.now();
        const res = await fetch(url, {
            headers: { "User-Agent": "mission-control/0.1 directory-verify" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { cand: c, ok: false, status: res.status, error: `HTTP ${res.status}` };
        const body = await res.json() as { jobs?: unknown[]; data?: unknown[]; [k: string]: unknown };
        // Each ATS shape:
        //   Greenhouse: { jobs: [...] }
        //   Lever: an array of postings directly
        //   Ashby: { jobs: [...] } usually, sometimes { data: [...] }
        let jobs = 0;
        if (Array.isArray(body)) jobs = body.length;
        else if (Array.isArray(body.jobs)) jobs = body.jobs.length;
        else if (Array.isArray(body.data)) jobs = body.data.length;
        return { cand: c, ok: true, status: res.status, jobs, error: jobs === 0 ? `(empty board after ${Date.now() - t0}ms)` : undefined };
    } catch (e) {
        return { cand: c, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

async function main() {
    console.log(`Verifying ${CANDIDATES.length} candidate slugs against live ATS APIs...\n`);
    const results = await Promise.all(CANDIDATES.map(check));

    // Dedup on name (we kept a sentinel "Reddit" lever entry to test dup-detection)
    const byName = new Map<string, Result>();
    for (const r of results) {
        const cur = byName.get(r.cand.name);
        if (!cur || (!cur.ok && r.ok)) byName.set(r.cand.name, r);
    }

    const passing: Result[] = [];
    const failing: Result[] = [];
    for (const r of byName.values()) (r.ok ? passing : failing).push(r);

    console.log(`PASS: ${passing.length}`);
    for (const r of passing.sort((a, b) => a.cand.name.localeCompare(b.cand.name))) {
        console.log(`  ✓  [${r.cand.kind.padEnd(10)}] ${r.cand.name.padEnd(28)} slug=${r.cand.slug.padEnd(22)} jobs=${r.jobs}${r.error ? `  ${r.error}` : ""}`);
    }
    console.log(`\nFAIL: ${failing.length}`);
    for (const r of failing.sort((a, b) => a.cand.name.localeCompare(b.cand.name))) {
        console.log(`  ✗  [${r.cand.kind.padEnd(10)}] ${r.cand.name.padEnd(28)} slug=${r.cand.slug.padEnd(22)} ${r.error}`);
    }

    console.log(`\nReady-to-paste directory entries (passing only):\n`);
    for (const r of passing.sort((a, b) => a.cand.name.localeCompare(b.cand.name))) {
        const tagsLit = r.cand.tags.map(t => `"${t}"`).join(", ");
        console.log(`    {`);
        console.log(`        name: ${JSON.stringify(r.cand.name)},`);
        console.log(`        blurb: ${JSON.stringify(r.cand.blurb)},`);
        console.log(`        tags: [${tagsLit}],`);
        console.log(`        config: { kind: "${r.cand.kind}", boardSlug: "${r.cand.slug}", companyName: ${JSON.stringify(r.cand.name)} },`);
        console.log(`    },`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
