/**
 * DOCX-format smoke for the resumes API.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/resume-docx-smoke.ts
 *
 * Forges a session, seeds a temp work role + project, calls POST /api/resumes
 * with `options.format: 'docx'`, verifies the response is a real DOCX
 * (correct content-type, .docx filename, PK ZIP magic), re-parses it via
 * mammoth to confirm content roundtripped, then deletes scratch entities.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { writeFileSync, statSync } from "fs";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

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
    const created: { kind: "work-roles" | "projects"; id: string }[] = [];

    try {
        // Seed minimal profile
        const wrRes = await fetch(`${BASE}/api/profile/work-roles`, {
            method: "POST", headers,
            body: JSON.stringify({
                company: "DOCX Smoke Co",
                title: "Software Engineer",
                location: "Remote",
                startDate: new Date("2024-01-01").toISOString(),
                bullets: [
                    { text: "Built TypeScript microservices behind a Next.js dashboard", tags: ["typescript", "nextjs"] },
                    { text: "Cut p95 latency from 600ms to 90ms with a Redis read-through cache", tags: ["performance", "caching"] },
                ],
            }),
        });
        const wrBody = await wrRes.json();
        if (wrRes.status !== 200) throw new Error(`seed work role failed: ${JSON.stringify(wrBody)}`);
        created.push({ kind: "work-roles", id: wrBody.workRole.id });

        const prRes = await fetch(`${BASE}/api/profile/projects`, {
            method: "POST", headers,
            body: JSON.stringify({
                name: "smoke-project",
                description: "Test project for DOCX smoke",
                // Use tags that overlap with the posting so the selector includes the project.
                bullets: [{ text: "Built TypeScript Next.js dashboard with Redis caching layer", tags: ["typescript", "nextjs", "performance"] }],
            }),
        });
        const prBody = await prRes.json();
        if (prRes.status !== 200) throw new Error(`seed project failed: ${JSON.stringify(prBody)}`);
        created.push({ kind: "projects", id: prBody.project.id });

        // Request DOCX
        const posting = { text: "Senior Software Engineer — TypeScript, Next.js, performance optimization, distributed systems. Remote OK, US time zones." };
        const t0 = Date.now();
        const res = await fetch(`${BASE}/api/resumes`, {
            method: "POST", headers,
            body: JSON.stringify({ posting, options: { format: "docx" } }),
        });
        const elapsed = Date.now() - t0;
        console.log(`POST /api/resumes?format=docx → HTTP ${res.status} in ${elapsed}ms`);
        if (!res.ok) {
            const body = await res.json();
            throw new Error(`generation failed: ${JSON.stringify(body)}`);
        }

        // Verify response shape
        const ct = res.headers.get("Content-Type");
        const cd = res.headers.get("Content-Disposition");
        const xFormat = res.headers.get("X-Resume-Format");
        console.log(`Content-Type:        ${ct}`);
        console.log(`Content-Disposition: ${cd}`);
        console.log(`X-Resume-Format:     ${xFormat}`);

        if (ct !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
            throw new Error(`unexpected Content-Type: ${ct}`);
        }
        if (!cd?.includes(".docx")) throw new Error(`Content-Disposition missing .docx: ${cd}`);
        if (xFormat !== "docx") throw new Error(`X-Resume-Format mismatch: ${xFormat}`);

        const buf = Buffer.from(await res.arrayBuffer());
        const outPath = "/tmp/mc-resume-docx-smoke.docx";
        writeFileSync(outPath, buf);
        console.log(`[OK] wrote ${statSync(outPath).size} bytes to ${outPath}`);

        // PK ZIP magic — DOCX is a ZIP
        if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
            throw new Error(`response missing PK ZIP magic (got ${buf[0].toString(16)} ${buf[1].toString(16)})`);
        }
        console.log("[PASS] PK ZIP magic present");

        // Round-trip via mammoth to verify content survives
        const mammoth = await import("mammoth");
        const extracted = await mammoth.extractRawText({ buffer: buf });
        const text = extracted.value;
        console.log(`[verify] mammoth round-trip extracted ${text.length} chars`);
        // Section titles render as "Experience"/"Projects"/"Education" in the underlying text
        // (the visible uppercase comes from CSS text-transform, which mammoth doesn't apply).
        const mustContain = ["Experience", "DOCX Smoke Co", "smoke-project"];
        for (const needle of mustContain) {
            if (!text.includes(needle)) {
                console.error(`[FAIL] DOCX missing "${needle}"`);
                console.error("--- extracted snippet ---");
                console.error(text.slice(0, 400));
                throw new Error("DOCX content verification failed");
            }
        }
        console.log("[PASS] DOCX contains expected sections + entities");
    } finally {
        for (const { kind, id } of created) {
            await fetch(`${BASE}/api/profile/${kind}?id=${id}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
    }
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
