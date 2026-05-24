/**
 * Debug probe: confirm Lunary's renderTemplate(slug, vars) return shape for
 * one of our uploaded templates. We need to know whether it returns
 * `{ messages, ... }` or `{ system, user, ... }` so loadPrompt() in
 * lib/ai/prompts.ts can extract correctly.
 *
 * Run: npx tsx scripts/tests/debug/lunary-probe.ts
 */
import "dotenv/config";
import lunary from "lunary";

if (!process.env.LUNARY_PUBLIC_KEY) {
    console.error("LUNARY_PUBLIC_KEY missing — renderTemplate uses the PUBLIC key.");
    process.exit(1);
}

lunary.init({ publicKey: process.env.LUNARY_PUBLIC_KEY });

async function main() {
    const rendered = await lunary.renderTemplate("posting-parse", {
        postingText: "<<<PROBE POSTING TEXT>>>",
    });
    console.log("renderTemplate('posting-parse', vars) returned:");
    console.log(JSON.stringify(rendered, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
