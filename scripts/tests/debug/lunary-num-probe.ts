import "dotenv/config";
import lunary from "lunary";
lunary.init({ publicKey: process.env.LUNARY_PUBLIC_KEY! });

async function main() {
    // Number var
    const r1 = await lunary.renderTemplate("discovery-suggest", {
        topic: "space",
        excludeBlock: "(none)",
        count: 20,
    });
    const u1 = (r1 as any).messages?.[0]?.content ?? "";
    console.log("count=20 (number) → contains 'Suggest 20':", u1.includes("Suggest 20"));
    console.log("count=20 (number) → contains 'Suggest {{count}}':", u1.includes("{{count}}"));
    console.log("first 200 chars:", u1.slice(0, 200));
}
main().catch(e => { console.error(e); process.exit(1); });
