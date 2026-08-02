/**
 * End-to-end smoke for /api/profile/import.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/profile-import-smoke.ts
 *
 * Forges a NextAuth session, generates a real PDF (via puppeteer-core) and
 * a real DOCX (via jszip) with deliberately overlapping resume content, POSTs
 * both as a single multipart upload, verifies the merge contract, then reverts
 * everything it changed.
 *
 * PREMISE REPAIR (2026-08-01). The suite used to assert `1 new work role,
 * 1 new project, 1 new education`. Those numbers were true against the sparse
 * profile the fixture was written for; against the owner's real profile the
 * import correctly MERGED instead (`workRolesMerged: 9, projectsMerged: 6,
 * educationMerged: 4, bulletsDeduped: 46`) and the project/education
 * assertions failed on every run.
 *
 * The counts are not the app misbehaving — they are the pipeline working. The
 * import feeds the EXISTING profile plus every uploaded file through
 * `synthesizeMasterResume` (one Flash call) before the deterministic merge, so
 * how many rows come out as "added" vs "merged" is a function of what the owner
 * already has AND of an LLM's consolidation judgement. No fixed number is
 * assertable, and pinning one to today's profile just re-arms the same failure
 * for whoever grows it next.
 *
 * So the assertions moved to what IS invariant, whatever the profile holds:
 *
 *   - RESPONSE ↔ DATABASE AGREEMENT. The entity diff computed from
 *     GET /api/profile before/after must equal the `counts` the route reported
 *     (`workRolesAdded` etc.), and the profile's total bullet count must grow
 *     by exactly `bulletsAdded`. A counter that disagrees with the writer is a
 *     bug at any profile size — and this catches the class the old assertions
 *     were reaching for without hardcoding the owner's row count.
 *   - IT MUST STILL DO SOMETHING (the anti-tautology guard). At least one of
 *     the four *Added counters must be non-zero: append-never-overwrite means a
 *     resume carrying content the profile lacks has to land SOMEWHERE, as a new
 *     entity or as bullets on a matched one. If import degrades to a no-op this
 *     fails, which is the whole point of keeping it.
 *   - DEDUP HAPPENED. The PDF and the DOCX share three identical bullets, so
 *     `bulletsDeduped >= 1` is structural.
 *   - MERGE COUNTS ARE BOUNDED by the number of entities that existed.
 *
 * Cleanup now REVERTS, not just deletes. Bullets merged into the owner's real
 * entities were previously left behind on every run — the fixture's content
 * accreting into a real profile permanently, which is part of how the profile
 * this suite tests against drifted in the first place. Cleanup re-reads the
 * profile, deletes entities that did not exist before, and PATCHes every
 * surviving entity's bullets back to the pre-import snapshot.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

/** Counted here, reported by `finish()` at the bottom — never `process.exit`ed inside `main()`. */
let fails = 0;
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
function pass(msg: string) { console.log(`[PASS] ${msg}`); }

// Per-run token for the fixture's distinctive strings. The fixture used to name
// its project the literal "mission-control", which matches the owner's real
// "Mission Control" project in dev.db: the importer MERGED into that row instead
// of adding one. A per-run token makes the fixture unable to collide with
// anything already in the profile — and makes "did this run's content land?"
// answerable by string search (logged, not asserted: whether the LLM keeps a
// bullet verbatim is not a contract).
const RUN_TAG = randomBytes(3).toString("hex");
const SMOKE_PROJECT_NAME = `smoke-project-${RUN_TAG}`;
const TAGGED_BULLET = `Instrumented smoke-run marker ${RUN_TAG} across the deployment pipeline`;

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
<li>${TAGGED_BULLET}</li>
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
    // The first three repeat the PDF verbatim — this overlap is what makes
    // `bulletsDeduped >= 1` a structural assertion rather than a hopeful one.
    "- Built TypeScript API endpoints in a Next.js app handling 10k requests per day",
    "- Optimized a slow Postgres ORM query from 800ms to 80ms",
    "- Added accessibility audits to CI to catch issues before launch",
    "- Pair-programmed a React component library used across three internal dashboards",
    "",
    "PROJECTS",
    `${SMOKE_PROJECT_NAME} (github.com/smoketester/${SMOKE_PROJECT_NAME})`,
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

// ─── Profile wire shapes (only the parts this suite reads/writes) ───────────

