/**
 * End-to-end smoke for /api/profile/import.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/profile-import-smoke.ts
 *
 * Forges a NextAuth session, generates a real PDF (via puppeteer-core) and
 * a real DOCX (via jszip) with deliberately overlapping resume content, POSTs
 * both as a single multipart upload, verifies dedup counts, sanity-checks the
 * resulting profile, then deletes the entities it created.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

const RESUME_HTML_PDF = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font-family: Helvetica, sans-serif; padding: 40px; color: #111; font-size: 11pt; }
h1 { font-size: 18pt; margin: 0; }
h2 { font-size: 12pt; margin: 16px 0 4px; text-transform: uppercase; border-bottom: 1px solid #999; }
.role { font-weight: 700; }
ul { margin: 4px 0 8px 18px; }
</style></head><body>
<h1>Smoke McTester</h1>
<div>smoke.mctester@example.com · Brooklyn, NY · github.com/smoketester</div>
<h2>Experience</h2>
<div class="role">Software Engineer Intern · Hubble Labs · May 2024 – Aug 2024</div>
<ul>
<li>Built TypeScript API endpoints in a Next.js app handling 10k requests per day</li>
<li>Optimized a slow Postgres ORM query from 800ms to 80ms</li>
<li>Added accessibility audits to CI to catch issues before launch</li>
</ul>
<h2>Education</h2>
<div class="role">State University · B.S. Computer Science · Aug 2018 – May 2022</div>
</body></html>`;

const DOCX_PARAGRAPHS = [
    "Smoke McTester",
    "smoke.mctester@example.com  |  Brooklyn, NY  |  github.com/smoketester",
    "",
    "EXPERIENCE",
    "Software Engineer Intern, Hubble Labs (May 2024 – August 2024)",
    "- Built TypeScript API endpoints in a Next.js app handling 10k requests per day",
    "- Optimized a slow Postgres ORM query from 800ms to 80ms",
    "- Added accessibility audits to CI to catch issues before launch",
    "- Pair-programmed a React component library used across three internal dashboards",
    "",
    "PROJECTS",
    "mission-control (github.com/smoketester/mission-control)",
    "- Personal Next.js dashboard for tracking job applications",
    "- Built dash carousel architecture in TypeScript + Zustand",
];

async function generatePDF(): Promise<Buffer> {
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
        args: ["--no-sandbox"],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(RESUME_HTML_PDF, { waitUntil: "domcontentloaded" });
        const pdf = await page.pdf({ format: "Letter", printBackground: false, margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" } });
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
}

async function generateDOCX(paragraphs: string[]): Promise<Buffer> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();

    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const body = paragraphs
        .map(p => `<w:p><w:r><w:t xml:space="preserve">${escape(p)}</w:t></w:r></w:p>`)
        .join("");

    const documentXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body>${body}</w:body></w:document>`;

    const contentTypesXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`;

    const rootRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`;

    zip.file("[Content_Types].xml", contentTypesXml);
    zip.file("_rels/.rels", rootRels);
    zip.file("word/document.xml", documentXml);

    return await zip.generateAsync({ type: "nodebuffer" });
}

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

    let createdWorkRoleIds: string[] = [];
    let createdProjectIds: string[] = [];
    let createdEducationIds: string[] = [];

    try {
        console.log("[setup] generating PDF...");
        const pdf = await generatePDF();
        console.log(`[setup] PDF ${pdf.length} bytes`);

        console.log("[setup] generating DOCX...");
        const docx = await generateDOCX(DOCX_PARAGRAPHS);
        console.log(`[setup] DOCX ${docx.length} bytes`);

        // Snapshot profile before import so we can diff
        const beforeRes = await fetch(`${BASE}/api/profile`, { headers: { Cookie: cookie } });
        const beforeJson = await beforeRes.json();
        const beforeWorkRoleIds = new Set<string>(beforeJson.profile.workRoles.map((w: { id: string }) => w.id));
        const beforeProjectIds = new Set<string>(beforeJson.profile.projects.map((p: { id: string }) => p.id));
        const beforeEducationIds = new Set<string>(beforeJson.profile.education.map((e: { id: string }) => e.id));

        // Upload both files
        const fd = new FormData();
        fd.append("files", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "smoke-resume.pdf");
        fd.append("files", new Blob([new Uint8Array(docx)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "smoke-resume.docx");

        const t0 = Date.now();
        const res = await fetch(`${BASE}/api/profile/import`, { method: "POST", headers: { Cookie: cookie }, body: fd });
        const elapsed = Date.now() - t0;
        const body = await res.json();
        console.log(`POST /api/profile/import → HTTP ${res.status} in ${elapsed}ms`);
        if (res.status !== 200) {
            console.error("Response:", body);
            throw new Error(`import failed: ${body.error}`);
        }
        console.log("Counts:", body.counts);
        console.log("Per file:");
        for (const f of body.perFile) console.log(`  ${f.filename}:`, f.counts);

        // Reload profile, identify what was created
        const afterRes = await fetch(`${BASE}/api/profile`, { headers: { Cookie: cookie } });
        const afterJson = await afterRes.json();

        createdWorkRoleIds = afterJson.profile.workRoles.filter((w: { id: string }) => !beforeWorkRoleIds.has(w.id)).map((w: { id: string }) => w.id);
        createdProjectIds = afterJson.profile.projects.filter((p: { id: string }) => !beforeProjectIds.has(p.id)).map((p: { id: string }) => p.id);
        createdEducationIds = afterJson.profile.education.filter((e: { id: string }) => !beforeEducationIds.has(e.id)).map((e: { id: string }) => e.id);

        console.log(`[verify] new work roles: ${createdWorkRoleIds.length}`);
        console.log(`[verify] new projects:   ${createdProjectIds.length}`);
        console.log(`[verify] new education:  ${createdEducationIds.length}`);

        // Expectations:
        //   - One Hubble Labs work role created (from PDF), merged with DOCX's overlapping role (dedup'd 3 bullets, added 1).
        //   - One project created (from DOCX only).
        //   - One education entry created (from PDF only).
        let fails = 0;
        if (createdWorkRoleIds.length !== 1) { console.error(`[FAIL] expected 1 new work role, got ${createdWorkRoleIds.length}`); fails++; }
        if (createdProjectIds.length !== 1) { console.error(`[FAIL] expected 1 new project, got ${createdProjectIds.length}`); fails++; }
        if (createdEducationIds.length !== 1) { console.error(`[FAIL] expected 1 new education, got ${createdEducationIds.length}`); fails++; }
        if (body.counts.bulletsDeduped < 1) { console.error(`[FAIL] expected bulletsDeduped >= 1 (overlap between PDF and DOCX), got ${body.counts.bulletsDeduped}`); fails++; }

        const hubble = afterJson.profile.workRoles.find((w: { id: string }) => createdWorkRoleIds.includes(w.id));
        if (hubble) {
            console.log(`[verify] Hubble Labs role bullets: ${hubble.bullets.length}`);
            if (hubble.bullets.length < 4) { console.error(`[FAIL] expected >= 4 bullets on merged Hubble Labs role, got ${hubble.bullets.length}`); fails++; }
        }

        if (fails === 0) {
            console.log("[PASS] all expectations met");
        } else {
            console.error(`[FAIL] ${fails} expectations failed`);
            process.exit(1);
        }
    } finally {
        // Cleanup: delete entities we created.
        for (const id of createdWorkRoleIds) {
            await fetch(`${BASE}/api/profile/work-roles?id=${id}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        }
        for (const id of createdProjectIds) {
            await fetch(`${BASE}/api/profile/projects?id=${id}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        }
        for (const id of createdEducationIds) {
            await fetch(`${BASE}/api/profile/education?id=${id}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log("[cleanup] done");
    }
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
