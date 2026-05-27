/**
 * PA-3 hermetic smoke. Verifies the race-safe dup-app prevention end-to-end:
 *
 *   1. Sequential creates with the same normalized key → second throws P2002.
 *   2. Concurrent Promise.all creates → exactly one wins, the other throws.
 *   3. findApplicationByCompany hits the normalizedCompany index when the
 *      input differs from the stored company by suffix only.
 *   4. updateApplication keeps normalizedCompany in sync when company is
 *      renamed.
 *
 * Cleans up its own rows. Hits dev.db.
 */
import { prisma } from "@/lib/prisma";
import {
    createApplication,
    findApplicationByCompany,
    updateApplication,
    deleteApplication,
} from "@/lib/repositories/applications";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) { console.error("No user — log in first."); process.exit(1); }

    const stamp = Date.now();
    const baseName = `pa3-smoke-${stamp}`;
    const created: string[] = [];

    try {
        // 1. Sequential creates with same normalized key.
        const a = await createApplication({
            userId: user.id,
            company: `${baseName}, Inc.`,
            role: "Engineer",
            status: "applied",
            track: "career",
        });
        created.push(a.id);
        check("first create succeeds + sets normalizedCompany", a.normalizedCompany === baseName);

        let secondThrew = false;
        try {
            await createApplication({
                userId: user.id,
                company: `${baseName} Corporation`, // same after normalize
                role: "Engineer",
                status: "applied",
                track: "career",
            });
        } catch (err: any) {
            if (err?.code === "P2002") secondThrew = true;
            else throw err;
        }
        check("second sequential create with same normalized key throws P2002", secondThrew);

        // 2. Concurrent creates.
        const raceName = `${baseName}-race`;
        const [r1, r2] = await Promise.allSettled([
            createApplication({ userId: user.id, company: `${raceName} Inc`, role: "X", status: "applied", track: "career" }),
            createApplication({ userId: user.id, company: `${raceName} Limited`, role: "X", status: "applied", track: "career" }),
        ]);
        const fulfilled = [r1, r2].filter(r => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[];
        const rejected = [r1, r2].filter(r => r.status === "rejected") as PromiseRejectedResult[];
        for (const f of fulfilled) created.push(f.value.id);
        check("concurrent: exactly one create wins", fulfilled.length === 1, `got ${fulfilled.length} winners`);
        check("concurrent: the loser threw P2002", rejected.length === 1 && (rejected[0].reason as { code?: string })?.code === "P2002");

        // 3. findApplicationByCompany matches across suffix differences.
        const found = await findApplicationByCompany(user.id, `${baseName} LLC`, "career");
        check("find by suffix-variant returns the keyed row", found?.id === a.id, `got id=${found?.id}`);

        // 4. Rename keeps normalizedCompany in sync.
        const renamedTarget = `pa3-smoke-renamed-${stamp}`;
        const renamed = await updateApplication(a.id, { company: `${renamedTarget} Co` });
        check("rename updates normalizedCompany", renamed.normalizedCompany === renamedTarget);
    } finally {
        for (const id of created) await deleteApplication(id).catch(() => {});
        await prisma.$disconnect();
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