interface WireBullet { id: string; text: string }
interface WireEntity { id: string; bullets: WireBullet[] }
interface WireProfile {
    workRoles: WireEntity[];
    projects: WireEntity[];
    education: WireEntity[];
}

/** The three child collections, paired with the route that edits them. */
const CATEGORIES = [
    { key: "workRoles", path: "work-roles", label: "work role" },
    { key: "projects", path: "projects", label: "project" },
    { key: "education", path: "education", label: "education" },
] as const;
type CategoryKey = typeof CATEGORIES[number]["key"];

async function fetchProfile(cookie: string): Promise<WireProfile | null> {
    const res = await fetch(`${BASE}/api/profile`, { headers: { Cookie: cookie } });
    const json = await res.json();
    // Guard before destructuring: on a rejection (401 without an
    // Access-verified identity, say) `json.profile` is undefined and a
    // `.workRoles` read throws a bare TypeError that names neither the status
    // nor the call.
    if (res.status !== 200 || !json?.profile) {
        console.error(`[FAIL] GET /api/profile → HTTP ${res.status}`, json);
        return null;
    }
    return json.profile as WireProfile;
}

function bulletIds(e: WireEntity): string {
    return e.bullets.map(b => b.id).join(",");
}

function totalBullets(p: WireProfile): number {
    return CATEGORIES.reduce((sum, c) => sum + p[c.key].reduce((n, e) => n + e.bullets.length, 0), 0);
}

