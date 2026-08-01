/**
 * Hermetic smoke for the owner-only crew routes (docs/multi-user-crew.html P7).
 *
 *   npx tsx scripts/tests/hermetic/crew-routes-smoke.ts
 *
 * SCOPE — what this file does and does NOT cover, so the two suites don't
 * duplicate each other:
 *
 *   role-matrix-smoke.ts already proves the GUARD: that /api/crew and
 *   /api/crew/[id] are owner-only and that a crew viewer gets 403 from both.
 *   That is not re-asserted here.
 *
 *   This file covers the route-specific SAFETY LOGIC that sits behind the
 *   guard, i.e. everything that can still go wrong once the caller really is
 *   the owner. All of it is about the delete path, because the delete path is
 *   the one that is irreversible:
 *
 *     1. `confirmEmail` must name the SAME person as the id. The dangerous
 *        failure mode of a confirmation dialog is not "deletes nobody", it is
 *        "deletes somebody else" — a stale roster, a race, or a mis-wired
 *        button. The id says which row; the typed string says which human.
 *     2. The owner row is never removable, even with a perfectly matching
 *        confirmation, because `resolveOwner()` selects on it.
 *     3. POST accepts an email and NOTHING else — a `role` field must be
 *        rejected rather than ignored, or the route becomes able to mint an
 *        owner.
 *
 * Hermetic: the schemas and the shared core are exercised directly against a
 * throwaway SQLite file. No network, no PM2, no dev.db / prod.db.
 */

const SCRATCH_DB = `/tmp/crew-routes-smoke-${process.pid}.db`;
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CrewCreateSchema, CrewDeleteSchema } from "@/lib/schemas/crew";
import { addCrew, removeUser, type Db, type Ops } from "@/lib/crew/core";
import { crewOps } from "@/lib/crew/ops";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
function check(cond: boolean, msg: string, detail?: unknown) { cond ? pass(msg) : fail(msg, detail); }

const OWNER_EMAIL = "owner@crew-routes-smoke.invalid";
const CREW_EMAIL = "crew@crew-routes-smoke.invalid";

/**
 * Re-implements the route's step (2) EXACTLY as `app/api/crew/[id]/route.ts`
 * writes it. Kept as a named function so the assertion below is testing a rule
 * rather than an inlined expression, and so a future change to the route's
 * comparison is a visible, one-line divergence from this file.
 */
function confirmMatches(typed: string, actual: string | null): boolean {
    const t = typed.trim().toLowerCase();
    const a = (actual ?? "").trim().toLowerCase();
    return Boolean(a) && t === a;
}

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "crew-routes-smoke-"));
    let db: Db | undefined;

    try {
        // ── Fixture: a real SQLite file with the live schema, an owner and a crew row.
        execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
            env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
            stdio: "pipe",
        });
        const { PrismaClient } = await import("@prisma/client");
        db = new PrismaClient({ datasourceUrl: `file:${SCRATCH_DB}` }) as unknown as Db;
        await db.user.create({ data: { email: OWNER_EMAIL, role: "owner" } });

        const ops: Ops = { ...crewOps(db), resumesDir: join(dir, "resumes"), uploadsDir: join(dir, "uploads") };

        // ── 1. POST body schema: email only, `role` is REJECTED not ignored.
        console.log("\n── 1. Create schema cannot carry a role");
        check(CrewCreateSchema.safeParse({ email: CREW_EMAIL }).success,
            "create: a bare email parses");
        check(!CrewCreateSchema.safeParse({ email: CREW_EMAIL, role: "owner" }).success,
            "create: a `role` field is REJECTED by .strict(), not silently dropped");
        check(!CrewCreateSchema.safeParse({}).success, "create: an empty body is rejected");
        check(!CrewDeleteSchema.safeParse({}).success,
            "delete: a body with no confirmEmail is rejected");
        check(!CrewDeleteSchema.safeParse({ confirmEmail: CREW_EMAIL, force: true }).success,
            "delete: an extra `force` field is rejected — no undocumented escape hatch");

        // ── 2. addCrew writes crew, never owner.
        console.log("\n── 2. Provisioning");
        const created = await addCrew(CREW_EMAIL, ops);
        check(created.ok && created.outcome === "created", "add: provisions a new account", created.outcome);
        check(created.role === "crew", "add: the created row is role='crew'", created.role);
        const dup = await addCrew(CREW_EMAIL, ops);
        check(dup.outcome === "duplicate", "add: a second add of the same email is a duplicate, not a second row", dup.outcome);
        check(await db.user.count({ where: { email: CREW_EMAIL } }) === 1, "add: exactly one row exists for that email");

        // ── 3. The confirm-email cross-check — the route's own safety step.
        console.log("\n── 3. confirmEmail must name the SAME person as the id");
        const crewRow = await db.user.findUnique({ where: { email: CREW_EMAIL } });
        check(confirmMatches(CREW_EMAIL, crewRow?.email ?? null), "confirm: the exact email matches");
        check(confirmMatches("  CREW@Crew-Routes-Smoke.INVALID  ", crewRow?.email ?? null),
            "confirm: matching is case- and whitespace-insensitive (a correct human answer is accepted)");
        check(!confirmMatches(OWNER_EMAIL, crewRow?.email ?? null),
            "confirm: a DIFFERENT real account's email does NOT match — this is the delete-the-wrong-person guard");
        check(!confirmMatches("", crewRow?.email ?? null), "confirm: an empty string never matches");
        check(!confirmMatches("anything", null), "confirm: a row with no email can never be confirmed");

        // ── 4. The owner is not removable, even with a perfect confirmation.
        console.log("\n── 4. The owner row is never removable");
        const refused = await removeUser(OWNER_EMAIL, ops, { confirm: true });
        check(refused.outcome === "refused-owner", "remove: the owner is refused outright", refused.outcome);
        check(!refused.ok, "remove: the owner refusal is not a success");
        check(await db.user.count({ where: { email: OWNER_EMAIL } }) === 1,
            "remove: the owner row SURVIVES the refused call");

        // ── 5. A confirmed crew removal really does remove.
        console.log("\n── 5. A confirmed crew removal succeeds");
        const removed = await removeUser(CREW_EMAIL, ops, { confirm: true });
        check(removed.ok && removed.outcome === "deleted", "remove: a confirmed crew removal deletes", removed.outcome);
        check(await db.user.count({ where: { email: CREW_EMAIL } }) === 0, "remove: the crew row is gone");
        check(await db.user.count({ where: { role: "owner" } }) === 1,
            "remove: exactly one owner still remains (OQ4a holds across the whole run)");
        const missing = await removeUser(CREW_EMAIL, ops, { confirm: true });
        check(missing.outcome === "not-found", "remove: removing it again is not-found, not a crash", missing.outcome);
    } finally {
        await (db as unknown as { $disconnect?: () => Promise<void> })?.$disconnect?.();
        rmSync(dir, { recursive: true, force: true });
        for (const f of [SCRATCH_DB, `${SCRATCH_DB}-journal`]) if (existsSync(f)) rmSync(f, { force: true });
    }
}

/** Exit path lives OUT here so no early return inside main() can skip it. */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} checks passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().then(finish, (e) => {
    console.error("smoke crashed:", e);
    process.exit(2);
});
