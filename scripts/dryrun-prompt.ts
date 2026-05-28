/**
 * Free dry-render of a prompt template. Reads `docs/llm-prompts/<slug>.md`,
 * substitutes `{{var}}` markers from the supplied vars JSON, prints the
 * rendered system + user prompts plus byte stats. **Zero LLM calls.**
 *
 * Use this for the rapid-iteration loop: edit a prompt doc → dry-render with
 * representative vars → eyeball the output → tweak → repeat. Only reach for
 * `npm run test:prompts` once you want the actual model's response.
 *
 * Usage:
 *   npx tsx scripts/dryrun-prompt.ts <slug>                  # uses built-in sample vars
 *   npx tsx scripts/dryrun-prompt.ts <slug> vars.json        # vars from a JSON file
 *   echo '{"postingText":"…"}' | npx tsx scripts/dryrun-prompt.ts <slug> -
 *
 * Available slugs (see docs/llm-calls.html inventory):
 *   bullet-assist-fill, bullet-assist-rewrite, discovery-suggest,
 *   email-parser, employment-type-classifier, posting-parse,
 *   profile-import, profile-synthesize, resume-rewrite
 */
import fs from "node:fs";
import path from "node:path";
import { loadPromptFromDisk, type PromptVars } from "@/lib/ai/prompts";
import { PROMPT_SLUGS, SAMPLE_VARS, type PromptSlug } from "@/scripts/prompt-samples";

const KNOWN_SLUGS: readonly string[] = PROMPT_SLUGS;

function usage(extra?: string): never {
    if (extra) console.error(extra + "\n");
    console.error(`Usage:\n  npx tsx scripts/dryrun-prompt.ts <slug> [vars.json | -]\n\nAvailable slugs:\n  ${KNOWN_SLUGS.join(", ")}`);
    process.exit(1);
}

async function readVars(arg: string | undefined, slug: string): Promise<PromptVars> {
    if (!arg) {
        const sample = SAMPLE_VARS[slug as PromptSlug];
        if (!sample) usage(`No built-in sample vars for slug "${slug}". Pass a vars JSON file.`);
        console.error(`[dryrun] using built-in sample vars for ${slug}\n`);
        return sample;
    }
    if (arg === "-") {
        const text = await new Promise<string>((resolve, reject) => {
            let buf = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (c) => { buf += c; });
            process.stdin.on("end", () => resolve(buf));
            process.stdin.on("error", reject);
        });
        return JSON.parse(text);
    }
    const file = path.resolve(arg);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function divider(label: string): string {
    return `\n${"─".repeat(8)} ${label} ${"─".repeat(Math.max(0, 60 - label.length))}\n`;
}

async function main() {
    const slug = process.argv[2];
    if (!slug) usage();
    if (!KNOWN_SLUGS.includes(slug)) usage(`Unknown slug "${slug}".`);

    const vars = await readVars(process.argv[3], slug);
    const rendered = loadPromptFromDisk(slug, vars);

    process.stdout.write(divider("METADATA"));
    process.stdout.write(`slug             ${slug}\n`);
    process.stdout.write(`model            ${rendered.model ?? "(unset)"}\n`);
    process.stdout.write(`temperature      ${rendered.temperature ?? "(unset)"}\n`);
    process.stdout.write(`maxOutputTokens  ${rendered.maxOutputTokens ?? "(unset)"}\n`);

    if (rendered.system) {
        process.stdout.write(divider(`SYSTEM (${Buffer.byteLength(rendered.system, "utf8")} bytes)`));
        process.stdout.write(rendered.system + "\n");
    } else {
        process.stdout.write(divider("SYSTEM"));
        process.stdout.write("(none — single-prompt template)\n");
    }

    process.stdout.write(divider(`USER (${Buffer.byteLength(rendered.user, "utf8")} bytes)`));
    process.stdout.write(rendered.user + "\n");

    // Diff the template's declared {{var}} markers against the vars the caller
    // supplied. Missing vars rendered as "" (intentional for optional sections),
    // but if you DIDN'T intend a section to be empty, this catches it.
    const templateText = fs.readFileSync(path.resolve("docs/llm-prompts", `${slug}.md`), "utf8");
    const declared = new Set<string>();
    for (const m of templateText.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) declared.add(m[1]);
    const supplied = new Set(Object.keys(vars));
    const missing = [...declared].filter(v => !supplied.has(v));
    const extra = [...supplied].filter(v => !declared.has(v));

    if (missing.length > 0 || extra.length > 0) {
        process.stdout.write(divider("VAR DIFF"));
        if (missing.length > 0) {
            process.stdout.write(`⚠ template declares ${missing.length} var(s) you didn't supply (rendered as ""):\n`);
            for (const v of missing) process.stdout.write(`    ${v}\n`);
        }
        if (extra.length > 0) {
            process.stdout.write(`ℹ you supplied ${extra.length} var(s) the template doesn't use:\n`);
            for (const v of extra) process.stdout.write(`    ${v}\n`);
        }
    }
}

main().catch(err => { console.error(err); process.exit(1); });
