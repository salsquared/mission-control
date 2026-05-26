/**
 * Shared sample vars for the 9 LLM callsites. Tiny but realistic — just
 * enough to render the prompt and see what the model would see. Used by:
 *
 *   - scripts/dryrun-prompt.ts          interactive single-slug print tool
 *   - scripts/tests/hermetic/prompt-render-smoke.ts   automated invariant smoke
 *
 * If you change the template (in docs/llm-prompts/<slug>.md) to need a new
 * variable, add it here too — the hermetic smoke fails on undeclared vars.
 */
import type { PromptVars } from "@/lib/ai/prompts";

export const PROMPT_SLUGS = [
    "bullet-assist-fill",
    "bullet-assist-rewrite",
    "bullet-auto-tag",
    "bullet-tag-suggest",
    "scratchpad-synth",
    "discovery-suggest",
    "email-parser",
    "employment-type-classifier",
    "posting-parse",
    "profile-import",
    "profile-synthesize",
    "resume-rewrite",
] as const;

export type PromptSlug = (typeof PROMPT_SLUGS)[number];

export const SAMPLE_VARS: Record<PromptSlug, PromptVars> = {
    "posting-parse": {
        postingText: "Senior Backend Engineer at Acme Corp (Remote, US).\nWe're looking for an engineer with 5+ years of Go and distributed systems experience. You'll own our payments pipeline (~50k transactions/day) and mentor junior team members. Must have: production Go, gRPC, PostgreSQL, observability practices.",
    },
    "profile-import": {
        filename: "resume-2026.pdf",
        resumeText: "Jane Smith\njane@example.com\n\nEXPERIENCE\nAcme Corp — Software Engineer (2022–Present)\n- Built distributed payments service handling 50k tx/day\n- Reduced p99 latency 40% via async batch dispatch\n\nEDUCATION\nMIT — BS Computer Science (2018–2022)",
    },
    "profile-synthesize": {
        existingJson: JSON.stringify({ workRoles: [{ company: "Acme", title: "Engineer" }] }, null, 2),
        draftCount: "1",
        draftsJson: JSON.stringify([{ filename: "r.pdf", tree: { workRoles: [{ company: "Acme", title: "Senior Engineer", bullets: ["Built thing"] }] } }], null, 2),
    },
    "bullet-auto-tag": {
        keywords: "- Python\n- Kubernetes\n- distributed systems",
        bullets: "- id=b001 | tags=[] | removedTags=[]\n  text: \"Built a Python service handling 50k req/day on k8s\"\n- id=b002 | tags=[Go] | removedTags=[]\n  text: \"Cut latency in our Go API by 40%\"",
    },
    "bullet-tag-suggest": {
        spine: "Software Engineer at Acme Corp",
        bulletText: "Built a Python API serving 50k req/day",
        tagState: "  - \"Python\" [pinned — MUST remain in output verbatim]\n  - \"API\" [user — may keep / replace / remove]",
        removedTags: "  (none)",
        vocabulary: "\"TypeScript\", \"Go\", \"Postgres\", \"REST\", \"distributed-systems\"",
    },
    "scratchpad-synth": {
        spine: "Software Engineer at Acme Corp",
        scratchpad: "Migrated our data pipeline from MySQL to PostgreSQL — handled the schema reshape and the cutover. Rewrote the query layer in Go.",
        postingKeywords: "  - PostgreSQL\n  - Go\n  - data pipeline\n  - schema migration",
        uncoveredKeywords: "  - PostgreSQL\n  - Go",
        maxBullets: "3",
    },
    "discovery-suggest": {
        topic: "space",
        excludeBlock: "EXCLUDED — do NOT suggest any of these (the user already has them):\n- SpaceX\n- Blue Origin\n- Anduril",
        count: 20,
    },
    "employment-type-classifier": {
        itemCount: 3,
        inputLines: "0|Acme Corp|Senior Backend Engineer|NYC\n1|Beta Labs|Summer 2026 SWE Intern|\n2|Gamma Inc|Contract Negotiator|Remote",
    },
    "email-parser": {
        anchor: "2026-05-20T15:30:00.000Z",
        from: "recruiting@betalabs.com",
        subject: "Beta Labs — Senior Backend Engineer — phone screen invitation",
        body: "Hi Jane,\n\nThanks for applying. We'd like to invite you to a 45-min technical phone screen. Let us know your availability for next week.\n\nSam from Recruiting",
    },
    "resume-rewrite": {
        postingTitle: "Senior Backend Engineer",
        postingCompany: "Acme Corp",
        postingSeniority: "senior",
        postingKeywordsBlock: "  - go\n  - distributed-systems\n  - postgresql\n  - grpc",
        readmesBlock: "",
        bulletsJson: JSON.stringify([
            { id: "blt_1", originalText: "Built distributed payments service handling 50k tx/day", matchedTags: ["go"], matchedKeywords: ["distributed-systems"], sourceLabel: "Acme — Engineer", locked: false },
        ], null, 2),
    },
    "bullet-assist-fill": {
        spine: "## Entry\n- Kind: work-role\n- Company: Acme Corp\n- Title: Software Engineer\n- Start date: 2022-01-01\n- End date: Present",
        siblings: "## Other bullets in this profile (voice + vocabulary reference)\n- Migrated a TypeScript monorepo to pnpm\n- Cut p99 latency by 40 percent",
        archive: "",
        scratchpad: "## User's notes about this role/project/education (their own voice)\nWorked on backend payments — most of the impact was migrating the legacy TypeScript service off Express to Fastify. Cut latency a lot. Also unblocked the platform team on a framework-swap playbook.",
        readme: "",
        currentBulletText: "",
        currentBulletTags: "",
    },
    "bullet-assist-rewrite": {
        spine: "## Entry\n- Kind: work-role\n- Company: Acme Corp\n- Title: Software Engineer",
        siblings: "## Other bullets in this profile (voice + vocabulary reference)\n- Migrated a TypeScript monorepo to pnpm",
        archive: "",
        scratchpad: "",
        readme: "",
        currentBulletText: "Worked on stuff",
        currentBulletTags: '"general"',
    },
};