async function main() {
    // Pinned to the OWNER deliberately. The dev break-glass resolves every
    // request to the owner, so a fixture created as anyone else disagrees with
    // the identity the handlers will see. An unpinned findFirst() returns an
    // arbitrary row, and dev.db has held crew rows since 2026-08-01 — it still
    // happens to return the owner by insertion order, which is luck, not design.
    const user = await prisma.user.findFirst({ where: { role: "owner" } });
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

    /** Pre-import bullets per entity id, per category. Empty until snapshotted. */
    const snapshot = new Map<CategoryKey, Map<string, WireBullet[]>>();
    let snapshotOk = false;

    try {
        console.log("[setup] generating PDF...");
        const pdf = await generatePDF();
        console.log(`[setup] PDF ${pdf.length} bytes`);

        console.log("[setup] generating DOCX...");
        const docx = await generateDOCX(DOCX_PARAGRAPHS);
        console.log(`[setup] DOCX ${docx.length} bytes`);

        // Snapshot the profile before import — both the id set (what's new
        // afterwards) and every entity's bullets (what cleanup restores).
        const before = await fetchProfile(cookie);
        if (!before) { fails++; return; }
        for (const c of CATEGORIES) {
            snapshot.set(c.key, new Map(before[c.key].map(e => [e.id, e.bullets])));
        }
        snapshotOk = true;
        const beforeTotalBullets = totalBullets(before);
        console.log(
            `[setup] profile before: ${before.workRoles.length} work roles, ${before.projects.length} projects, ` +
            `${before.education.length} education, ${beforeTotalBullets} bullets`,
        );

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
            // 429 here is usually self-inflicted: the route allows 5 imports per
            // 10 minutes per user (lib/api/user-rate-limit.ts).
            throw new Error(`import failed: HTTP ${res.status} — ${body?.error ?? "(no error field)"} [stage=${body?.stage ?? "?"}]`);
        }
        console.log("Counts:", body.counts);
        console.log("Per file:");
        for (const f of body.perFile) console.log(`  ${f.filename}:`, f.counts);

        // ── Assertion 1: the response carries a complete counts block ────────
        const counts = body.counts as Record<string, unknown>;
        const REQUIRED_COUNTS = [
            "workRolesAdded", "workRolesMerged", "workRolesDroppedNoStartDate", "workRolesFoldedIntoProjects",
            "projectsAdded", "projectsMerged", "educationAdded", "educationMerged",
            "bulletsAdded", "bulletsDeduped", "headerFieldsFilled",
        ] as const;
        const missing = REQUIRED_COUNTS.filter(k => typeof counts?.[k] !== "number");
        if (missing.length > 0) {
            fail(`counts is missing / non-numeric fields: ${missing.join(", ")}`, counts);
            return; // every assertion below reads these
        }
        pass("response counts block is complete and numeric");
        const n = (k: typeof REQUIRED_COUNTS[number]) => counts[k] as number;

        // Reload the profile and diff it against the snapshot.
        const after = await fetchProfile(cookie);
        if (!after) { fails++; return; }

        const created: Record<CategoryKey, string[]> = { workRoles: [], projects: [], education: [] };
        for (const c of CATEGORIES) {
            const beforeIds = snapshot.get(c.key)!;
            created[c.key] = after[c.key].filter(e => !beforeIds.has(e.id)).map(e => e.id);
            console.log(`[verify] new ${c.label}s: ${created[c.key].length}`);
        }

        // ── Assertion 2: the reported counts match what actually landed ──────
        // True at any profile size, and the reason the old `=== 1` assertions
        // existed: a merge that reports adds it didn't perform (or performs
        // adds it doesn't report) is a bug regardless of how full the profile is.
        const addedPairs: [CategoryKey, number, string][] = [
            ["workRoles", n("workRolesAdded"), "workRolesAdded"],
            ["projects", n("projectsAdded"), "projectsAdded"],
            ["education", n("educationAdded"), "educationAdded"],
        ];
        for (const [key, reported, label] of addedPairs) {
            if (created[key].length !== reported) {
                fail(`${label}=${reported} but ${created[key].length} new ${key} rows appeared in the profile`);
            } else {
                pass(`${label}=${reported} agrees with the profile diff`);
            }
        }

        const afterTotalBullets = totalBullets(after);
        const bulletDelta = afterTotalBullets - beforeTotalBullets;
        if (bulletDelta !== n("bulletsAdded")) {
            fail(`bulletsAdded=${n("bulletsAdded")} but the profile's bullet count moved by ${bulletDelta} (${beforeTotalBullets} → ${afterTotalBullets})`);
        } else {
            pass(`bulletsAdded=${n("bulletsAdded")} agrees with the profile's bullet count delta`);
        }

        // ── Assertion 3: the import must actually import something ───────────
        // The anti-tautology guard. Append-never-overwrite means a resume
        // carrying content the profile lacks has to land somewhere — as a new
        // entity, or as bullets on a matched one. Zero across all four means
        // the pipeline stopped importing.
        const addedTotal = n("workRolesAdded") + n("projectsAdded") + n("educationAdded") + n("bulletsAdded");
        if (addedTotal < 1) {
            fail(
                "import added nothing at all — no new work role / project / education row and no new bullet. " +
                "The fixture carries content no real profile has (Hubble Labs internship, " +
                `${SMOKE_PROJECT_NAME}), so a zero here means extraction, synthesis or merge stopped importing.`,
                counts,
            );
        } else {
            pass(`import added ${addedTotal} thing(s) (${n("workRolesAdded")} roles, ${n("projectsAdded")} projects, ${n("educationAdded")} education, ${n("bulletsAdded")} bullets)`);
        }

        // ── Assertion 4: the PDF/DOCX overlap deduped ────────────────────────
        // The two fixtures repeat three bullets verbatim; `mergeBullets` keys on
        // normalized text, so at least those must collapse.
        if (n("bulletsDeduped") < 1) {
            fail(`bulletsDeduped=${n("bulletsDeduped")} — the PDF and DOCX share three identical bullets, so dedup must fire`);
        } else {
            pass(`bulletsDeduped=${n("bulletsDeduped")}`);
        }

        // ── Assertion 5: merges are bounded by what existed ──────────────────
        // A "merged" is a match against a pre-existing entity, so it can never
        // exceed the number of pre-existing entities. Catches double-counting
        // without pinning the count itself.
        const mergedPairs: [CategoryKey, number, string][] = [
            ["workRoles", n("workRolesMerged"), "workRolesMerged"],
            ["projects", n("projectsMerged"), "projectsMerged"],
            ["education", n("educationMerged"), "educationMerged"],
        ];
        for (const [key, merged, label] of mergedPairs) {
            const existed = snapshot.get(key)!.size;
            if (merged > existed) fail(`${label}=${merged} exceeds the ${existed} pre-existing ${key} rows`);
            else pass(`${label}=${merged} ≤ ${existed} pre-existing ${key} rows`);
        }

        // ── Observation (not an assertion): where the fixture's content went ──
        // Whether an LLM synthesis pass keeps a given bullet verbatim, folds a
        // role into a project, or drops a one-line education entry is judgement,
        // not contract — so this is logged for the reader and never failed on.
        const allBullets = CATEGORIES.flatMap(c => after[c.key].flatMap(e => e.bullets.map(b => b.text)));
        console.log(`[NOTE] run-tagged bullet present in profile: ${allBullets.some(t => t.includes(RUN_TAG))}`);
        console.log(`[NOTE] "${SMOKE_PROJECT_NAME}" present as a project: ${created.projects.length > 0}`);

        // NO `process.exit()` HERE — the verdict is `finish()`'s job. This used
        // to be `process.exit(1)` on a failed expectation, INSIDE the try:
        // `process.exit` does not run pending `finally` blocks, so the cleanup
        // below never executed and every failing run leaked its scratch work
        // role / project / education rows into the profile (one orphaned
        // "Hubble Labs" role was found in dev.db on 2026-07-29).
    } finally {
        // REVERT, don't just delete. Re-reads the profile rather than trusting
        // the ids computed above, so a run that died mid-assertion — or a route
        // that half-applied its writes before throwing — is still cleaned up.
        if (!snapshotOk) {
            console.warn("[cleanup] no pre-import snapshot — nothing can be safely reverted, skipping");
        } else {
            const current = await fetchProfile(cookie);
            if (!current) {
                console.error("[cleanup] COULD NOT RE-READ THE PROFILE — fixture entities may still be in it. Check by hand.");
            } else {
                for (const c of CATEGORIES) {
                    const beforeBullets = snapshot.get(c.key)!;
                    for (const entity of current[c.key]) {
                        const original = beforeBullets.get(entity.id);
                        if (!original) {
                            // Created by this run — remove it outright.
                            const r = await fetch(`${BASE}/api/profile/${c.path}?id=${entity.id}`, {
                                method: "DELETE", headers: { Cookie: cookie },
                            }).catch(() => null);
                            if (!r || r.status !== 200) {
                                console.error(`[cleanup] failed to delete ${c.label} ${entity.id} (HTTP ${r?.status ?? "network error"}) — delete it by hand`);
                            }
                            continue;
                        }
                        if (bulletIds(entity) === original.map(b => b.id).join(",")) continue; // untouched
                        // Bullets were merged into one of the owner's REAL
                        // entities. Put the column back exactly as it was.
                        //
                        // Written through Prisma, not the PATCH route, for two
                        // reasons: the route calls markCanonsStaleForEntity, so
                        // reverting through it would flag the owner's canons
                        // stale for a change that nets to zero; and a direct
                        // write still works when the dev server is the thing
                        // that died mid-run. The value is the array the API
                        // just handed us — already normalized by parseBullets /
                        // hydrateBulletDefaults — so this is the same JSON
                        // serializeBullets would produce.
                        const json = JSON.stringify(original);
                        const restored = await (
                            c.key === "workRoles" ? prisma.workRole.update({ where: { id: entity.id }, data: { bullets: json } })
                            : c.key === "projects" ? prisma.project.update({ where: { id: entity.id }, data: { bullets: json } })
                            : prisma.education.update({ where: { id: entity.id }, data: { bullets: json } })
                        ).then(() => true, () => false);
                        if (!restored) {
                            console.error(`[cleanup] failed to restore bullets on ${c.label} ${entity.id} — fixture bullets are still on it`);
                        } else {
                            console.log(`[cleanup] reverted ${entity.bullets.length - original.length} merged bullet(s) on ${c.label} ${entity.id}`);
                        }
                    }
                }
            }
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log("[cleanup] done");
    }
}

/**
 * THE EXIT PATH LIVES OUT HERE — DO NOT MOVE IT BACK INTO `main()`.
 *
 * Two bugs met at the old in-try `process.exit(1)`: it skipped the `finally`
 * cleanup (leaking fixture rows into the owner's profile on every failing run),
 * and any `return` inside the try would have skipped a check placed after the
 * try/finally. Running the verdict from `.then()` fixes both — cleanup always
 * runs, and no early exit can dodge the exit code. Same fix as 0a235be.
 */
function finish(): never {
    if (fails > 0) {
        console.error(`\n[FAIL] ${fails} expectation(s) failed`);
        process.exit(1);
    }
    console.log("\n[PASS] all expectations met");
    process.exit(0);
}

main().then(finish, e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
