/**
 * manage-crew — provision, inspect and remove the `User` rows behind the
 * multi-user "owner / crew" model (docs/multi-user-crew.html, task P5.4.1).
 *
 *   npx tsx scripts/manage-crew.ts list                --tier=prod
 *   npx tsx scripts/manage-crew.ts add <email>         --tier=prod
 *   npx tsx scripts/manage-crew.ts remove <email>      --tier=prod   # DRY RUN
 *   npx tsx scripts/manage-crew.ts remove <email>      --tier=prod --confirm-delete
 *
 * WHY THIS EXISTS. `lib/viewer.ts` rejects an Access-verified identity with no
 * `User` row with a 403 and one loud warn naming this script (OQ3a — unknown
 * identities are refused, and provisioning is a decision the owner makes by
 * hand rather than a side effect of an edge-policy edit). That warn line is the
 * spec this file implements; the invocation it advertises
 * (`manage-crew.ts add <email>`) is matched exactly, with one addition: the
 * target DB must be named. See "TARGET" below for why that is worth the extra
 * flag.
 *
 * There is NO other production `user.create` path in this codebase — only the
 * NextAuth adapter (crew never sign in to Google: OQ6a) and test fixtures — so
 * this script is the account-creation surface, not a convenience wrapper.
 *
 * ── TARGET ────────────────────────────────────────────────────────────────
 * Dev and prod are separate SQLite files. Provisioning the wrong one is silent
 * (the row is created, the person still 403s) so the target is never guessed:
 *
 *   --tier=dev | --tier=prod   canonical per-tier DB, read from
 *                              `.env.{development,production}`'s DATABASE_URL
 *                              and resolved to an ABSOLUTE path before use.
 *   --db=<path>                an explicit SQLite file (throwaway DBs, tests).
 *   (inherited DATABASE_URL)   accepted for `list` / `add` with a warning —
 *                              it is the repo's script convention — but
 *                              REFUSED for `remove --confirm-delete`:
 *                              destruction must name its target, not inherit
 *                              it from whatever the shell happens to export.
 *
 * Every run prints the resolved absolute path before doing anything, and a
 * target file that does not exist is a hard error rather than a fresh empty DB
 * — which is what makes the CLAUDE.md `file:./prisma/dev.db` footgun (Prisma
 * resolves relative `file:` URLs from `prisma/`, so that form silently creates
 * a phantom `prisma/prisma/dev.db`) fail loudly here instead of quietly.
 *
 * The connection is opened with an explicit `datasourceUrl` rather than through
 * `lib/prisma.ts`, so the file this process talks to is the file printed in the
 * banner — no env read, no relative-path resolution, nothing to drift.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────
 *   • `add` only ever writes `role: 'crew'`. There is no `--role` flag and
 *     unknown flags are rejected, so there is no argv that makes this script
 *     mint an owner. The exactly-one-owner invariant (OQ4a, asserted by
 *     user-scoping-smoke.ts) cannot be broken from here.
 *   • `remove` refuses `role='owner'` outright.
 *   • `remove` is a DRY RUN by default: it prints the full destruction
 *     manifest — per-table row counts plus every resume file it would unlink —
 *     and changes nothing without `--confirm-delete`.
 *   • All 18 `user User @relation` back-references are `onDelete: Cascade`, so
 *     the DB side is one statement. THE FILESYSTEM DOES NOT CASCADE: generated
 *     resumes (`data/resumes/`) and uploaded resume archives
 *     (`data/resume-uploads/`) are swept explicitly. Those files carry home
 *     address, phone number and full employment history (§3.2), so leaving
 *     them behind is the custodianship failure this command exists to avoid.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Db = PrismaClient;

export type Tier = "dev" | "prod";

/**
 * Injectable dependencies. The two directories are parameters rather than
 * module constants for one concrete reason: `lib/resumes/storage.ts` derives
 * its root from `process.cwd()`, which makes the sweep untestable without
 * writing into the REAL `data/resumes/`. Here they default to paths derived
 * from this file's own location (`REPO_ROOT`), so the sweep is correct
 * regardless of cwd, and the hermetic smoke points them at /tmp.
 */
export interface Ops {
    db: Db;
    /** Absolute dir holding `GeneratedResume` artifacts (`data/resumes`). */
    resumesDir: string;
    /** Absolute dir holding `ResumeUpload` archives (`data/resume-uploads`). */
    uploadsDir: string;
}

/** A count that may be unavailable on a schema-behind tier (Prisma P2021). */
export type Count = number | "missing" | "error";

