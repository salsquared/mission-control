import "dotenv/config";
import { loadPrompt, loadPromptFromDisk } from "@/lib/ai/prompts";

async function main() {
    console.log("=== Lunary path (LUNARY_PUBLIC_KEY=" + (process.env.LUNARY_PUBLIC_KEY ? "set" : "unset") + ") ===");
    const lun = await loadPrompt("posting-parse", { postingText: "<<<PROBE>>>" });
    console.log("model:", lun.model, "temp:", lun.temperature, "maxTokens:", lun.maxOutputTokens);
    console.log("system (first 80):", lun.system?.slice(0, 80));
    console.log("user (first 200):", lun.user.slice(0, 200));

    console.log("\n=== Disk fallback ===");
    const disk = loadPromptFromDisk("posting-parse", { postingText: "<<<PROBE>>>" });
    console.log("model:", disk.model, "temp:", disk.temperature, "maxTokens:", disk.maxOutputTokens);
    console.log("system (first 80):", disk.system?.slice(0, 80));
    console.log("user (first 200):", disk.user.slice(0, 200));

    console.log("\n=== Both paths match content? ===");
    console.log("system match:", lun.system === disk.system);
    console.log("user match:", lun.user === disk.user);
}
main().catch(e => { console.error(e); process.exit(1); });
