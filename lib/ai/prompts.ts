/**
 * LOP-6: prompt-registry façade.
 *
 * `loadPrompt(slug, vars)` returns the system/user pair (plus suggested
 * model + decoding params) for one of the 8 LLM callsites tracked in
 * `docs/llm-calls.md`. Two execution paths:
 *
 * 1. **Lunary registry** (when `LUNARY_PUBLIC_KEY` is set) — fetches the
 *    canonical version of the template from Lunary's prompt registry via
 *    `lunary.renderTemplate(slug, vars)`. Edits made in Lunary's dashboard
 *    take effect within the SDK's cache window (~minutes) without a code
 *    deploy.
 * 2. **Disk fallback** (when the key is unset, or Lunary errors) — parses
 *    `docs/llm-prompts/<slug>.md` from disk and renders `{{var}}`
 *    substitutions locally. This is what makes hermetic tests + dev runs
 *    without a Lunary account work, and what protects production if
 *    Lunary's API has a hiccup.
 *
 * The disk snapshot is the source-of-truth-during-migration artifact and is
 * kept identical to what was uploaded via `scripts/sync-lunary-templates.ts`.
 * After Lunary becomes the editing surface, mirror edits back to disk
 * same-day so `git log -p` reads cleanly.
 */
import fs from "node:fs";
import path from "node:path";
import lunary from "lunary";

export interface LoadedPrompt {
    system?: string;
    user: string;
    /** Suggested by the template — callers may override. */
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
}

export type PromptVars = Record<string, string | number | boolean | null | undefined>;

const LUNARY_ENABLED = Boolean(process.env.LUNARY_PUBLIC_KEY);

// ---------------------------------------------------------------------------
// Disk-fallback parser (mirrors scripts/sync-lunary-templates.ts:parsePromptDoc)
// ---------------------------------------------------------------------------

interface DiskPrompt {
    system?: string;
    user: string;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
}

const diskCache = new Map<string, DiskPrompt>();
let diskRootResolved: string | null = null;

function resolveDiskRoot(): string {
    if (diskRootResolved) return diskRootResolved;
    // process.cwd() works for both Next.js runtime (project root) and tsx
    // scripts (run from project root by convention).
    diskRootResolved = path.join(process.cwd(), "docs", "llm-prompts");
    return diskRootResolved;
}

function stripAnnotations(s: string): string {
    return s.replace(/[ \t]*←[^\n]*/g, "");
}

function extractCodeBlock(text: string, sectionTitle: string): string | null {
    const headerRe = new RegExp(`^## ${sectionTitle}\\b[^\\n]*\\n`, "m");
    const headerMatch = text.match(headerRe);
    if (!headerMatch || headerMatch.index === undefined) return null;
    const after = text.slice(headerMatch.index + headerMatch[0].length);
    const openRe = /(^|\n)```[a-z]*\n/;
    const openMatch = after.match(openRe);
    if (!openMatch || openMatch.index === undefined) return null;
    const contentStart = openMatch.index + openMatch[0].length;
    const rest = after.slice(contentStart);
    const closeMatch = rest.search(/\n```(\n|$)/);
    if (closeMatch < 0) return null;
    return rest.slice(0, closeMatch);
}

function parseDiskPrompt(slug: string): DiskPrompt {
    const cached = diskCache.get(slug);
    if (cached) return cached;

    const file = path.join(resolveDiskRoot(), `${slug}.md`);
    const text = fs.readFileSync(file, "utf8");

    const modelLine = text.match(/\*\*Model:\*\*[^\n]+/)?.[0] ?? "";
    const ticked = [...modelLine.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    const model = ticked.find(s => /^gemini[-\d.]/.test(s));

    const tempMatch = text.match(/\*\*Temperature:\*\*\s*([0-9.]+)/);
    const temperature = tempMatch ? parseFloat(tempMatch[1]) : undefined;

    const maxMatch = text.match(/\*\*Max output tokens:\*\*\s*([0-9]+)/);
    const maxOutputTokens = maxMatch ? parseInt(maxMatch[1], 10) : undefined;

    const systemRaw = extractCodeBlock(text, "System");
    const userRaw = extractCodeBlock(text, "User template");
    if (!userRaw) throw new Error(`prompts.ts: ${slug} has no user-template fenced block`);

    const parsed: DiskPrompt = {
        ...(systemRaw ? { system: stripAnnotations(systemRaw) } : {}),
        user: stripAnnotations(userRaw),
        ...(model ? { model } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    };
    diskCache.set(slug, parsed);
    return parsed;
}

function applyVars(template: string, vars: PromptVars): string {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
        const v = vars[name];
        if (v === undefined || v === null) return "";
        return String(v);
    });
}

function renderFromDisk(slug: string, vars: PromptVars): LoadedPrompt {
    const p = parseDiskPrompt(slug);
    return {
        ...(p.system !== undefined ? { system: applyVars(p.system, vars) } : {}),
        user: applyVars(p.user, vars),
        ...(p.model !== undefined ? { model: p.model } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.maxOutputTokens !== undefined ? { maxOutputTokens: p.maxOutputTokens } : {}),
    };
}

// ---------------------------------------------------------------------------
// Lunary fetch path
// ---------------------------------------------------------------------------

interface LunaryRendered {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    messages?: Array<{ role: string; content: string }>;
}

function fromLunaryShape(raw: LunaryRendered): LoadedPrompt {
    const system = raw.messages?.find(m => m.role === "system")?.content;
    const user = raw.messages?.find(m => m.role === "user")?.content;
    if (!user) {
        throw new Error("Lunary template rendered without a user message");
    }
    return {
        ...(system ? { system } : {}),
        user,
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.temperature !== undefined ? { temperature: raw.temperature } : {}),
        ...(raw.max_tokens !== undefined ? { maxOutputTokens: raw.max_tokens } : {}),
    };
}

/**
 * Load + render a prompt template for the named callsite.
 *
 * Variable substitution uses `{{varName}}` markers. The vars object's values
 * are coerced to strings (null/undefined → empty string). Variables not
 * present in the template are ignored; template variables not provided in
 * vars render as empty strings.
 *
 * Lunary path is preferred when configured; on error it logs a warn and
 * falls back to the disk snapshot — production keeps working through
 * transient Lunary API blips. The disk parser caches per-slug so repeated
 * calls don't re-read.
 */
export async function loadPrompt(slug: string, vars: PromptVars = {}): Promise<LoadedPrompt> {
    if (LUNARY_ENABLED) {
        try {
            const raw = await lunary.renderTemplate(slug, vars) as LunaryRendered;
            return fromLunaryShape(raw);
        } catch (err) {
            console.warn(`[PROMPTS] Lunary renderTemplate(${slug}) failed; using disk fallback: ${err instanceof Error ? err.message : String(err)}`);
            // fall through
        }
    }
    return renderFromDisk(slug, vars);
}

/**
 * Test/debug helper — force a disk read regardless of Lunary config. Useful
 * for hermetic smokes that want a deterministic snapshot independent of the
 * dashboard's current state.
 */
export function loadPromptFromDisk(slug: string, vars: PromptVars = {}): LoadedPrompt {
    return renderFromDisk(slug, vars);
}