export interface Footprint {
    /** Ordered for printing — big / PII-bearing relations first. */
    counts: Array<{ label: string; count: Count }>;
    /** True when any relation failed for a reason that is NOT a missing table. */
    degraded: boolean;
}

export interface ResumeArtifact {
    kind: "generated" | "upload";
    /** The `GeneratedResume` / `ResumeUpload` row id the file belongs to. */
    rowId: string;
    /** Path relative to the repo root, e.g. `data/resumes/abc123.pdf`. */
    relPath: string;
    absPath: string;
    exists: boolean;
    bytes: number | null;
    /**
     * True when the file was found by probing `<id>.<ext>` rather than by a
     * stored `artifactPath`. `lib/resumes/storage.ts` explicitly accepts
     * row/file divergence ("easy to clean up manually if it ever happens") —
     * this is that cleanup.
     */
    orphan: boolean;
}

export type Outcome =
    | "listed"
    | "created"
    | "duplicate"
    | "invalid-email"
    | "dry-run"
    | "deleted"
    | "not-found"
    | "refused-owner"
    | "collect-failed";

export interface CommandResult {
    ok: boolean;
    /** The process exit code this command maps to. */
    exitCode: 0 | 1 | 2;
    outcome: Outcome;
    userId?: string;
    email?: string;
    /** The RAW `User.role` string, not the narrowed union. */
    role?: string;
    footprint?: Footprint;
    artifacts?: ResumeArtifact[];
    /** Populated only on a confirmed `remove`. */
    swept?: { deleted: string[]; failed: string[] };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Derived from this file's location, NOT cwd — the sweep must not move. */
export const REPO_ROOT = resolve(__dirname, "..");

export function defaultOps(db: Db): Ops {
    return {
        db,
        resumesDir: join(REPO_ROOT, "data", "resumes"),
        uploadsDir: join(REPO_ROOT, "data", "resume-uploads"),
    };
}

/**
 * Open a client bound to one explicit file. Bypasses `lib/prisma.ts` on
 * purpose (see the header): `datasourceUrl` removes every layer that could
 * point this process at a different DB than the one in the banner.
 *
 * `busy_timeout` matters here — prod.db is being written by the live app and
 * the prod scheduler while this runs.
 */
export async function openDb(absPath: string): Promise<Db> {
    const db = new PrismaClient({ datasourceUrl: `file:${absPath}` });
    await db.$executeRawUnsafe("PRAGMA busy_timeout = 5000").catch(() => {});
    return db;
}

// ---------------------------------------------------------------------------
// Email normalization — MUST match lib/viewer.ts or the row never resolves.
// ---------------------------------------------------------------------------

/**
 * `lib/viewer.ts` does `rawEmail?.trim().toLowerCase()` on the
 * `Cf-Access-Authenticated-User-Email` header and looks the result up with
 * `findUnique({ where: { email } })`. A row stored in any other shape is a row
 * that can never match a viewer lookup, so this is byte-identical to that.
 *
 * Returns `null` for anything that is not a plausible address — a typo'd email
 * provisions an account nobody can use, and the failure surfaces days later as
 * "it still says I'm not provisioned".
 */
export function normalizeEmail(raw: string | undefined | null): string | null {
    const email = raw?.trim().toLowerCase();
    if (!email) return null;
    // Deliberately permissive: one @, no whitespace, a dot in the domain.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
}

// ---------------------------------------------------------------------------
// Footprint
// ---------------------------------------------------------------------------

/**
 * Every `User` back-relation in prisma/schema.prisma, in print order. All 18
 * are `onDelete: Cascade`, so this list IS the blast radius of one
 * `user.delete()` — which is why `remove` prints it before acting.
 *
 * Keep in sync with the schema: a relation added there and missed here makes
 * the manifest understate what a removal destroys.
 */
const RELATIONS: Array<{ label: string; count: (db: Db, userId: string) => Promise<number> }> = [
    { label: "applications", count: (db, userId) => db.application.count({ where: { userId } }) },
    { label: "generatedResumes", count: (db, userId) => db.generatedResume.count({ where: { userId } }) },
    { label: "resumeUploads", count: (db, userId) => db.resumeUpload.count({ where: { userId } }) },
    { label: "profile", count: (db, userId) => db.profile.count({ where: { userId } }) },
    { label: "profileSnapshots", count: (db, userId) => db.profileSnapshot.count({ where: { userId } }) },
    { label: "canons", count: (db, userId) => db.canon.count({ where: { userId } }) },
    { label: "watchlists", count: (db, userId) => db.watchlist.count({ where: { userId } }) },
    { label: "tasks", count: (db, userId) => db.task.count({ where: { userId } }) },
    { label: "lifeGoals", count: (db, userId) => db.lifeGoal.count({ where: { userId } }) },
    { label: "savedPapers", count: (db, userId) => db.savedPaper.count({ where: { userId } }) },
    { label: "notifications", count: (db, userId) => db.notification.count({ where: { userId } }) },
    { label: "blacklistedCompanies", count: (db, userId) => db.blacklistedCompany.count({ where: { userId } }) },
    { label: "failedIngests", count: (db, userId) => db.failedIngest.count({ where: { userId } }) },
    { label: "aiUsage", count: (db, userId) => db.aiUsage.count({ where: { userId } }) },
    { label: "googleAccounts", count: (db, userId) => db.account.count({ where: { userId } }) },
    { label: "sessions", count: (db, userId) => db.session.count({ where: { userId } }) },
    { label: "gcalSyncState", count: (db, userId) => db.gcalSyncState.count({ where: { userId } }) },
    { label: "globalSetting", count: (db, userId) => db.globalSetting.count({ where: { userId } }) },
];

/**
 * Prisma raises P2021 when a table the client knows about is absent from the
 * file. That is a REAL state in this repo — CLAUDE.md documents a tier running
 * schema-behind — so a missing table degrades that one row to `missing`
 * instead of killing the whole command. Any OTHER failure is a genuine DB
 * error and is reported as `error`, which forces a non-zero exit.
 */
function isMissingTable(err: unknown): boolean {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2021") {
        return true;
    }
    return err instanceof Error && /no such table/i.test(err.message);
}

