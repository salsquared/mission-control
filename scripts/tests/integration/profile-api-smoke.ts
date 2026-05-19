/**
 * Headless API smoke test for the Profile dash.
 *
 * Forges a NextAuth database session against the real dev user, exercises every
 * /api/profile route via fetch, then tears the session row back down. Run with:
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/profile-api-smoke.ts
 *
 * Requires `npm run dev` to be running on port 4101.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) {
    console.error(`[FAIL] ${msg}`, detail ?? "");
    fails++;
}

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in to the app once before running.");
        process.exit(1);
    }
    console.log(`Using user ${user.email} (${user.id})`);

    const sessionToken = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires },
    });
    console.log(`Forged session expires ${expires.toISOString()}`);

    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };
    const createdIds: { kind: "work-roles" | "projects" | "education"; id: string }[] = [];

    try {
        // --- GET /api/profile ---
        {
            const r = await fetch(`${BASE}/api/profile`, { headers: { Cookie: cookie } });
            const body = await r.json();
            if (r.status !== 200) return fail(`GET /api/profile status ${r.status}`, body);
            if (!body.profile?.id) return fail("GET /api/profile missing profile.id", body);
            pass("GET /api/profile returns hydrated profile");
            const p = body.profile;
            if (!Array.isArray(p.workRoles) || !Array.isArray(p.projects) || !Array.isArray(p.education)) {
                return fail("GET /api/profile profile is missing child arrays", p);
            }
            pass("GET /api/profile has workRoles[]/projects[]/education[]");
        }

        // --- PATCH /api/profile (header) ---
        const originalHeadline: string | null = await prisma.profile.findUnique({
            where: { userId: user.id }, select: { headline: true },
        }).then(p => p?.headline ?? null);
        {
            const r = await fetch(`${BASE}/api/profile`, {
                method: "PATCH", headers,
                body: JSON.stringify({ headline: "Smoke headline" }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`PATCH /api/profile status ${r.status}`, body);
            if (body.profile?.headline !== "Smoke headline") return fail("PATCH headline not echoed", body);
            pass("PATCH /api/profile writes headline");
        }
        // restore
        await fetch(`${BASE}/api/profile`, {
            method: "PATCH", headers,
            body: JSON.stringify({ headline: originalHeadline }),
        });
        pass("PATCH /api/profile restored original headline");

        // --- POST /api/profile/work-roles ---
        let workRoleId = "";
        {
            const r = await fetch(`${BASE}/api/profile/work-roles`, {
                method: "POST", headers,
                body: JSON.stringify({
                    company: "Smoke Co API",
                    title: "API Tester",
                    location: "remote",
                    startDate: new Date("2024-01-01").toISOString(),
                    endDate: null,
                    bullets: [
                        { text: "Built API smoke harness", tags: ["test"] },
                        { text: "Verified SSE plumbing", locked: true },
                    ],
                }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST work-roles status ${r.status}`, body);
            if (!body.workRole?.id) return fail("POST work-roles missing workRole.id", body);
            workRoleId = body.workRole.id;
            createdIds.push({ kind: "work-roles", id: workRoleId });
            pass(`POST /api/profile/work-roles → ${workRoleId}`);
            const bullets = body.workRole.bullets;
            if (!Array.isArray(bullets) || bullets.length !== 2 || !bullets[0].id) {
                return fail("POST work-roles bullets not normalized", bullets);
            }
            pass("POST work-roles normalized bullets (ids assigned)");
            if (bullets[1].locked !== true) return fail("POST work-roles lost bullet.locked", bullets);
            pass("POST work-roles preserved bullet.locked=true");
        }

        // --- PATCH /api/profile/work-roles ---
        {
            const r = await fetch(`${BASE}/api/profile/work-roles`, {
                method: "PATCH", headers,
                body: JSON.stringify({ id: workRoleId, title: "API Tester (Updated)" }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`PATCH work-roles status ${r.status}`, body);
            if (body.workRole?.title !== "API Tester (Updated)") return fail("PATCH work-roles title not echoed", body);
            pass("PATCH /api/profile/work-roles updates title");
        }

        // GET profile and confirm the work role shows up
        {
            const r = await fetch(`${BASE}/api/profile`, { headers: { Cookie: cookie } });
            const body = await r.json();
            const found = body.profile.workRoles.find((w: { id: string }) => w.id === workRoleId);
            if (!found) return fail("GET /api/profile did not include new work role", body.profile.workRoles);
            if (found.title !== "API Tester (Updated)") return fail("GET work role title stale", found);
            pass("GET /api/profile reflects PATCHed work role");
        }

        // --- POST /api/profile/projects ---
        let projectId = "";
        {
            const r = await fetch(`${BASE}/api/profile/projects`, {
                method: "POST", headers,
                body: JSON.stringify({
                    name: "Smoke Project API",
                    description: "API smoke test project",
                    bullets: [{ text: "p1" }],
                }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST projects status ${r.status}`, body);
            projectId = body.project.id;
            createdIds.push({ kind: "projects", id: projectId });
            pass(`POST /api/profile/projects → ${projectId}`);
        }

        // --- POST /api/profile/education ---
        let eduId = "";
        {
            const r = await fetch(`${BASE}/api/profile/education`, {
                method: "POST", headers,
                body: JSON.stringify({
                    institution: "Smoke U API",
                    degree: "MS",
                    field: "Test Ops",
                    bullets: [],
                }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST education status ${r.status}`, body);
            eduId = body.education.id;
            createdIds.push({ kind: "education", id: eduId });
            pass(`POST /api/profile/education → ${eduId}`);
        }

        // --- Negative: 400 on bad payload ---
        {
            const r = await fetch(`${BASE}/api/profile/work-roles`, {
                method: "POST", headers,
                body: JSON.stringify({ company: "missing title and dates" }),
            });
            if (r.status !== 400) return fail(`POST work-roles bad payload expected 400 got ${r.status}`);
            pass("POST work-roles rejects invalid payload with 400");
        }

        // --- DELETE all three ---
        for (const { kind, id } of createdIds) {
            const r = await fetch(`${BASE}/api/profile/${kind}?id=${encodeURIComponent(id)}`, {
                method: "DELETE", headers: { Cookie: cookie },
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`DELETE ${kind}/${id} status ${r.status}`, body);
            if (body.success !== true) return fail(`DELETE ${kind}/${id} success !== true`, body);
            pass(`DELETE /api/profile/${kind}?id=${id.slice(0, 8)}…`);
        }
        // mark as cleaned so finally block doesn't double-delete
        createdIds.length = 0;

        // --- DELETE idempotent (404 on unknown id) ---
        {
            const r = await fetch(`${BASE}/api/profile/work-roles?id=does-not-exist`, {
                method: "DELETE", headers: { Cookie: cookie },
            });
            if (r.status !== 404) return fail(`DELETE unknown id expected 404 got ${r.status}`);
            pass("DELETE unknown work-role id returns 404");
        }

        // Final GET, confirm the deletions are visible
        {
            const r = await fetch(`${BASE}/api/profile`, { headers: { Cookie: cookie } });
            const body = await r.json();
            const leak = body.profile.workRoles.find((w: { id: string }) => w.id === workRoleId)
                ?? body.profile.projects.find((p: { id: string }) => p.id === projectId)
                ?? body.profile.education.find((e: { id: string }) => e.id === eduId);
            if (leak) return fail("Final GET still shows deleted records", leak);
            pass("Final GET shows none of the scratch records");
        }
    } finally {
        // Best-effort cleanup of any leftover scratch rows (in case of failure mid-run)
        for (const { kind, id } of createdIds) {
            try {
                await fetch(`${BASE}/api/profile/${kind}?id=${encodeURIComponent(id)}`, {
                    method: "DELETE", headers: { Cookie: cookie },
                });
            } catch { /* ignore */ }
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }

    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
