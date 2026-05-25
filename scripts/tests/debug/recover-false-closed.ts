/**
 * One-shot recovery for JobPostings that were incorrectly auto-closed by the
 * pre-probe close-detection logic.
 *
 * Design + rationale: docs/close-detection-probe.md.
 *
 * Probes every `status="closed"` posting against its source URL using the
 * same per-kind profiles in `lib/postings/liveness.ts`. For each "alive"
 * verdict, reopens the row:
 *   - status → "tracked" if an `Application.postingId` row points at it
 *     (preserves the user's prior Track-as-App action), else "new"
 *   - removedAt → null
 *   - lastSeenAt → now (resets the 6h stale clock)
 *
 * Dry-run by default. Idempotent — re-running only mutates rows that probe
 * "alive" now.
 *
 *   # dry-run (default), all closed postings:
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/recover-false-closed.ts
 *
 *   # restrict to one kind:
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/recover-false-closed.ts --kind=linkedin
 *
 *   # actually mutate:
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/recover-false-closed.ts --kind=linkedin --apply
 *
 *   # bump the per-kind probe cap to N× the default (lets a Workday backlog
 *   # of 700 rows drain in one script run instead of needing the live job-
 *   # watcher's per-tick cap to handle it):
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/recover-false-closed.ts --kind=workday --cap-multiplier=2 --apply
 *
 *   # prod:
 *   DATABASE_URL="file:./prod.db" npx tsx scripts/tests/debug/recover-false-closed.ts --apply
 *
 * Cli flags:
 *   --apply              — actually mutate (default: dry-run)
 *   --kind=<kind>        — restrict to one ATS kind
 *   --watchlist=<id>     — restrict to one watchlist
 *   --limit=<n>          — cap rows pulled from DB (testing)
 *   --cap-multiplier=<n> — multiplier on PROBE_PROFILES[kind].maxPerTick (default 1)
 */
import { PrismaClient } from "@prisma/client";
import {
    probeBatch,
    PROBE_PROFILES,
    type WatchlistKind,
    type LivenessResult,
} from "@/lib/postings/liveness";

const prisma = new PrismaClient();

interface CliOpts {
    apply: boolean;
    kind: WatchlistKind | null;
    watchlistId: string | null;
    limit: number | null;
    capMultiplier: number;
}

function parseArgs(argv: string[]): CliOpts {
    const opts: CliOpts = { apply: false, kind: null, watchlistId: null, limit: null, capMultiplier: 1 };
    for (const a of argv) {
        if (a === "--apply") opts.apply = true;
        else if (a.startsWith("--kind=")) opts.kind = a.slice("--kind=".length) as WatchlistKind;
        else if (a.startsWith("--watchlist=")) opts.watchlistId = a.slice("--watchlist=".length);
        else if (a.startsWith("--limit=")) {
            const n = parseInt(a.slice("--limit=".length), 10);
            if (Number.isNaN(n) || n <= 0) {
                console.error(`Invalid --limit (must be a positive integer): ${a.slice("--limit=".length)}`);
                process.exit(1);
            }
            opts.limit = n;
        }
        else if (a.startsWith("--cap-multiplier=")) opts.capMultiplier = parseFloat(a.slice("--cap-multiplier=".length));
        else if (a === "--help" || a === "-h") {
            console.log("See file header for flags.");
            process.exit(0);
        }
    }
    if (opts.kind !== null && !(opts.kind in PROBE_PROFILES)) {
        console.error(`Unknown --kind=${opts.kind}. Valid: ${Object.keys(PROBE_PROFILES).join(", ")}`);
        process.exit(1);
    }
    if (Number.isNaN(opts.capMultiplier) || opts.capMultiplier <= 0) {
        console.error(`Invalid --cap-multiplier (must be > 0): ${opts.capMultiplier}`);
        process.exit(1);
    }
    return opts;
}

interface ClosedRow {
    id: string;
    externalId: string;
    sourceUrl: string;
    company: string;
    title: string;
    removedAt: Date | null;
    watchlistKind: string;
    watchlistName: string;
    hasApplication: boolean;
}

async function fetchClosedRows(opts: CliOpts): Promise<ClosedRow[]> {
    const rows = await prisma.jobPosting.findMany({
        where: {
            status: "closed",
            ...(opts.watchlistId ? { watchlistId: opts.watchlistId } : {}),
            ...(opts.kind ? { watchlist: { kind: opts.kind } } : {}),
        },
        select: {
            id: true,
            externalId: true,
            sourceUrl: true,
            company: true,
            title: true,
            removedAt: true,
            watchlist: { select: { kind: true, name: true } },
            // The Application reverse relation: Application.postingId is unique,
            // so this is 0-or-1. The schema sets onDelete: SetNull so the
            // posting can outlive its Application.
            application: { select: { id: true } },
        },
        orderBy: { removedAt: "asc" },
        ...(opts.limit ? { take: opts.limit } : {}),
    });
    return rows.map(r => ({
        id: r.id,
        externalId: r.externalId,
        sourceUrl: r.sourceUrl,
        company: r.company,
        title: r.title,
        removedAt: r.removedAt,
        watchlistKind: r.watchlist.kind,
        watchlistName: r.watchlist.name,
        hasApplication: r.application !== null,
    }));
}

interface RecoveryStats {
    probed: number;
    alive: number;
    closed: number;
    unknown: number;
    reopened: number;
    reopenedAsTracked: number;
    reopenedAsNew: number;
}

