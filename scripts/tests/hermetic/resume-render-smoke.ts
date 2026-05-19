/**
 * Smoke for lib/resumes/render-pdf.ts. Builds a fake profile + fake selection +
 * fake rewrites, runs the full HTML → puppeteer → PDF pipeline, writes the PDF
 * to /tmp/mc-resume-smoke.pdf. No DB, no AI, no env vars beyond the optional
 * CHROME_EXECUTABLE_PATH.
 *
 *   npx tsx scripts/tests/hermetic/resume-render-smoke.ts
 */
import { writeFileSync, statSync } from "fs";
import type { ProfileWire } from "@/lib/schemas/profile";
import { selectBullets } from "@/lib/resumes/select";
import type { RewrittenBullet } from "@/lib/resumes/rewrite";
import { composeResumeProps } from "@/lib/resumes/templates/ats-plain";
import { renderResumePDF, shutdownPDFBrowser } from "@/lib/resumes/render-pdf";

const now = new Date().toISOString();

function mkBullet(id: string, text: string, tags: string[] = []) {
    return { id, text, tags, locked: false, excluded: false };
}

const profile: ProfileWire = {
    id: "p1",
    userId: "u1",
    headline: "Sal Salcedo — Software Engineer",
    summary: "Engineer focused on developer-facing systems and reliability.",
    location: "Brooklyn, NY",
    email: "salsalcedo4321@gmail.com",
    phone: null,
    links: [
        { label: "GitHub", url: "https://github.com/salsquared" },
        { label: "Portfolio", url: "https://example.com" },
    ],
    workRoles: [
        {
            id: "wr1",
            profileId: "p1",
            company: "Hubble Labs",
            title: "Software Engineer",
            location: "Remote",
            startDate: "2024-01-01T00:00:00.000Z",
            endDate: null,
            bullets: [
                mkBullet("b1", "Built a TypeScript service handling 50k req/day", ["typescript", "node"]),
                mkBullet("b2", "Cut p99 latency from 800ms to 120ms with caching layer", ["performance", "caching"]),
                mkBullet("b3", "Mentored two interns through their first production launch", ["leadership"]),
            ],
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
        {
            id: "wr2",
            profileId: "p1",
            company: "Older Co",
            title: "Intern",
            location: "NYC",
            startDate: "2022-05-01T00:00:00.000Z",
            endDate: "2022-08-01T00:00:00.000Z",
            bullets: [
                mkBullet("b4", "Built React dashboard for ops team", ["react"]),
            ],
            position: 1,
            createdAt: now,
            updatedAt: now,
        },
    ],
    projects: [
        {
            id: "pr1",
            profileId: "p1",
            name: "mission-control",
            description: "Personal job-search dashboard built in Next.js.",
            repoUrl: "https://github.com/salsquared/mission-control",
            liveUrl: null,
            bullets: [
                mkBullet("b5", "Designed a dash carousel architecture in Next.js + Zustand", ["nextjs", "zustand"]),
            ],
            metrics: null,
            githubRepo: null,
            portfolio: false,
            metricsUpdatedAt: null,
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
    ],
    education: [
        {
            id: "ed1",
            profileId: "p1",
            institution: "State University",
            degree: "B.S.",
            field: "Computer Science",
            startDate: "2018-09-01T00:00:00.000Z",
            endDate: "2022-05-01T00:00:00.000Z",
            bullets: [],
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
    ],
    createdAt: now,
    updatedAt: now,
};

async function main() {
    const keywords = ["typescript", "react", "nextjs", "performance"];
    const selection = selectBullets(profile, keywords);
    const flatSelections = [
        ...selection.workRoles.flatMap(e => e.bullets),
        ...selection.projects.flatMap(e => e.bullets),
        ...selection.education.flatMap(e => e.bullets),
    ];
    // Fake "rewrites" that just append a tag-emphasis suffix — no AI needed.
    const rewrites: RewrittenBullet[] = flatSelections.map(s => ({
        id: s.bulletId,
        rewrittenText: s.originalText,
        matchedKeywords: s.matchedKeywords,
    }));

    const props = composeResumeProps(profile, selection, rewrites);
    console.log(`Rendering resume — ${props.sections.workRoles.length} work roles, ${props.sections.projects.length} projects, ${props.sections.education.length} education.`);

    const t0 = Date.now();
    const pdf = await renderResumePDF(props);
    const elapsed = Date.now() - t0;

    const outPath = "/tmp/mc-resume-smoke.pdf";
    writeFileSync(outPath, pdf);
    const size = statSync(outPath).size;
    console.log(`[OK] wrote ${size} bytes to ${outPath} in ${elapsed}ms`);
    if (!pdf.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
        console.error("[FAIL] output is not a valid PDF (missing %PDF header)");
        process.exit(1);
    }
    console.log("[PASS] valid PDF header (%PDF...)");

    await shutdownPDFBrowser();
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
