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
// Shared core (P7). The provisioning LOGIC and its invariants now live in
// `lib/crew/core.ts` so that this CLI and the owner-only crew UI cannot drift
// apart on them. This file keeps what is genuinely CLI-shaped: argv parsing,
// tier→DB resolution, and terminal presentation.
//
// The re-exports below are NOT decoration — `scripts/tests/hermetic/
// manage-crew-smoke.ts` imports these names from THIS module, and keeping them
// exported here means the extraction is provably behaviour-preserving: that
// 67-assertion suite runs unchanged against the moved code.
// ---------------------------------------------------------------------------
export {
    normalizeEmail,
    collectFootprint,
    collectResumeArtifacts,
    listUsers,
    addCrew,
    removeUser,
    RELATIONS,
} from "@/lib/crew/core";
export type { Db, Ops, Count, Footprint, ResumeArtifact, Outcome, CommandResult, Tier } from "@/lib/crew/core";

import type { Tier } from "@/lib/crew/core";

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

import {
    listUsers,
    addCrew,
    removeUser,
    RELATIONS,
    fmtBytes,
    type Db,
    type Ops,
    type Footprint,
    type Count,
} from "@/lib/crew/core";

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