async function safeCount(fn: () => Promise<number>): Promise<Count> {
    try {
        return await fn();
    } catch (err) {
        if (isMissingTable(err)) return "missing";
        console.error("[manage-crew] count failed:", err);
        return "error";
    }
}

export async function collectFootprint(userId: string, ops: Ops): Promise<Footprint> {
    const counts: Footprint["counts"] = [];
    let degraded = false;
    for (const rel of RELATIONS) {
        const count = await safeCount(() => rel.count(ops.db, userId));
        if (count === "error") degraded = true;
        counts.push({ label: rel.label, count });
    }
    return { counts, degraded };
}

// ---------------------------------------------------------------------------
// Resume artifacts — the part that does NOT cascade
// ---------------------------------------------------------------------------

/**
 * Artifacts are always FLAT under their storage root and named `<cuid>.<ext>`
 * (`lib/resumes/storage.ts:safeRelative`, `lib/profile/storage.ts` likewise).
 * Anything else in the column is not a filename this script wrote, and it is
 * reported rather than unlinked — an `artifactPath` containing a separator is
 * a bug worth seeing, not a path to hand to `unlink`.
 */
const FLAT_ARTIFACT_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

const UPLOAD_PREFIX = "data/resume-uploads/";

/** The two `GeneratedResume.format` values — probed for row/file divergence. */
const GENERATED_EXTS = ["pdf", "docx"];

async function probe(dir: string, filename: string): Promise<{ exists: boolean; bytes: number | null }> {
    try {
        const st = await stat(join(dir, filename));
        return { exists: st.isFile(), bytes: st.isFile() ? st.size : null };
    } catch {
        return { exists: false, bytes: null };
    }
}

/**
 * Collect every on-disk resume file belonging to `userId`.
 *
 * Throws on a real DB error. That is deliberate: `remove` must abort rather
 * than delete a `User` row whose file set it could not enumerate — the row is
 * gone forever, the ids with it, and the files become unattributable PII. A
 * MISSING table (schema-behind tier) is not an error: there is nothing to
 * sweep.
 */
