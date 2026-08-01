/**
 * Hermetic smoke for `scripts/manage-crew.ts` — the crew provisioning CLI
 * (docs/multi-user-crew.html P5.4.1).
 *
 *   npx tsx scripts/tests/hermetic/manage-crew-smoke.ts
 *
 * This script is the ONLY production `user.create` path in the codebase and the
 * only thing that deletes a person's entire job-search history, so the two
 * properties worth locking down are the two that are silent when wrong:
 * the email must be stored in the shape `lib/viewer.ts` looks up, and a
 * removal must take the files with it.
 *
 * Asserts:
 *   1. normalizeEmail is byte-identical to lib/viewer.ts's `.trim().toLowerCase()`
 *      (asserted against the viewer's own source, not from memory), and `add`
 *      stores the normalized form.
 *   2. `add` refuses a duplicate — including one that differs only in case /
 *      whitespace, which is the shape a second provisioning attempt actually
 *      takes.
 *   3. `add` CANNOT produce a second owner. Four independent ways:
 *        (a) the created row is 'crew' and the owner count is unchanged;
 *        (b) `--role=owner` is a REJECTED flag (exit 2), not an ignored one;
 *        (c) no `role: "owner"` write literal exists anywhere in the script;
 *        (d) teeth — if `user.create` ever returned a non-crew row, `add`
 *            deletes it and fails instead of leaving a silent escalation.
 *   4. `remove` refuses role='owner' outright and leaves the row intact.
 *   5. `remove` (dry run) reports every resume file it would sweep — stored
 *      artifactPath AND orphan `<id>.<ext>` files with no artifactPath — and
 *      deletes nothing.
 *   6. `remove --confirm-delete` cascades the DB rows and unlinks exactly that
 *      user's files, leaving another user's files alone.
 *   7. `list` shows both roles with ids and counts, and flags a broken
 *      exactly-one-owner invariant.
 *   8. Target safety: no target → exit 2; a nonexistent DB file → exit 2 (never
 *      a fresh empty DB); `remove --confirm-delete` refuses an inherited
 *      DATABASE_URL; the `file:./prisma/dev.db` phantom-DB footgun is flagged.
 *   9. The relation manifest has not drifted from prisma/schema.prisma — a
 *      19th `user User @relation` would make `remove` understate the loss.
 *
 * Genuinely hermetic: no network, no PM2, no dev.db / prod.db. Every DB is a
 * THROWAWAY SQLite file in /tmp opened by explicit `datasourceUrl`, and every
 * resume file lives in a throwaway /tmp directory (the CLI's resume dirs are
 * injectable precisely so this smoke never touches the real data/resumes/).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    addCrew,
    collectResumeArtifacts,
    listUsers,
    normalizeEmail,
    openDb,
    removeUser,
    __RELATION_LABELS,
    __databaseUrlToPath,
    __main,
    __resolveTarget,
    type Db,
    type Ops,
} from "@/scripts/manage-crew";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DIR = `/tmp/manage-crew-smoke-${STAMP}`;
const TMP_DB = join(TMP_DIR, "test.db");
const RESUMES_DIR = join(TMP_DIR, "resumes");
const UPLOADS_DIR = join(TMP_DIR, "resume-uploads");

const OWNER_ID = "owner-manage-crew-smoke";
const OWNER_EMAIL = "owner@manage-crew-smoke.invalid";
const CREW_RAW = "  Crew.One@Manage-Crew-Smoke.INVALID  ";
const CREW_EMAIL = "crew.one@manage-crew-smoke.invalid";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
function check(cond: boolean, msg: string, detail?: unknown) {
    if (cond) pass(msg);
    else fail(msg, detail);
}

// ---------------------------------------------------------------------------
// Fixture DDL. Hand-maintained — it does NOT track prisma/schema.prisma, so a
// new NOT NULL column on any of these tables breaks create() here with P2022
// until it is mirrored. `User.role` in particular MUST carry its
// `NOT NULL DEFAULT 'crew'` or every user.create() below fails.
//
// Only the five tables this smoke exercises are created. The other thirteen
// relations are deliberately ABSENT, which doubles as coverage for the
// schema-behind tier CLAUDE.md documents: those counts must degrade to
// "(table absent)" rather than killing the command.
// ---------------------------------------------------------------------------
const DDL = [
    `CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT,
        "email" TEXT,
        "emailVerified" DATETIME,
        "image" TEXT,
        "lastSyncedHistoryId" TEXT,
        "role" TEXT NOT NULL DEFAULT 'crew'
    )`,
    `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
    `CREATE TABLE "Task" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "priority" TEXT,
        "project" TEXT,
        "dueDate" DATETIME,
        "position" INTEGER NOT NULL DEFAULT 0,
        "notes" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        "parentId" TEXT,
        CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE TABLE "Profile" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "headline" TEXT,
        "tagline" TEXT,
        "location" TEXT,
        "email" TEXT,
        "phone" TEXT,
        "links" TEXT,
        "skills" TEXT,
        "hobbies" TEXT,
        "languages" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId")`,
    `CREATE TABLE "GeneratedResume" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "applicationId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "postingInput" TEXT NOT NULL,
        "postingTitle" TEXT,
        "postingCompany" TEXT,
        "tagline" TEXT,
        "profileSnapshot" TEXT NOT NULL,
        "selections" TEXT NOT NULL,
        "skillsGap" TEXT,
        "templateKey" TEXT NOT NULL DEFAULT 'ats-plain',
        "format" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "artifactPath" TEXT,
        "error" TEXT,
        "canonId" TEXT,
        "isCanonical" BOOLEAN NOT NULL DEFAULT false,
        "canonVersion" INTEGER,
        CONSTRAINT "GeneratedResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE TABLE "ResumeUpload" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "filename" TEXT NOT NULL,
        "mimeType" TEXT NOT NULL,
        "sizeBytes" INTEGER NOT NULL,
        "rawText" TEXT NOT NULL,
        "parsedJson" TEXT NOT NULL,
        "artifactPath" TEXT,
        "importBatchId" TEXT,
        "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ResumeUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
];

/** Capture what a command PRINTS — "reports the files it would sweep" is an
 *  operator-facing property, so it is asserted on the output, not only on the
 *  returned object. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
    const lines: string[] = [];
    const sink = (...args: unknown[]) => { lines.push(args.map((a) => String(a)).join(" ")); };
    const real = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    console.log = sink; console.info = sink; console.warn = sink; console.error = sink;
    try {
        const value = await fn();
        return { value, out: lines.join("\n") };
    } finally {
        console.log = real.log; console.info = real.info; console.warn = real.warn; console.error = real.error;
    }
}

function touch(path: string, bytes = 64): void {
    writeFileSync(path, "x".repeat(bytes));
}

async function seedGeneratedResume(
    db: Db,
    userId: string,
    id: string,
    artifactPath: string | null,
): Promise<void> {
    await db.generatedResume.create({
        data: {
            id,
            userId,
            postingInput: "{}",
            profileSnapshot: "{}",
            selections: "[]",
            format: artifactPath?.endsWith("docx") ? "docx" : "pdf",
            status: "ready",
            artifactPath,
        },
    });
}

async function main(): Promise<void> {
    mkdirSync(RESUMES_DIR, { recursive: true });
    mkdirSync(UPLOADS_DIR, { recursive: true });

    const db = await openDb(TMP_DB);
    const ops: Ops = { db, resumesDir: RESUMES_DIR, uploadsDir: UPLOADS_DIR };
    const savedDatabaseUrl = process.env.DATABASE_URL;

    try {
        for (const ddl of DDL) await db.$executeRawUnsafe(ddl);

        // ── 0. Manifest drift guard ─────────────────────────────────────────
        // `remove`'s blast-radius manifest enumerates the User back-relations
        // by hand. A relation added to the schema and missed there makes the
        // manifest understate what a removal destroys, silently.
        {
            const schema = readFileSync(join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
            const relations = schema.match(/^\s*user\s+User\s+@relation/gm)?.length ?? 0;
            check(
                relations === __RELATION_LABELS.length,
                `manifest covers every User back-relation (schema: ${relations}, manifest: ${__RELATION_LABELS.length})`,
                { relations, labels: __RELATION_LABELS },
            );
            const nonCascade = schema
                .match(/^\s*user\s+User\s+@relation\([^)]*\)/gm)
                ?.filter((line) => !line.includes("onDelete: Cascade")) ?? [];
            check(
                nonCascade.length === 0,
                "every User back-relation is onDelete: Cascade (the DB side really is one statement)",
                nonCascade,
            );
        }

        // ── 1. Email normalization matches lib/viewer.ts ─────────────────────
        {
            const viewerSrc = readFileSync(join(REPO_ROOT, "lib", "viewer.ts"), "utf8");
            check(
                /rawEmail\?\.trim\(\)\.toLowerCase\(\)/.test(viewerSrc),
                "lib/viewer.ts still normalizes with .trim().toLowerCase() (the shape rows must be stored in)",
            );
            check(normalizeEmail(CREW_RAW) === CREW_EMAIL, "normalizeEmail: trims + lowercases");
            check(normalizeEmail("   ") === null, "normalizeEmail: blank → null");
            check(normalizeEmail("not-an-email") === null, "normalizeEmail: missing @ → null");
            check(normalizeEmail("a@b") === null, "normalizeEmail: no domain dot → null");
        }

        // ── 2. Seed the owner, then `add` the crew member ────────────────────
        await db.user.create({ data: { id: OWNER_ID, email: OWNER_EMAIL, role: "owner" } });

        {
            const { value: res, out } = await capture(() => addCrew(CREW_RAW, ops));
            check(res.ok && res.exitCode === 0 && res.outcome === "created", "add: creates a row", res);
            check(res.role === "crew", "add: the created row is role='crew'", res.role);

            const row = await db.user.findUnique({ where: { email: CREW_EMAIL }, select: { id: true, role: true } });
            check(row !== null, "add: the row is stored under the NORMALIZED email (viewer lookup would hit)", CREW_EMAIL);
            check(row?.role === "crew", "add: role in the DB is crew", row?.role);
            check(
                await db.user.count({ where: { role: "owner" } }) === 1,
                "add: owner count is still exactly 1 (OQ4a invariant intact)",
            );
            check(/what is stored/.test(out), "add: prints the P5.4.2 disclosure reminder (§3.2)", out.slice(0, 200));
        }

        // ── 2b. Duplicates are refused, including case/whitespace variants ───
        {
            const { value: dup } = await capture(() => addCrew(CREW_EMAIL, ops));
            check(!dup.ok && dup.exitCode === 1 && dup.outcome === "duplicate", "add: refuses an exact duplicate", dup);

            const { value: dupCase } = await capture(() => addCrew("  CREW.ONE@Manage-Crew-Smoke.invalid ", ops));
            check(
                !dupCase.ok && dupCase.outcome === "duplicate",
                "add: refuses a duplicate that differs only in case/whitespace",
                dupCase,
            );
            check(await db.user.count() === 2, "add: still exactly 2 users after two refused duplicates");

            const { value: bad } = await capture(() => addCrew("nope", ops));
            check(!bad.ok && bad.exitCode === 2 && bad.outcome === "invalid-email", "add: rejects a malformed email", bad);
        }

        // ── 3. `add` can never mint a second owner ───────────────────────────
        {
            // (b) an unknown flag is REJECTED, not ignored.
            const { value: code, out } = await capture(() =>
                __main(["add", "sneaky@manage-crew-smoke.invalid", `--db=${TMP_DB}`, "--role=owner"]),
            );
            check(code === 2, "add: --role=owner is a rejected flag (exit 2)", code);
            check(/unknown flag --role/.test(out), "add: the rejection names the offending flag", out.slice(0, 200));
            check(
                await db.user.findUnique({ where: { email: "sneaky@manage-crew-smoke.invalid" } }) === null,
                "add: the rejected --role=owner run created no row at all",
            );

            // (c) no write-shaped owner literal anywhere in the provisioning
            //     code. Two complementary passes: every `role:` inside a Prisma
            //     `data:` payload must be 'crew', and every `owner` literal must
            //     be a `where:` READ filter rather than something being written.
            //
            //     SCANS BOTH FILES since the P7 extraction. The logic moved to
            //     `lib/crew/core.ts` (so the CLI and the owner-only crew UI
            //     cannot drift on these invariants) and the CLI became a shell.
            //     A single-file scan would now find zero `data:` payloads and,
            //     because the assertion demands `length > 0`, fail loudly rather
            //     than silently pass on an empty set — which is how this was
            //     caught. Keep BOTH paths listed: dropping either one re-opens
            //     an unscanned account-creation surface.
            const SCANNED = [
                join(REPO_ROOT, "scripts", "manage-crew.ts"),
                join(REPO_ROOT, "lib", "crew", "core.ts"),
            ];
            //     COMMENTS ARE STRIPPED FIRST. This assertion is about what the
            //     code WRITES, but it is a text scan, so prose describing the
            //     rule ("`remove` refuses role: 'owner'") reads identically to
            //     code breaking it. That brittleness was always here — any
            //     comment in manage-crew.ts mentioning the literal would have
            //     tripped it — and it fired the moment core.ts documented its
            //     own invariants. Stripping block comments and whole-line `//`
            //     comments makes the check mean what its name says. Deliberately
            //     NOT stripping trailing `//` on a code line: that would risk
            //     eating real code after a `://`, and a trailing comment is a
            //     poor hiding place for a privilege escalation anyway.
            const stripComments = (s: string) =>
                s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
            const src = SCANNED.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
            const writes = src.match(/data:\s*\{[^}]*\brole:\s*["']\w+["']/g) ?? [];
            check(
                writes.length > 0 && writes.every((m) => /role:\s*["']crew["']/.test(m)),
                "add: every `role:` written in a Prisma data payload is 'crew' (both CLI and core)",
                writes,
            );
            const ownerLiterals = src.match(/\brole:\s*["']owner["']/g) ?? [];
            const ownerReadFilters = src.match(/where:\s*\{\s*role:\s*["']owner["']\s*\}/g) ?? [];
            check(
                ownerLiterals.length === ownerReadFilters.length,
                "add: every `role: \"owner\"` in the provisioning code is a where-clause read, never a write",
                { ownerLiterals, ownerReadFilters },
            );

            // (d) teeth — if create() ever handed back a non-crew row, the
            //     script must undo it rather than leave an escalation.
            const trapEmail = "trap@manage-crew-smoke.invalid";
            const trapDb = {
                user: {
                    findUnique: (args: unknown) => (db.user.findUnique as (a: unknown) => unknown)(args),
                    count: (args: unknown) => (db.user.count as (a: unknown) => unknown)(args),
                    create: async (args: unknown) => {
                        const row = await (db.user.create as (a: unknown) => Promise<Record<string, unknown>>)(args);
                        return { ...row, role: "owner" }; // simulate a default flip / engine drift
                    },
                    delete: (args: unknown) => (db.user.delete as (a: unknown) => unknown)(args),
                },
            } as unknown as Db;
            const { value: trap } = await capture(() => addCrew(trapEmail, { ...ops, db: trapDb }));
            check(
                !trap.ok && trap.exitCode === 1 && trap.outcome === "refused-owner",
                "add: a non-crew row coming back from create() is refused",
                trap,
            );
            check(
                await db.user.findUnique({ where: { email: trapEmail } }) === null,
                "add: the refused row was rolled back out of the DB",
            );
            check(await db.user.count({ where: { role: "owner" } }) === 1, "add: owner count STILL exactly 1");
        }

        // ── 4. `remove` refuses the owner ────────────────────────────────────
        {
            const { value: res, out } = await capture(() => removeUser(OWNER_EMAIL, ops, { confirm: true }));
            check(
                !res.ok && res.exitCode === 1 && res.outcome === "refused-owner",
                "remove: refuses role='owner' even with --confirm-delete",
                res,
            );
            check(/REFUSING/.test(out), "remove: the owner refusal is loud", out.slice(0, 160));
            check(
                await db.user.findUnique({ where: { id: OWNER_ID } }) !== null,
                "remove: the owner row survived the refusal",
            );

            const { value: missing } = await capture(() => removeUser("ghost@manage-crew-smoke.invalid", ops, { confirm: true }));
            check(!missing.ok && missing.exitCode === 1 && missing.outcome === "not-found", "remove: unknown email → exit 1", missing);
        }

        // ── 5. Seed the crew member's footprint, then dry-run the removal ────
        const crew = await db.user.findUniqueOrThrow({ where: { email: CREW_EMAIL }, select: { id: true } });

        const GEN_WITH_PATH = "gen-with-path-manage-crew";
        const GEN_ORPHAN = "gen-orphan-manage-crew";
        const UPLOAD_ID = "upload-manage-crew";
        const OWNER_GEN = "gen-owner-manage-crew";
        {
            await db.task.create({ data: { userId: crew.id, text: "follow up", status: "TODO", updatedAt: new Date() } });
            await db.profile.create({ data: { userId: crew.id, phone: "+1 555 0100", location: "1 Home St", updatedAt: new Date() } });

            // (i) the normal case: a stored artifactPath with a file behind it.
            await seedGeneratedResume(db, crew.id, GEN_WITH_PATH, `${GEN_WITH_PATH}.pdf`);
            touch(join(RESUMES_DIR, `${GEN_WITH_PATH}.pdf`));
            // (ii) row/file divergence: the bytes landed, the column update did
            //      not. lib/resumes/storage.ts explicitly accepts this state.
            await seedGeneratedResume(db, crew.id, GEN_ORPHAN, null);
            touch(join(RESUMES_DIR, `${GEN_ORPHAN}.docx`));
            // (iii) an uploaded resume archive — a DIFFERENT store, with the
            //      directory prefix baked into the column.
            await db.resumeUpload.create({
                data: {
                    id: UPLOAD_ID,
                    userId: crew.id,
                    filename: "resume.pdf",
                    mimeType: "application/pdf",
                    sizeBytes: 64,
                    rawText: "…",
                    parsedJson: "{}",
                    artifactPath: `data/resume-uploads/${UPLOAD_ID}.pdf`,
                },
            });
            touch(join(UPLOADS_DIR, `${UPLOAD_ID}.pdf`));
            // (iv) the OWNER's file — must survive the crew removal untouched.
            await seedGeneratedResume(db, OWNER_ID, OWNER_GEN, `${OWNER_GEN}.pdf`);
            touch(join(RESUMES_DIR, `${OWNER_GEN}.pdf`));

            const found = await collectResumeArtifacts(crew.id, ops);
            const rel = found.map((a) => a.relPath).sort();
            check(
                rel.length === 3
                && rel.includes(`data/resumes/${GEN_WITH_PATH}.pdf`)
                && rel.includes(`data/resumes/${GEN_ORPHAN}.docx`)
                && rel.includes(`data/resume-uploads/${UPLOAD_ID}.pdf`),
                "collect: finds the stored artifact, the orphan, and the upload archive — and no one else's",
                rel,
            );
            check(
                found.find((a) => a.rowId === GEN_ORPHAN)?.orphan === true,
                "collect: the artifactPath-less file is flagged as an orphan",
            );

            const { value: dry, out } = await capture(() => removeUser(CREW_EMAIL, ops, { confirm: false }));
            check(dry.ok && dry.exitCode === 0 && dry.outcome === "dry-run", "remove: dry run is the default and succeeds", dry);
            check(dry.artifacts?.length === 3, "remove (dry): the result carries all three file ids", dry.artifacts);
            check(
                out.includes(`data/resumes/${GEN_WITH_PATH}.pdf`)
                && out.includes(`data/resumes/${GEN_ORPHAN}.docx`)
                && out.includes(`data/resume-uploads/${UPLOAD_ID}.pdf`),
                "remove (dry): PRINTS every file it would sweep",
            );
            check(/DRY RUN/.test(out) && /--confirm-delete/.test(out), "remove (dry): says nothing was deleted and how to proceed");
            check(
                (dry.footprint?.counts.some((c) => c.label === "tasks" && c.count === 1)
                    && dry.footprint.counts.some((c) => c.label === "generatedResumes" && c.count === 2)) === true,
                "remove (dry): the manifest counts the rows the cascade will destroy",
                dry.footprint?.counts,
            );
            check(
                dry.footprint?.counts.some((c) => c.label === "watchlists" && c.count === "missing") === true,
                "remove (dry): an absent table degrades to '(table absent)' instead of failing the command",
            );
            check(
                existsSync(join(RESUMES_DIR, `${GEN_WITH_PATH}.pdf`)) && await db.user.count() === 2,
                "remove (dry): NOTHING was deleted — rows and files both intact",
            );
        }

        // ── 6. Confirmed removal: DB cascade + filesystem sweep ──────────────
        {
            const { value: res } = await capture(() => removeUser(CREW_EMAIL, ops, { confirm: true }));
            check(res.ok && res.exitCode === 0 && res.outcome === "deleted", "remove --confirm-delete: succeeds", res);
            check(res.swept?.deleted.length === 3 && res.swept.failed.length === 0, "remove: swept all three files", res.swept);

            check(await db.user.findUnique({ where: { email: CREW_EMAIL } }) === null, "remove: the User row is gone");
            check(await db.task.count({ where: { userId: crew.id } }) === 0, "remove: Task rows cascaded");
            check(await db.profile.count({ where: { userId: crew.id } }) === 0, "remove: Profile row cascaded");
            check(await db.generatedResume.count({ where: { userId: crew.id } }) === 0, "remove: GeneratedResume rows cascaded");
            check(await db.resumeUpload.count({ where: { userId: crew.id } }) === 0, "remove: ResumeUpload rows cascaded");

            check(!existsSync(join(RESUMES_DIR, `${GEN_WITH_PATH}.pdf`)), "remove: the stored-artifactPath file is gone from disk");
            check(!existsSync(join(RESUMES_DIR, `${GEN_ORPHAN}.docx`)), "remove: the ORPHAN file is gone from disk too");
            check(!existsSync(join(UPLOADS_DIR, `${UPLOAD_ID}.pdf`)), "remove: the upload archive is gone from disk");
            check(existsSync(join(RESUMES_DIR, `${OWNER_GEN}.pdf`)), "remove: the OWNER's resume file was left alone");
            check(await db.user.count() === 1, "remove: only the owner remains");
        }

        // ── 7. `list` shows both roles ───────────────────────────────────────
        {
            await capture(() => addCrew("second@manage-crew-smoke.invalid", ops));
            const { value: res, out } = await capture(() => listUsers(ops));
            check(res.ok && res.exitCode === 0, "list: succeeds on a DB with tables absent (schema-behind tolerant)", res);
            check(out.includes("OWNER") && out.includes(OWNER_EMAIL), "list: shows the owner with its role");
            check(out.includes("crew") && out.includes("second@manage-crew-smoke.invalid"), "list: shows the crew row with its role");
            check(out.includes(OWNER_ID), "list: prints ids");
            check(/generatedResumes=1/.test(out), "list: prints counts that make the blast radius legible", out.slice(0, 400));

            // Teeth on the invariant warning: two owners must be flagged.
            await db.user.update({ where: { email: "second@manage-crew-smoke.invalid" }, data: { role: "owner" } });
            const { value: broken, out: brokenOut } = await capture(() => listUsers(ops));
            check(
                !broken.ok && broken.exitCode === 1 && /INVARIANT VIOLATION/.test(brokenOut),
                "list: two role='owner' rows is flagged AND exits non-zero",
                broken,
            );
            await db.user.update({ where: { email: "second@manage-crew-smoke.invalid" }, data: { role: "crew" } });
        }

        // ── 8. Target safety ─────────────────────────────────────────────────
        {
            const footgun = __databaseUrlToPath("file:./prisma/dev.db");
            check(
                footgun.warning !== undefined && footgun.absPath.includes(join("prisma", "prisma", "dev.db")),
                "target: the file:./prisma/dev.db phantom-DB footgun is detected and explained",
                footgun,
            );
            const ok = __databaseUrlToPath("file:./dev.db");
            check(
                ok.warning === undefined && ok.absPath === join(REPO_ROOT, "prisma", "dev.db"),
                "target: file:./dev.db resolves from prisma/, exactly as Prisma does",
                ok,
            );

            const both = __resolveTarget({ tier: "dev", db: "/tmp/x.db", confirm: false, help: false });
            check("error" in both, "target: --tier and --db together is an error", both);

            delete process.env.DATABASE_URL;
            const { value: noTarget, out: noTargetOut } = await capture(() => __main(["list"]));
            check(noTarget === 2, "target: no --tier and no DATABASE_URL → exit 2, never a guess", noTarget);
            check(/--tier=prod/.test(noTargetOut), "target: the error tells the operator which flag to pass");

            const { value: missingDb } = await capture(() => __main(["list", `--db=${join(TMP_DIR, "nope.db")}`]));
            check(missingDb === 2, "target: a nonexistent DB file is an error, not a fresh empty DB", missingDb);
            check(!existsSync(join(TMP_DIR, "nope.db")), "target: ...and no empty DB was created");

            // Destruction must NAME its target — an inherited DATABASE_URL is
            // not enough, because the wrong-DB failure mode is exactly a stale
            // export in the operator's shell.
            process.env.DATABASE_URL = `file:${TMP_DB}`;
            const { value: inherited, out: inheritedOut } = await capture(() =>
                __main(["remove", "second@manage-crew-smoke.invalid", "--confirm-delete"]),
            );
            check(inherited === 2, "target: remove --confirm-delete refuses an inherited DATABASE_URL", inherited);
            check(/--tier/.test(inheritedOut), "target: ...and says to name the tier explicitly");
            check(
                await db.user.findUnique({ where: { email: "second@manage-crew-smoke.invalid" } }) !== null,
                "target: ...and the row was NOT deleted",
            );

            // The same command with an explicit --db is allowed through (the
            // refusal above is about naming the target, not about blocking).
            const { value: named } = await capture(() =>
                __main(["remove", "second@manage-crew-smoke.invalid", `--db=${TMP_DB}`]),
            );
            check(named === 0, "target: an explicitly named target runs (dry run → exit 0)", named);
        }
    } finally {
        if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = savedDatabaseUrl;
        try { await db.$disconnect(); } catch { /* best-effort */ }
        rmSync(TMP_DIR, { recursive: true, force: true });
    }
}

/**
 * The exit path lives OUT here, not at the bottom of `main()`, so no early
 * `return` inside the body can skip it — the false-green shape that let
 * resume-list-smoke.ts print [FAIL] and still exit 0.
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} checks passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().then(finish, (e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
