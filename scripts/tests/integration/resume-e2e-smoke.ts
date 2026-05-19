/**
 * End-to-end smoke for the resume generation API against the real dev user.
 *
 * Forges a NextAuth session, creates a temporary work role + project with
 * bullets, calls POST /api/resumes, verifies a PDF comes back, then deletes
 * the scratch data and the session.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/resume-e2e-smoke.ts
 *
 * Requires the dev server on 4101 and GOOGLE_GENERATIVE_AI_KEY (or fallback)
 * set in the dev process's environment.
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
    console.log(`Using user ${user.email} (${user.id})`);

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };
    const created: { kind: "work-roles" | "projects"; id: string }[] = [];

    try {
        // 1. Seed a work role
        const wrRes = await fetch(`${BASE}/api/profile/work-roles`, {
            method: "POST", headers,
            body: JSON.stringify({
                company: "Hubble Labs",
                title: "Software Engineer Intern",
                location: "Remote",
                startDate: new Date("2024-06-01").toISOString(),
                endDate: new Date("2024-08-31").toISOString(),
                bullets: [
                    { text: "Built TypeScript API endpoints in a Next.js app handling 10k req/day", tags: ["typescript", "nextjs", "api"] },
                    { text: "Wrote Postgres migrations and optimized a slow ORM query from 800ms to 80ms", tags: ["postgres", "performance"] },
                    { text: "Added accessibility audits to CI, caught 14 issues before launch", tags: ["accessibility", "ci"] },
                    { text: "Pair-programmed a React component library used across three internal dashboards", tags: ["react", "components"] },
                ],
            }),
        });
        const wrBody = await wrRes.json();
        if (wrRes.status !== 200) throw new Error(`seed work role failed: ${JSON.stringify(wrBody)}`);
        created.push({ kind: "work-roles", id: wrBody.workRole.id });
        console.log(`[seed] work role ${wrBody.workRole.id}`);

        // 2. Seed a project
        const prRes = await fetch(`${BASE}/api/profile/projects`, {
            method: "POST", headers,
            body: JSON.stringify({
                name: "mission-control",
                description: "Personal Next.js dashboard.",
                repoUrl: "https://github.com/salsquared/mission-control",
                bullets: [
                    { text: "Designed dash carousel architecture in Next.js + Zustand + TanStack Query", tags: ["nextjs", "zustand", "react"] },
                ],
            }),
        });
        const prBody = await prRes.json();
        if (prRes.status !== 200) throw new Error(`seed project failed: ${JSON.stringify(prBody)}`);
        created.push({ kind: "projects", id: prBody.project.id });
        console.log(`[seed] project ${prBody.project.id}`);

        // 3. Generate a resume
        const posting = {
            text: "Software Engineer Intern — Summer 2026. We're looking for engineers comfortable with TypeScript, React, and Next.js, who have shipped production web apps. You will work on a high-traffic dashboard, integrate with Postgres, build accessible UI, and collaborate with senior engineers. Experience with serverless deployment (Vercel, AWS Lambda), CI/CD, and modern testing practices is a plus. Remote-friendly, US time zones.",
        };
        const t0 = Date.now();
        const res = await fetch(`${BASE}/api/resumes`, {
            method: "POST", headers,
            body: JSON.stringify({ posting }),
        });
        const elapsed = Date.now() - t0;
        console.log(`POST /api/resumes → HTTP ${res.status} in ${elapsed}ms`);

        if (!res.ok) {
            const body = await res.json();
            throw new Error(`generation failed: ${JSON.stringify(body)}`);
        }
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        const outPath = "/tmp/mc-resume-e2e.pdf";
        writeFileSync(outPath, buf);
        const size = statSync(outPath).size;
        const isPDF = buf.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]));
        console.log(`[OK] wrote ${size} bytes to ${outPath} (PDF magic: ${isPDF ? "yes" : "NO"})`);
        if (!isPDF) throw new Error("response was not a PDF");

        const company = res.headers.get("X-Resume-Company");
        const title = res.headers.get("X-Resume-Title");
        console.log(`X-Resume-Company: ${company}`);
        console.log(`X-Resume-Title:   ${title}`);
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
