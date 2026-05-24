/**
 * Audit: verify Lunary's renderTemplate output matches the disk snapshot's
 * loadPromptFromDisk output for every slug, given identical vars. Drift
 * means production is sending Gemini a different prompt than the hermetic
 * smoke is asserting against — exactly the bug we want to catch.
 *
 * Run: npx tsx scripts/tests/debug/lunary-vs-disk-parity.ts
 */
import "dotenv/config";
import { loadPromptFromDisk } from "@/lib/ai/prompts";
import { PROMPT_SLUGS, SAMPLE_VARS } from "@/scripts/prompt-samples";
import lunary from "lunary";

if (!process.env.LUNARY_PUBLIC_KEY) {
    console.error("LUNARY_PUBLIC_KEY required to compare Lunary vs disk.");
    process.exit(1);
}
lunary.init({ publicKey: process.env.LUNARY_PUBLIC_KEY });

interface LunaryRendered {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    messages?: Array<{ role: string; content: string }>;
}

let pass = 0;
let fail = 0;

async function compareOne(slug: string): Promise<void> {
    const vars = SAMPLE_VARS[slug as keyof typeof SAMPLE_VARS];
    const disk = loadPromptFromDisk(slug, vars);

    let lun: LunaryRendered;
    try {
        lun = await lunary.renderTemplate(slug, vars) as LunaryRendered;
    } catch (err) {
        console.error(`✗ ${slug}: Lunary fetch failed — ${err instanceof Error ? err.message : String(err)}`);
        fail++;
        return;
    }

    const lunSystem = lun.messages?.find(m => m.role === "system")?.content;
    const lunUser = lun.messages?.find(m => m.role === "user")?.content;

    const issues: string[] = [];
    if ((disk.system ?? "") !== (lunSystem ?? "")) {
        const dl = (disk.system ?? "").length;
        const ll = (lunSystem ?? "").length;
        issues.push(`system differs (disk=${dl}b, lunary=${ll}b)`);
    }
    if (disk.user !== (lunUser ?? "")) {
        issues.push(`user differs (disk=${disk.user.length}b, lunary=${(lunUser ?? "").length}b)`);
    }
    if (disk.model !== lun.model) {
        issues.push(`model differs (disk=${disk.model}, lunary=${lun.model})`);
    }
    if (disk.temperature !== lun.temperature) {
        issues.push(`temperature differs (disk=${disk.temperature}, lunary=${lun.temperature})`);
    }
    if (disk.maxOutputTokens !== lun.max_tokens) {
        issues.push(`maxOutputTokens differs (disk=${disk.maxOutputTokens}, lunary=${lun.max_tokens})`);
    }

    if (issues.length === 0) {
        console.log(`✓ ${slug}`);
        pass++;
    } else {
        console.log(`✗ ${slug}`);
        for (const issue of issues) console.log(`    ${issue}`);
        fail++;
    }
}

async function main() {
    for (const slug of PROMPT_SLUGS) {
        await compareOne(slug);
    }
    console.log(`\n${pass}/${pass + fail} slugs match between Lunary and disk`);
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
