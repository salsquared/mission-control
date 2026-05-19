/**
 * End-to-end smoke for M8 Phase 2 — archival + traceability + Application linkage.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/resume-archival-smoke.ts
 *
 * Forges a session, seeds a work role + project + an Application, generates a
 * resume via POST /api/resumes with `applicationId` set, then verifies:
 *   - X-Resume-Id header returned
 *   - GeneratedResume row exists, status='ready', artifactPath set
 *   - The bytes are on disk under data/resumes/<id>.<ext>
 *   - GET /api/resumes/[id] returns selections + posting metadata
 *   - GET /api/resumes/[id]/download streams a valid PDF
 *   - GET /api/resumes?applicationId=<id> includes the row
 *   - Application is correctly linked
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }
    console.log(`Using user ${user.email}`);

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    const cleanup: Array<() => Promise<unknown>> = [];

    try {
        // Seed minimal profile
        const wr = await fetch(`${BASE}/api/profile/work-roles`, {
            method: "POST", headers,
            body: JSON.stringify({
                company: "Archival Smoke Co",
                title: "Engineer",
                location: "Remote",
                startDate: new Date("2024-01-01").toISOString(),
                bullets: [
                    { text: "Built a TypeScript Next.js dashboard with TanStack Query", tags: ["typescript", "nextjs"] },
                    { text: "Reduced p95 latency from 600ms to 90ms with Redis caching", tags: ["performance", "caching"] },
                ],
            }),
        });
        const wrBody = await wr.json();
        cleanup.push(() => fetch(`${BASE}/api/profile/work-roles?id=${wrBody.workRole.id}`, { method: "DELETE", headers: { Cookie: cookie } }));

        // Seed an Application
        const app = await fetch(`${BASE}/api/applications`, {
            method: "POST", headers,
            body: JSON.stringify({
                company: "Archival Smoke Target",
                role: "Senior Engineer",
                status: "INTERESTED",
                kind: "job",
            }),
        });
        const appBody = await app.json();
        const applicationId = appBody.application.id;
        cleanup.push(() => fetch(`${BASE}/api/applications?id=${applicationId}`, { method: "DELETE", headers: { Cookie: cookie } }));

        // Generate the resume, linked to the application
        const posting = { text: "Senior Software Engineer — TypeScript, Next.js, performance optimization. Remote OK." };
        const res = await fetch(`${BASE}/api/resumes`, {
            method: "POST", headers,
            body: JSON.stringify({ posting, applicationId, options: { format: "pdf" } }),
        });
        if (res.status !== 200) {
            const body = await res.json();
            return fail(`POST /api/resumes status ${res.status}`, body);
        }
        pass(`POST /api/resumes → 200`);

        const resumeId = res.headers.get("X-Resume-Id");
        if (!resumeId) return fail("X-Resume-Id header missing");
        pass(`X-Resume-Id returned: ${resumeId.slice(0, 8)}…`);

        // Verify the row exists with status=ready and an artifactPath
        const row = await prisma.generatedResume.findUnique({ where: { id: resumeId } });
        if (!row) return fail("GeneratedResume row not found in DB");
        pass("GeneratedResume row exists in DB");
        if (row.status !== "ready") fail(`row status=${row.status}, expected 'ready'`);
        else pass("row status='ready'");
        if (!row.artifactPath) return fail("row artifactPath is null");
        pass(`row artifactPath: ${row.artifactPath}`);
        if (row.applicationId !== applicationId) fail(`row applicationId mismatch: ${row.applicationId}`);
        else pass("row.applicationId matches");
        if (row.format !== "pdf") fail(`row format=${row.format}, expected 'pdf'`);
        else pass("row format='pdf'");

        // Verify the file exists on disk
        const filePath = join(process.cwd(), "data", "resumes", row.artifactPath);
        if (!existsSync(filePath)) return fail(`artifact missing on disk: ${filePath}`);
        const size = statSync(filePath).size;
        pass(`artifact on disk: ${size} bytes`);
        const head = readFileSync(filePath).subarray(0, 4);
        if (!head.equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) fail("artifact missing %PDF magic");
        else pass("artifact has %PDF magic");

        // GET /api/resumes/[id] — full row with selections
        const getOne = await fetch(`${BASE}/api/resumes/${resumeId}`, { headers: { Cookie: cookie } });
        if (getOne.status !== 200) return fail(`GET /api/resumes/[id] status ${getOne.status}`);
        const oneBody = await getOne.json();
        if (!oneBody.resume?.selections || !Array.isArray(oneBody.resume.selections)) return fail("selections missing or wrong type", oneBody.resume);
        pass(`GET /api/resumes/[id] returned ${oneBody.resume.selections.length} selections`);
        const firstSel = oneBody.resume.selections[0];
        if (!firstSel?.bulletId || !firstSel?.originalText || !firstSel?.rewrittenText) {
            fail("selection missing required fields", firstSel);
        } else {
            pass("selection has bulletId + originalText + rewrittenText");
        }
        if (oneBody.resume.profileSnapshot !== undefined) {
            fail("profileSnapshot should be omitted by default (includeSnapshot=0)");
        } else {
            pass("profileSnapshot omitted by default");
        }

        // GET /api/resumes/[id]/download
        const dl = await fetch(`${BASE}/api/resumes/${resumeId}/download`, { headers: { Cookie: cookie } });
        if (dl.status !== 200) return fail(`download status ${dl.status}`);
        if (dl.headers.get("Content-Type") !== "application/pdf") fail(`download content-type wrong: ${dl.headers.get("Content-Type")}`);
        else pass("download Content-Type is application/pdf");
        const dlBuf = Buffer.from(await dl.arrayBuffer());
        if (!dlBuf.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) fail("download bytes not a valid PDF");
        else pass("download bytes have %PDF magic");

        // GET /api/resumes?applicationId — list filtered
        const list = await fetch(`${BASE}/api/resumes?applicationId=${applicationId}`, { headers: { Cookie: cookie } });
        const listBody = await list.json();
        if (list.status !== 200) return fail(`list status ${list.status}`);
        const found = (listBody.resumes ?? []).find((r: { id: string }) => r.id === resumeId);
        if (!found) fail(`list with applicationId filter didn't include this row`);
        else pass("list filter by applicationId includes the new row");
        if (found && found.hasArtifact !== true) fail("hasArtifact should be true");
        else pass("hasArtifact=true on the list row");

        // Negative: GET another user's resume should 404 — we can't easily forge another user,
        // but we can confirm an unknown id returns 404.
        const nope = await fetch(`${BASE}/api/resumes/nonexistent-id-xxxxxx`, { headers: { Cookie: cookie } });
        if (nope.status !== 404) fail(`unknown id expected 404, got ${nope.status}`);
        else pass("GET /api/resumes/unknown → 404");

        cleanup.push(() => prisma.generatedResume.delete({ where: { id: resumeId } }));
    } finally {
        for (const fn of cleanup.reverse()) {
            await fn().catch(() => undefined);
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
