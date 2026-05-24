/**
 * LOP-6 sync: push every `docs/llm-prompts/<slug>.md` snapshot into Lunary's
 * prompt registry. Idempotent — creates the template if absent, adds a new
 * version when on-disk content diverges from Lunary's latest, no-ops when
 * everything matches.
 *
 * Auth: requires `LUNARY_SECRET_KEY` in .env (the private/secret API key from
 * Lunary dashboard → Settings, NOT the public/tracing key).
 *
 * Run: `npx tsx scripts/sync-lunary-templates.ts`
 *   - `DRY_RUN=1` — parse + log payloads but skip all writes.
 *   - `ONLY=<slug>` — restrict to a single template (e.g. `ONLY=resume-rewrite`).
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.lunary.ai/v1";
const KEY = process.env.LUNARY_SECRET_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY = process.env.ONLY;

if (!KEY) {
    console.error("LUNARY_SECRET_KEY missing from .env — get it from Lunary dashboard → Settings → 'Private API key' / 'Secret key'.");
    process.exit(1);
}

interface Message { role: "system" | "user"; content: string }

interface ParsedTemplate {
    slug: string;
    mode: "openai";
    content: Message[];
    extra: { model?: string; temperature?: number; max_tokens?: number };
}

function stripAnnotations(s: string): string {
    // Strip ` ← documentation comment until end of line` markers from prompt docs.
    return s.replace(/[ \t]*←[^\n]*/g, "");
}

function extractCodeBlock(text: string, sectionTitle: string): string | null {
    // Line-by-line walker that handles two subtleties: (a) sections without
    // a fence (e.g. discovery-suggest's System) bail at the next `## ` line
    // instead of bleeding into the next section's fence; (b) `## Output
    // schema` inside a fence body is content, not a section boundary; (c)
    // 3- vs 4-backtick fences are matched exactly, so a 4-backtick outer
    // (e.g. profile-synthesize) survives nested ```json blocks intact.
    const headerRe = new RegExp(`^## ${sectionTitle}\\b[^\\n]*\\n`, "m");
    const headerMatch = text.match(headerRe);
    if (!headerMatch || headerMatch.index === undefined) return null;
    const after = text.slice(headerMatch.index + headerMatch[0].length);
    const lines = after.split("\n");

    let openIdx = -1;
    let openChars: "```" | "````" | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(/^(````|```)([a-z]*)$/);
        if (fenceMatch) {
            openChars = fenceMatch[1] as "```" | "````";
            openIdx = i;
            break;
        }
        if (/^## /.test(line)) return null;
    }
    if (openIdx < 0 || openChars === null) return null;

    for (let i = openIdx + 1; i < lines.length; i++) {
        if (lines[i] === openChars) return lines.slice(openIdx + 1, i).join("\n");
    }
    return null;
}

function parsePromptDoc(text: string, slug: string): ParsedTemplate {
    const modelLine = text.match(/\*\*Model:\*\*[^\n]+/)?.[0] ?? "";
    const ticked = [...modelLine.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    // Pick the gemini-* id; for some files the constant comes first, for
    // email-parser the model id comes first directly.
    const model = ticked.find(s => /^gemini[-\d.]/.test(s));

    const tempMatch = text.match(/\*\*Temperature:\*\*\s*([0-9.]+)/);
    const temperature = tempMatch ? parseFloat(tempMatch[1]) : undefined;

    const maxMatch = text.match(/\*\*Max output tokens:\*\*\s*([0-9]+)/);
    const max_tokens = maxMatch ? parseInt(maxMatch[1], 10) : undefined;

    const systemRaw = extractCodeBlock(text, "System");
    const userRaw = extractCodeBlock(text, "User template");

    if (!userRaw) {
        throw new Error(`${slug}: no fenced user-template block found`);
    }

    const messages: Message[] = [];
    if (systemRaw) {
        messages.push({ role: "system", content: stripAnnotations(systemRaw) });
    }
    messages.push({ role: "user", content: stripAnnotations(userRaw) });

    return {
        slug,
        mode: "openai",
        content: messages,
        extra: {
            ...(model ? { model } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(max_tokens !== undefined ? { max_tokens } : {}),
        },
    };
}

async function lunary<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(API_BASE + p, {
        method,
        headers: {
            Authorization: `Bearer ${KEY}`,
            "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) as T : ({} as T);
}

interface LunaryVersion { id: number; content: unknown; extra: unknown }
interface LunaryTemplate { id: number; slug: string; versions: LunaryVersion[] }

// Stable stringify — sort keys at every depth so JSON-compare is independent
// of object key order. Lunary returns `extra` with keys in different order
// than we sent them; without this every re-run looked like a content change.
function stableStringify(v: unknown): string {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}

function contentEquals(a: unknown, b: unknown): boolean {
    return stableStringify(a) === stableStringify(b);
}

async function findBySlug(slug: string): Promise<LunaryTemplate | null> {
    // `?limit=200` is defensive — without it Lunary may paginate and we'd
    // miss existing templates beyond the default page size, then incorrectly
    // POST a duplicate. 200 is comfortably above any realistic LLM-callsite
    // count for a single project.
    const list = await lunary<LunaryTemplate[]>("GET", "/templates?limit=200");
    return list.find(t => t.slug === slug) ?? null;
}

async function syncOne(parsed: ParsedTemplate): Promise<"created" | "versioned" | "up-to-date"> {
    if (DRY_RUN) {
        console.log(`[DRY] ${parsed.slug} payload:\n${JSON.stringify(parsed, null, 2)}\n`);
        return "up-to-date";
    }

    const existing = await findBySlug(parsed.slug);
    if (!existing) {
        await lunary("POST", "/templates", { ...parsed, isDraft: false });
        return "created";
    }

    // versions[] comes back inline on the template object. Last entry wins
    // (Lunary appends in creation order — verified against /templates response).
    const latest = existing.versions[existing.versions.length - 1];
    if (latest && contentEquals(latest.content, parsed.content) && contentEquals(latest.extra, parsed.extra)) {
        return "up-to-date";
    }

    await lunary("POST", `/templates/${existing.id}/versions`, {
        content: parsed.content,
        extra: parsed.extra,
        isDraft: false,
        testValues: {},
        notes: `Synced from docs/llm-prompts/${parsed.slug}.md at ${new Date().toISOString()}`,
    });
    return "versioned";
}

async function main() {
    const dir = path.resolve("docs/llm-prompts");
    const files = (await fs.readdir(dir))
        .filter(f => f.endsWith(".md") && f !== "README.md")
        .sort();

    const targets = ONLY ? files.filter(f => f === `${ONLY}.md`) : files;
    if (targets.length === 0) {
        console.error(`No matching prompt docs (ONLY=${ONLY}, available: ${files.join(", ")})`);
        process.exit(1);
    }

    const summary: Record<string, string> = {};
    for (const file of targets) {
        const slug = file.replace(/\.md$/, "");
        const text = await fs.readFile(path.join(dir, file), "utf8");
        try {
            const parsed = parsePromptDoc(text, slug);
            const result = await syncOne(parsed);
            summary[slug] = result;
            console.log(`✓ ${slug}: ${result}`);
        } catch (err) {
            summary[slug] = `error: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`✗ ${slug}: ${summary[slug]}`);
        }
    }

    console.log("\n--- summary ---");
    for (const [slug, result] of Object.entries(summary)) {
        console.log(`  ${slug}: ${result}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