function emptyStats(): RecoveryStats {
    return { probed: 0, alive: 0, closed: 0, unknown: 0, reopened: 0, reopenedAsTracked: 0, reopenedAsNew: 0 };
}

async function recoverOneKind(kind: WatchlistKind, rows: ClosedRow[], opts: CliOpts): Promise<RecoveryStats> {
    const stats = emptyStats();
    if (rows.length === 0) return stats;

    const baseProfile = PROBE_PROFILES[kind];
    const liftedCap = Math.max(1, Math.floor(baseProfile.maxPerTick * opts.capMultiplier));
    console.log(
        `\n[${kind}] ${rows.length} closed rows. Profile: concurrency=${baseProfile.concurrency}, ` +
        `perHitDelayMs=${baseProfile.perHitDelayMs}, maxPerTick=${liftedCap} (base ${baseProfile.maxPerTick} × ${opts.capMultiplier}).`,
    );

    // Probe in chunks of the lifted cap. Each chunk respects the per-kind
    // profile's concurrency + delay. Between chunks we don't sleep — within
    // a chunk the delay already paces same-host hits.
    const now = new Date();
    for (let i = 0; i < rows.length; i += liftedCap) {
        const chunk = rows.slice(i, i + liftedCap);
        const inputs = chunk.map(r => ({ externalId: r.externalId, sourceUrl: r.sourceUrl }));
        const verdicts = await probeBatch(inputs, kind, { profile: { maxPerTick: liftedCap } });

        const aliveTrackedIds: string[] = [];
        const aliveNewIds: string[] = [];
        for (const r of chunk) {
            stats.probed++;
            const v: LivenessResult = verdicts.get(r.externalId) ?? "unknown";
            if (v === "alive") {
                stats.alive++;
                if (r.hasApplication) aliveTrackedIds.push(r.id);
                else aliveNewIds.push(r.id);
            } else if (v === "closed") {
                stats.closed++;
            } else {
                stats.unknown++;
            }
        }

        if (opts.apply) {
            // Race-guard: between fetchClosedRows() and now, the user could
            // have manually un-closed (e.g. clicked Hide → Track again). Only
            // mutate rows that are STILL status="closed".
            if (aliveTrackedIds.length > 0) {
                const u = await prisma.jobPosting.updateMany({
                    where: { id: { in: aliveTrackedIds }, status: "closed" },
                    data: { status: "tracked", removedAt: null, lastSeenAt: now },
                });
                stats.reopenedAsTracked += u.count;
                stats.reopened += u.count;
            }
            if (aliveNewIds.length > 0) {
                const u = await prisma.jobPosting.updateMany({
                    where: { id: { in: aliveNewIds }, status: "closed" },
                    data: { status: "new", removedAt: null, lastSeenAt: now },
                });
                stats.reopenedAsNew += u.count;
                stats.reopened += u.count;
            }
        } else {
            // Dry-run accounting — count what *would* be reopened.
            stats.reopenedAsTracked += aliveTrackedIds.length;
            stats.reopenedAsNew += aliveNewIds.length;
            stats.reopened += aliveTrackedIds.length + aliveNewIds.length;
        }

        const sliceEnd = Math.min(i + liftedCap, rows.length);
        console.log(
            `  [${kind}] chunk ${i + 1}–${sliceEnd}/${rows.length}: ` +
            `alive=${stats.alive} closed=${stats.closed} unknown=${stats.unknown}`,
        );
    }

    return stats;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    console.log("recover-false-closed.ts —", JSON.stringify(opts));
    console.log("DATABASE_URL:", process.env.DATABASE_URL ?? "(unset)");
    if (!opts.apply) console.log("\n** DRY-RUN ** — no rows will be mutated. Pass --apply to commit.");

    const all = await fetchClosedRows(opts);
    console.log(`\nPulled ${all.length} closed posting rows.`);

    // Group by watchlistKind.
    const byKind = new Map<WatchlistKind, ClosedRow[]>();
    for (const r of all) {
        const k = r.watchlistKind as WatchlistKind;
        if (!(k in PROBE_PROFILES)) {
            console.warn(`Skipping row ${r.id} — unknown kind ${r.watchlistKind}`);
            continue;
        }
        if (!byKind.has(k)) byKind.set(k, []);
        byKind.get(k)!.push(r);
    }

    const totals = emptyStats();
    for (const [kind, rows] of byKind) {
        const s = await recoverOneKind(kind, rows, opts);
        totals.probed += s.probed;
        totals.alive += s.alive;
        totals.closed += s.closed;
        totals.unknown += s.unknown;
        totals.reopened += s.reopened;
        totals.reopenedAsTracked += s.reopenedAsTracked;
        totals.reopenedAsNew += s.reopenedAsNew;
    }

    console.log("\n══ summary ══");
    console.log(`probed:               ${totals.probed}`);
    console.log(`  alive:              ${totals.alive}`);
    console.log(`  closed (confirmed): ${totals.closed}`);
    console.log(`  unknown:            ${totals.unknown}`);
    if (opts.apply) {
        console.log(`reopened:             ${totals.reopened} (${totals.reopenedAsTracked} → tracked, ${totals.reopenedAsNew} → new)`);
    } else {
        console.log(`would reopen:         ${totals.reopened} (${totals.reopenedAsTracked} → tracked, ${totals.reopenedAsNew} → new)`);
        console.log("\nRe-run with --apply to commit.");
    }
}

main()
    .catch(e => {
        console.error("Unhandled error:", e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
