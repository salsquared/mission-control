// Hermetic smoke for the Canon repository CRUD (docs/canonical-resumes.html §7
// P1.4 / P1.7). Runs against dev.db with the existing user; creates + tears
// down its own canons.
//   npx tsx scripts/tests/hermetic/canon-crud-smoke.ts

import { prisma } from "@/lib/prisma";
import { normalizeRoleName } from "@/lib/applications/normalize-role";
import {
    createCanon,
    listCanons,
    getCanon,
    updateCanon,
    deleteCanon,
    finalizeCanonGeneration,
} from "@/lib/repositories/canons";

let passes = 0;
let fails = 0;
function ok(msg: string, cond: boolean) {
    if (cond) { console.log(`[PASS] ${msg}`); passes++; }
    else { console.error(`[FAIL] ${msg}`); fails++; }
}

async function main() {
    const user = await prisma.user.findFirst({ select: { id: true } });
    if (!user) { console.error("No user in dev.db — log in once first."); process.exit(1); }
    const userId = user.id;
    const stamp = Date.now();
    const name = `Smoke Canon ${stamp}`;
    const created: string[] = [];

    try {
        // create
        const c = await createCanon(userId, { name, track: "career", keywords: "python OR typescript" });
        created.push(c.id);
        ok("create: slug = normalizeRoleName(name)", c.slug === normalizeRoleName(name));
        ok("create: track persisted", c.track === "career");
        ok("create: resumeStale defaults true", c.resumeStale === true);
        ok("create: versionCount 0", c.versionCount === 0);
        ok("create: resumeEntityIds empty", Array.isArray(c.resumeEntityIds) && c.resumeEntityIds.length === 0);

        // list + get
        const list = await listCanons(userId);
        ok("list: includes the new canon", list.some((x) => x.id === c.id));
        const got = await getCanon(userId, c.id);
        ok("get: returns it", got?.id === c.id);
        ok("get: cross-user isolation (bogus user → null)", (await getCanon("nonexistent-user", c.id)) === null);

        // simulate a generate, then a keyword edit → stale again
        await finalizeCanonGeneration(c.id, "fake-resume-id", ["ent-1", "ent-2"]);
        const afterGen = await getCanon(userId, c.id);
        ok("finalize: resumeStale cleared", afterGen?.resumeStale === false);
        ok("finalize: currentResumeId set", afterGen?.currentResumeId === "fake-resume-id");
        ok("finalize: resumeEntityIds recorded", afterGen ? afterGen.resumeEntityIds.length === 2 : false);

        const patched = await updateCanon(userId, c.id, { keywords: "rust OR go" });
        ok("patch keywords: persists", patched?.keywords === "rust OR go");
        ok("patch keywords: re-marks stale (§6 Q7)", patched?.resumeStale === true);

        const renamed = await updateCanon(userId, c.id, { name: `Smoke Renamed ${stamp}` });
        ok("patch name: slug recomputed", renamed?.slug === normalizeRoleName(`Smoke Renamed ${stamp}`));

        // duplicate slug → P2002
        let dupThrew = false;
        try {
            const d = await createCanon(userId, { name: `Smoke Renamed ${stamp}`, track: "side" });
            created.push(d.id);
        } catch (e) {
            dupThrew = (e as { code?: string }).code === "P2002";
        }
        ok("duplicate (userId, slug) → P2002", dupThrew);

        // delete + idempotency
        ok("delete: returns true", (await deleteCanon(userId, c.id)) === true);
        created.splice(created.indexOf(c.id), 1);
        ok("delete: idempotent (false for unknown)", (await deleteCanon(userId, c.id)) === false);
        ok("delete: gone from list", !(await listCanons(userId)).some((x) => x.id === c.id));
    } finally {
        for (const id of created) await prisma.canon.delete({ where: { id } }).catch(() => {});
    }

    console.log(`\n${passes} passed, ${fails} failed`);
    process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