export async function collectResumeArtifacts(userId: string, ops: Ops): Promise<ResumeArtifact[]> {
    const out: ResumeArtifact[] = [];

    // ---- GeneratedResume: artifactPath holds the BARE filename ------------
    // (`writeResumeArtifact` returns `filename`, not a repo-relative path.)
    let generated: Array<{ id: string; artifactPath: string | null }> = [];
    try {
        generated = await ops.db.generatedResume.findMany({
            where: { userId },
            select: { id: true, artifactPath: true },
        });
    } catch (err) {
        if (!isMissingTable(err)) throw err;
        console.warn("[manage-crew] GeneratedResume table absent on this DB — no generated resumes to sweep.");
    }

    for (const row of generated) {
        const names = new Set<string>();
        if (row.artifactPath) {
            if (FLAT_ARTIFACT_NAME.test(row.artifactPath)) {
                names.add(row.artifactPath);
            } else {
                console.warn(
                    `[manage-crew] GeneratedResume ${row.id} has an unexpected artifactPath ` +
                    `(${JSON.stringify(row.artifactPath)}) — NOT sweeping it; remove it by hand.`,
                );
            }
        }
        // Belt and braces: a row whose write succeeded but whose column update
        // failed has a null artifactPath and a live file. Probe both formats.
        for (const ext of GENERATED_EXTS) names.add(`${row.id}.${ext}`);

        for (const name of names) {
            const { exists, bytes } = await probe(ops.resumesDir, name);
            if (!exists && name !== row.artifactPath) continue; // don't list phantom probes
            out.push({
                kind: "generated",
                rowId: row.id,
                relPath: `data/resumes/${name}`,
                absPath: join(ops.resumesDir, name),
                exists,
                bytes,
                orphan: name !== row.artifactPath,
            });
        }
    }

    // ---- ResumeUpload: artifactPath holds `data/resume-uploads/<id>.<ext>` -
    // (`writeResumeUpload` returns the directory-prefixed path — the two
    //  stores genuinely differ, so each is handled on its own terms.)
    let uploads: Array<{ id: string; filename: string; artifactPath: string | null }> = [];
    try {
        uploads = await ops.db.resumeUpload.findMany({
            where: { userId },
            select: { id: true, filename: true, artifactPath: true },
        });
    } catch (err) {
        if (!isMissingTable(err)) throw err;
        console.warn("[manage-crew] ResumeUpload table absent on this DB — no uploads to sweep.");
    }

    for (const row of uploads) {
        let name: string | null = null;
        if (row.artifactPath) {
            const stored = row.artifactPath.replace(/^\.\//, "");
            if (stored.startsWith(UPLOAD_PREFIX) && FLAT_ARTIFACT_NAME.test(stored.slice(UPLOAD_PREFIX.length))) {
                name = stored.slice(UPLOAD_PREFIX.length);
            } else {
                console.warn(
                    `[manage-crew] ResumeUpload ${row.id} has an unexpected artifactPath ` +
                    `(${JSON.stringify(row.artifactPath)}) — NOT sweeping it; remove it by hand.`,
                );
            }
        } else {
            // Pasted-JSON imports never had bytes; a binary upload whose column
            // write failed did. Derive the extension from the original name.
            const ext = row.filename.includes(".") ? row.filename.split(".").pop() ?? "" : "";
            if (/^[A-Za-z0-9]+$/.test(ext)) name = `${row.id}.${ext.toLowerCase()}`;
        }
        if (!name) continue;

        const { exists, bytes } = await probe(ops.uploadsDir, name);
        if (!exists && !row.artifactPath) continue; // probe miss — nothing to report
        out.push({
            kind: "upload",
            rowId: row.id,
            relPath: `${UPLOAD_PREFIX}${name}`,
            absPath: join(ops.uploadsDir, name),
            exists,
            bytes,
            orphan: !row.artifactPath,
        });
    }

    return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fmtBytes(n: number | null): string {
    if (n === null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtCount(c: Count): string {
    return c === "missing" ? "(table absent)" : c === "error" ? "ERROR" : String(c);
}

function footprintLine(fp: Footprint): string {
    const shown = fp.counts.filter((c) => c.count !== 0);
    if (shown.length === 0) return "no data";
    return shown.map((c) => `${c.label}=${fmtCount(c.count)}`).join("  ");
}

export async function listUsers(ops: Ops): Promise<CommandResult> {
    const users = await ops.db.user.findMany({
        select: { id: true, email: true, name: true, role: true },
        orderBy: [{ role: "desc" }, { email: "asc" }], // owner first, then crew A–Z
    });

    if (users.length === 0) {
        console.warn("[manage-crew] no User rows on this DB.");
        return { ok: true, exitCode: 0, outcome: "listed" };
    }

    let degraded = false;
    console.info(`\n${users.length} user row(s):\n`);
    for (const u of users) {
        const fp = await collectFootprint(u.id, ops);
        if (fp.degraded) degraded = true;
        const artifacts = await collectResumeArtifacts(u.id, ops).catch((err) => {
            console.error(`[manage-crew] could not enumerate resume files for ${u.email}:`, err);
            degraded = true;
            return [] as ResumeArtifact[];
        });
        const onDisk = artifacts.filter((a) => a.exists);
        const diskBytes = onDisk.reduce((sum, a) => sum + (a.bytes ?? 0), 0);

        console.info(`  ${u.role === "owner" ? "OWNER" : "crew "}  ${u.email ?? "(no email)"}`);
        console.info(`         id:    ${u.id}${u.name ? `   name: ${u.name}` : ""}`);
        console.info(`         data:  ${footprintLine(fp)}`);
        console.info(`         files: ${onDisk.length} resume file(s), ${fmtBytes(diskBytes)} on disk`);
        console.info("");
    }

    // The OQ4a invariant, surfaced where the operator is already looking.
    const owners = users.filter((u) => u.role === "owner").length;
    if (owners !== 1) {
        console.warn(
            `[manage-crew] INVARIANT VIOLATION: ${owners} row(s) with role='owner' — must be exactly 1. ` +
            `Zero 403s the owner out of their own app; two silently hands the scheduler a non-owner. ` +
            `Fix with the migration's UPDATE, not with this script.`,
        );
        degraded = true;
    }

    return { ok: !degraded, exitCode: degraded ? 1 : 0, outcome: "listed" };
}

export async function addCrew(rawEmail: string | undefined, ops: Ops): Promise<CommandResult> {
    const email = normalizeEmail(rawEmail);
    if (!email) {
        console.error(`[manage-crew] not a usable email address: ${JSON.stringify(rawEmail ?? "")}`);
        return { ok: false, exitCode: 2, outcome: "invalid-email" };
    }
    if (rawEmail !== email) {
        console.info(`[manage-crew] normalized ${JSON.stringify(rawEmail)} → ${email} (trim + lowercase, matching lib/viewer.ts).`);
    }

    const existing = await ops.db.user.findUnique({
        where: { email },
        select: { id: true, email: true, role: true },
    });
    if (existing) {
        console.error(
            `[manage-crew] ${email} already exists (id ${existing.id}, role ${existing.role}) — refusing to create a duplicate.`,
        );
        return { ok: false, exitCode: 1, outcome: "duplicate", userId: existing.id, email, role: existing.role };
    }

    // Informational only — this script never creates or promotes an owner, so
    // a broken invariant here is something the operator must fix elsewhere.
    const owners = await ops.db.user.count({ where: { role: "owner" } });
    if (owners !== 1) {
        console.warn(
            `[manage-crew] this DB has ${owners} role='owner' row(s) (expected exactly 1). ` +
            `Adding crew is still safe, but resolveOwner() and requireOwner() are wrong until that is fixed.`,
        );
    }

    // `role: "crew"` is a LITERAL and there is no flag that can change it.
    const created = await ops.db.user.create({
        data: { email, role: "crew" },
        select: { id: true, email: true, role: true },
    });

    // Defence against a future schema-default flip (the rejected OQ4b shape):
    // if the row that came back is not crew, this script just minted an owner.
    // Undo it and fail rather than leave a silent privilege escalation.
    if (created.role !== "crew") {
        await ops.db.user.delete({ where: { id: created.id } }).catch(() => {});
        console.error(
            `[manage-crew] REFUSING: the created row came back with role='${created.role}', not 'crew'. ` +
            `The row was deleted. Check User.role's column default in prisma/schema.prisma.`,
        );
        return { ok: false, exitCode: 1, outcome: "refused-owner", email };
    }

    console.info(`[manage-crew] created crew user ${created.email}  (id ${created.id})`);
    console.info("");
    console.info("  Next, per docs/multi-user-crew.html P5.3–P5.4.2:");
    console.info("   1. add this address to the mc.salsquared.xyz Cloudflare Access policy (if not already there);");
    console.info("   2. before they enter anything, tell them in one plain sentence what is stored");
    console.info("      (applications, profile, resumes — home address, phone, employment history)");
    console.info("      and that the owner can read all of it. §3.2: disclosable, not fixable.");
    return { ok: true, exitCode: 0, outcome: "created", userId: created.id, email: created.email ?? email, role: created.role };
}

export async function removeUser(
    rawEmail: string | undefined,
    ops: Ops,
    opts: { confirm: boolean },
): Promise<CommandResult> {
    const email = normalizeEmail(rawEmail);
    if (!email) {
        console.error(`[manage-crew] not a usable email address: ${JSON.stringify(rawEmail ?? "")}`);
        return { ok: false, exitCode: 2, outcome: "invalid-email" };
    }

    const user = await ops.db.user.findUnique({
        where: { email },
        select: { id: true, email: true, name: true, role: true },
    });
    if (!user) {
        console.error(`[manage-crew] no User row for ${email} — nothing to remove.`);
        return { ok: false, exitCode: 1, outcome: "not-found", email };
    }

    // The owner is never removable from here. `resolveOwner()` selects on this
    // exact string, so deleting it locks the owner out of their own app and
    // leaves the scheduler with no identity.
    if (user.role === "owner") {
        console.error(
            `[manage-crew] REFUSING to remove ${email}: role='owner'. ` +
            `resolveOwner() selects on this row — deleting it 403s the owner out of their own app ` +
            `and breaks the exactly-one-owner invariant (OQ4a). This command removes crew only.`,
        );
        return { ok: false, exitCode: 1, outcome: "refused-owner", userId: user.id, email, role: user.role };
    }

    const footprint = await collectFootprint(user.id, ops);

    // A failure HERE aborts before any delete: once the User row is gone the
    // resume ids are unrecoverable and the files become unattributable PII.
    let artifacts: ResumeArtifact[];
    try {
        artifacts = await collectResumeArtifacts(user.id, ops);
    } catch (err) {
        console.error(
            "[manage-crew] ABORTING: could not enumerate this user's resume files, so the filesystem " +
            "sweep would be incomplete. Nothing was deleted.",
            err,
        );
        return { ok: false, exitCode: 1, outcome: "collect-failed", userId: user.id, email, role: user.role };
    }

    // ---- the manifest, printed before anything is touched ------------------
    const onDisk = artifacts.filter((a) => a.exists);
    console.info("");
    console.info(`  REMOVING  ${user.email}  (id ${user.id}, role ${user.role}${user.name ? `, name ${user.name}` : ""})`);
    console.info("");
    console.info("  Database rows destroyed by the cascade:");
    for (const { label, count } of footprint.counts) {
        console.info(`    ${label.padEnd(22)} ${fmtCount(count)}`);
    }
    console.info("");
    console.info(`  Resume files swept (the filesystem does NOT cascade) — ${onDisk.length} present:`);
    if (artifacts.length === 0) {
        console.info("    (none)");
    }
    for (const a of artifacts) {
        const tags = [a.exists ? fmtBytes(a.bytes) : "MISSING ON DISK", a.orphan ? "orphan (no artifactPath)" : null]
            .filter(Boolean)
            .join(", ");
        console.info(`    ${a.relPath.padEnd(52)} ${tags}   [${a.kind} ${a.rowId}]`);
    }
    console.info("");

    if (footprint.degraded) {
        console.warn("[manage-crew] at least one row count failed (see ERROR above) — the manifest may understate the loss.");
    }

    if (!opts.confirm) {
        console.warn("  DRY RUN — nothing was deleted.");
        console.warn(`  Re-run with --confirm-delete to destroy the above. This is not reversible; ` +
            `scripts/backup-db.sh first if you want a way back.`);
        return { ok: true, exitCode: 0, outcome: "dry-run", userId: user.id, email, role: user.role, footprint, artifacts };
    }

    // DB row FIRST, then files. If the file sweep fails afterwards we have
    // orphan files and a loud report; the other order risks deleting someone's
    // files while leaving their account live and its resumes 404ing.
    await ops.db.user.delete({ where: { id: user.id } });
    console.info(`[manage-crew] deleted User ${user.id} — all 18 relations cascaded.`);

    const deleted: string[] = [];
    const failed: string[] = [];
    for (const a of artifacts) {
        if (!a.exists) continue;
        try {
            await unlink(a.absPath);
            deleted.push(a.relPath);
        } catch (err) {
            failed.push(a.relPath);
            console.error(`[manage-crew] could not unlink ${a.relPath}:`, err);
        }
    }
    console.info(`[manage-crew] swept ${deleted.length} resume file(s).`);
    if (failed.length > 0) {
        console.error(
            `[manage-crew] ${failed.length} file(s) SURVIVED and still hold this person's data — delete by hand:\n` +
            failed.map((f) => `    ${f}`).join("\n"),
        );
        return { ok: false, exitCode: 1, outcome: "deleted", userId: user.id, email, role: user.role, footprint, artifacts, swept: { deleted, failed } };
    }

    return { ok: true, exitCode: 0, outcome: "deleted", userId: user.id, email, role: user.role, footprint, artifacts, swept: { deleted, failed } };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface Target {
    absPath: string;
    /** How the target was chosen — printed, and gated on for destructive runs. */
    source: string;
    /** True when the target came from an inherited env var rather than a flag. */
    inherited: boolean;
}

const TIER_ENV_FILE: Record<Tier, string> = {
    dev: ".env.development",
    prod: ".env.production",
};

const TIER_DEFAULT_DB: Record<Tier, string> = {
    dev: "dev.db",
    prod: "prod.db",
};

/** Read `DATABASE_URL` out of an untracked per-tier env file, if it exists. */
function databaseUrlFromEnvFile(file: string): string | null {
    const path = join(REPO_ROOT, file);
    if (!existsSync(path)) return null;
    try {
        const line = readFileSync(path, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .find((l) => /^DATABASE_URL\s*=/.test(l));
        if (!line) return null;
        return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    } catch {
        return null;
    }
}

/**
 * Turn a Prisma `file:` URL into an absolute path the SAME way Prisma does —
 * relative paths resolve from the directory holding schema.prisma, i.e.
 * `<repo>/prisma`. Also flags the CLAUDE.md footgun.
 */
function databaseUrlToPath(url: string): { absPath: string; warning?: string } {
    const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
    if (isAbsolute(raw)) return { absPath: raw };
    const cleaned = raw.replace(/^\.\//, "");
    const absPath = resolve(REPO_ROOT, "prisma", cleaned);
    if (/^prisma\//.test(cleaned)) {
        return {
            absPath,
            warning:
                `DATABASE_URL is "${url}", which Prisma resolves from prisma/ — i.e. ${absPath}. ` +
                `That is the phantom-DB footgun in CLAUDE.md; you almost certainly meant "file:./${cleaned.slice("prisma/".length)}".`,
        };
    }
    return { absPath };
}

function resolveTarget(flags: Flags): { target: Target } | { error: string } {
    if (flags.tier && flags.db) {
        return { error: "pass --tier or --db, not both." };
    }

    if (flags.db) {
        return {
            target: {
                absPath: isAbsolute(flags.db) ? flags.db : resolve(process.cwd(), flags.db),
                source: "--db",
                inherited: false,
            },
        };
    }

    if (flags.tier) {
        const envFile = TIER_ENV_FILE[flags.tier];
        const url = databaseUrlFromEnvFile(envFile);
        if (!url) {
            const absPath = join(REPO_ROOT, "prisma", TIER_DEFAULT_DB[flags.tier]);
            return {
                target: {
                    absPath,
                    source: `--tier=${flags.tier} (default path — ${envFile} has no DATABASE_URL)`,
                    inherited: false,
                },
            };
        }
        const { absPath, warning } = databaseUrlToPath(url);
        if (warning) console.warn(`[manage-crew] ${warning}`);
        return { target: { absPath, source: `--tier=${flags.tier} via ${envFile}`, inherited: false } };
    }

    const inheritedUrl = process.env.DATABASE_URL;
    if (inheritedUrl) {
        const { absPath, warning } = databaseUrlToPath(inheritedUrl);
        if (warning) console.warn(`[manage-crew] ${warning}`);
        return { target: { absPath, source: "inherited DATABASE_URL", inherited: true } };
    }

    return {
        error:
            "no target database. Dev and prod are separate files and provisioning the wrong one is silent, " +
            "so this is never guessed. Pass --tier=prod (crew live on prod; dev is owner-only per OQ12a) " +
            "or --tier=dev, or DATABASE_URL=\"file:./prod.db\" as the repo's scripts do.",
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Flags {
    tier?: Tier;
    db?: string;
    confirm: boolean;
    help: boolean;
}

interface Parsed {
    command?: string;
    positionals: string[];
    flags: Flags;
    error?: string;
}

function parseArgv(argv: string[]): Parsed {
    const positionals: string[] = [];
    const flags: Flags = { confirm: false, help: false };

    for (const arg of argv) {
        if (!arg.startsWith("-")) {
            positionals.push(arg);
            continue;
        }
        const [name, ...rest] = arg.split("=");
        const value = rest.join("=");
        switch (name) {
            case "--tier":
                if (value !== "dev" && value !== "prod") {
                    return { positionals, flags, error: `--tier must be dev or prod (got ${JSON.stringify(value)}).` };
                }
                flags.tier = value;
                break;
            case "--db":
                if (!value) return { positionals, flags, error: "--db needs a path (--db=/tmp/x.db)." };
                flags.db = value;
                break;
            case "--confirm-delete":
                flags.confirm = true;
                break;
            case "--help":
            case "-h":
                flags.help = true;
                break;
            default:
                // Unknown flags are REJECTED, not ignored. This is what makes
                // "there is no argv that mints an owner" true rather than
                // merely likely: `--role=owner` exits 2 instead of passing
                // silently through to something that might one day read it.
                return { positionals, flags, error: `unknown flag ${name}. Run with --help.` };
        }
    }

    return { command: positionals[0], positionals: positionals.slice(1), flags };
}

const USAGE = `
manage-crew — provision / inspect / remove owner+crew User rows
(docs/multi-user-crew.html P5.4.1)

  npx tsx scripts/manage-crew.ts <command> [email] --tier=dev|prod

Commands
  list                      Every User row: role, email, id, and the row + file
                            counts that make "what would removing them destroy"
                            legible.
  add <email>               Create ONE role='crew' User row. Email is trimmed +
                            lowercased to match lib/viewer.ts. Refuses a
                            duplicate; can never create an owner.
  remove <email>            DRY RUN — print exactly what deleting them destroys.
  remove <email> --confirm-delete
                            Actually delete: the User row (all 18 relations
                            cascade) plus their resume files on disk. Refuses
                            role='owner'. NOT REVERSIBLE.

Target (required — dev and prod are separate DBs)
  --tier=dev | --tier=prod  Canonical per-tier DB, read from
                            .env.development / .env.production.
  --db=<path>               An explicit SQLite file (throwaway DBs, tests).
  DATABASE_URL=file:./prod.db
                            Accepted for list/add; REFUSED for
                            remove --confirm-delete, which must name its target.

Exit codes
  0  success (including a dry run)
  1  refused or failed (duplicate, owner removal, unknown email, DB error)
  2  usage error (bad flags, no target, target DB missing)
`;

async function main(argv: string[]): Promise<0 | 1 | 2> {
    const parsed = parseArgv(argv);

    // Parse errors are reported BEFORE the usage banner, so a rejected flag
    // (`--role=owner`) says which flag was rejected instead of dumping --help.
    if (parsed.error) {
        console.error(`[manage-crew] ${parsed.error}`);
        return 2;
    }
    if (parsed.flags.help || !parsed.command) {
        console.info(USAGE);
        return parsed.flags.help ? 0 : 2;
    }
    if (!["list", "add", "remove"].includes(parsed.command)) {
        console.error(`[manage-crew] unknown command ${JSON.stringify(parsed.command)}. Run with --help.`);
        return 2;
    }

    const resolved = resolveTarget(parsed.flags);
    if ("error" in resolved) {
        console.error(`[manage-crew] ${resolved.error}`);
        return 2;
    }
    const target = resolved.target;

    // Destruction must NAME its target. An inherited DATABASE_URL is fine for
    // reads and for creating a row; it is not enough to justify deleting
    // someone's entire history against whatever the shell happens to export.
    if (parsed.command === "remove" && parsed.flags.confirm && target.inherited) {
        console.error(
            "[manage-crew] remove --confirm-delete will not run off an inherited DATABASE_URL. " +
            `Name the target explicitly: --tier=dev or --tier=prod (this shell points at ${target.absPath}).`,
        );
        return 2;
    }

    if (!existsSync(target.absPath)) {
        console.error(
            `[manage-crew] target database does not exist: ${target.absPath}\n` +
            "  Refusing to create an empty one — a fresh file would silently succeed and provision nobody.",
        );
        return 2;
    }

    const size = await stat(target.absPath).then((s) => fmtBytes(s.size)).catch(() => "?");
    console.info(`[manage-crew] target: ${target.absPath}  (${size})  [${target.source}]`);
    if (target.inherited) {
        console.warn("[manage-crew] target came from an inherited DATABASE_URL — confirm that is the DB you meant.");
    }

    const db = await openDb(target.absPath);
    const ops = defaultOps(db);
    try {
        switch (parsed.command) {
            case "list":
                return (await listUsers(ops)).exitCode;
            case "add":
                return (await addCrew(parsed.positionals[0], ops)).exitCode;
            case "remove":
                return (await removeUser(parsed.positionals[0], ops, { confirm: parsed.flags.confirm })).exitCode;
            default:
                return 2;
        }
    } finally {
        await db.$disconnect().catch(() => {});
    }
}

// The exit path lives OUT here and consumes main()'s RETURN VALUE, so no early
// `return` inside the body can skip it — the false-green shape that let
// resume-list-smoke.ts print [FAIL] and still exit 0.
if (require.main === module) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (err) => {
            console.error("[manage-crew] crashed:", err);
            process.exit(1);
        },
    );
}

// Test seams. The `__` prefix is this repo's "test seam, not API" marker
// (`lib/viewer.ts:__seedViewer`), so `grep -rn '__parseArgv' app lib` is a
// one-line check that nothing in the app depends on them.
export {
    main as __main,
    parseArgv as __parseArgv,
    resolveTarget as __resolveTarget,
    databaseUrlToPath as __databaseUrlToPath,
};
export type { Flags as __Flags, Target as __Target };
/** Relation labels the manifest prints — asserted against schema.prisma. */
export const __RELATION_LABELS = RELATIONS.map((r) => r.label);
