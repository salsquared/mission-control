/**
 * One-shot backfill: dedup tag arrays on every Bullet across WorkRole +
 * Project + Education, case-insensitively, keeping the first occurrence's
 * casing. Cleans up the legacy duplicate-casing data caused by the
 * `mergeAutoTagProposals` case-sensitive bug (fixed in auto-tag.ts).
 *
 * Touches each of: `tags`, `autoTags`, `removedTags`, `pinnedTags` —
 * separately. Cross-bucket conflicts (e.g. same tag case-insensitively in
 * both `tags` and `removedTags`) are NOT touched by default — the script
 * warns. Pass `--resolve-conflicts` to retroactively strip the lingering
 * tag from `tags` / `autoTags` / `pinnedTags` (it stays in `removedTags`).
 * Use this when the original X-click was meant to remove the tag entirely
 * but only its titlecase casing got removed pre-fix.
 *
 * Usage:
 *   # Dev DB
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/dedupe-bullet-tag-casings.ts --dry-run
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/dedupe-bullet-tag-casings.ts --apply
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/dedupe-bullet-tag-casings.ts --resolve-conflicts --dry-run
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/dedupe-bullet-tag-casings.ts --resolve-conflicts --apply
 *
 *   # Prod DB — same pattern, swap to file:./prod.db.
 *
 * Default is dry-run if neither --apply nor --dry-run is passed. The
 * --resolve-conflicts flag stacks with either mode. After running
 * successfully on both tiers, move this file into `scripts/archive/migrations/`.
 */

import { prisma } from '@/lib/prisma';

interface DedupeStats {
    table: string;
    rowsScanned: number;
    rowsWritten: number;
    bulletsScanned: number;
    bulletsTouched: number;
    tagsDroppedByBucket: Record<TagBucket, number>;
    crossBucketConflicts: number;
    conflictsResolved: number;
}

type TagBucket = 'tags' | 'autoTags' | 'removedTags' | 'pinnedTags';
const TAG_BUCKETS: TagBucket[] = ['tags', 'autoTags', 'removedTags', 'pinnedTags'];

function dedupCaseInsensitive(arr: unknown): { result: unknown[]; droppedItems: string[] } {
    if (!Array.isArray(arr)) return { result: [], droppedItems: [] };
    const seen = new Set<string>();
    const result: unknown[] = [];
    const droppedItems: string[] = [];
    for (const item of arr) {
        if (typeof item !== 'string') {
            // Preserve non-string entries verbatim — we can't dedup them
            // safely. parseBullets at app-read time will drop the whole
            // bullet if any tag isn't a string anyway, but a one-shot
            // backfill should never silently lose data.
            result.push(item);
            continue;
        }
        const lower = item.toLowerCase();
        if (seen.has(lower)) {
            droppedItems.push(item);
            continue;
        }
        seen.add(lower);
        result.push(item);
    }
    return { result, droppedItems };
}

interface BulletShape {
    id?: string;
    text?: string;
    tags?: unknown;
    autoTags?: unknown;
    removedTags?: unknown;
    pinnedTags?: unknown;
    [k: string]: unknown;
}

function dedupBullet(b: BulletShape, stats: DedupeStats, table: string, rowId: string): { changed: boolean; out: BulletShape } {
    const out: BulletShape = { ...b };
    let changed = false;
    for (const bucket of TAG_BUCKETS) {
        const original = b[bucket];
        const { result, droppedItems } = dedupCaseInsensitive(original);
        if (droppedItems.length > 0) {
            stats.tagsDroppedByBucket[bucket] += droppedItems.length;
            out[bucket] = result;
            changed = true;
            const originalLen = Array.isArray(original) ? original.length : 0;
            console.info(
                `  ${table}.${rowId} bullet=${b.id ?? '?'} ${bucket}: dropped ${droppedItems.length} dup (kept ${result.length}/${originalLen}) [removed: ${droppedItems.join(', ')}]`,
            );
        }
    }
    return { changed, out };
}

// Cross-bucket conflict handler. A tag whose lowercased form appears in
// both `tags` and `removedTags` is the residue of the pre-fix removeTag
// behavior (case-sensitive filter only removed one casing from tags but
// blocklisted the other). Two modes:
//   - 'log': warn + count; leave buckets alone (default).
//   - 'resolve': strip the conflicting tag from tags/autoTags/pinnedTags
//     case-insensitively; KEEP it in removedTags as the canonical blocklist.
//
// Defensive filter so a malformed mixed-type array can't crash via
// t.toLowerCase().
function safeStringSet(v: unknown): Set<string> {
    if (!Array.isArray(v)) return new Set();
    const s = new Set<string>();
    for (const x of v) if (typeof x === 'string') s.add(x.toLowerCase());
    return s;
}

function handleBulletConflicts(
    b: BulletShape,
    stats: DedupeStats,
    table: string,
    rowId: string,
    mode: 'log' | 'resolve',
): { changed: boolean; out: BulletShape } {
    const removedLower = safeStringSet(b.removedTags);
    if (removedLower.size === 0) return { changed: false, out: b };

    const tagsArr = Array.isArray(b.tags) ? b.tags : [];
    const conflictingTags: string[] = [];
    for (const t of tagsArr) {
        if (typeof t === 'string' && removedLower.has(t.toLowerCase())) {
            conflictingTags.push(t);
        }
    }
    if (conflictingTags.length === 0) return { changed: false, out: b };

    if (mode === 'log') {
        for (const t of conflictingTags) {
            stats.crossBucketConflicts++;
            console.warn(
                `  [CONFLICT] ${table}.${rowId} bullet=${b.id ?? '?'} — '${t}' is in BOTH tags + removedTags (case-insensitive). Leaving untouched; review manually.`,
            );
        }
        return { changed: false, out: b };
    }

    // mode === 'resolve' — strip the conflicting tag from tags/autoTags/
    // pinnedTags case-insensitively. removedTags stays as the canonical
    // blocklist so future auto-tag proposals continue to be blocked.
    const conflictLower = new Set(conflictingTags.map(t => t.toLowerCase()));
    const filterCaseInsens = (arr: unknown): unknown[] => {
        if (!Array.isArray(arr)) return [];
        return arr.filter(x => {
            if (typeof x !== 'string') return true; // preserve non-strings
            return !conflictLower.has(x.toLowerCase());
        });
    };

    const out: BulletShape = {
        ...b,
        tags: filterCaseInsens(b.tags),
        autoTags: filterCaseInsens(b.autoTags),
        pinnedTags: filterCaseInsens(b.pinnedTags),
    };

    stats.conflictsResolved += conflictingTags.length;
    console.info(
        `  ${table}.${rowId} bullet=${b.id ?? '?'} RESOLVED ${conflictingTags.length} conflict(s): removed [${conflictingTags.join(', ')}] from tags/autoTags/pinnedTags (still in removedTags blocklist)`,
    );

    return { changed: true, out };
}

async function dedupTable(
    table: 'workRole' | 'project' | 'education',
    apply: boolean,
    resolveConflicts: boolean,
): Promise<DedupeStats> {
    const stats: DedupeStats = {
        table,
        rowsScanned: 0,
        rowsWritten: 0,
        bulletsScanned: 0,
        bulletsTouched: 0,
        tagsDroppedByBucket: { tags: 0, autoTags: 0, removedTags: 0, pinnedTags: 0 },
        crossBucketConflicts: 0,
        conflictsResolved: 0,
    };

    let rows: { id: string; bullets: string }[];
    if (table === 'workRole') {
        rows = await prisma.workRole.findMany({ select: { id: true, bullets: true } });
    } else if (table === 'project') {
        rows = await prisma.project.findMany({ select: { id: true, bullets: true } });
    } else {
        rows = await prisma.education.findMany({ select: { id: true, bullets: true } });
    }

    for (const row of rows) {
        stats.rowsScanned++;
        let parsed: unknown[];
        try {
            const j = JSON.parse(row.bullets);
            if (!Array.isArray(j)) {
                console.warn(`  ${table}.${row.id} — bullets is not an array, skipping`);
                continue;
            }
            parsed = j;
        } catch (e) {
            console.warn(`  ${table}.${row.id} — bullets JSON parse failed: ${(e as Error).message}`);
            continue;
        }

        let rowChanged = false;
        // newBullets is typed loose because we preserve any malformed
        // entries verbatim — we don't want to corrupt them via spread.
        const newBullets: unknown[] = [];
        for (const b of parsed) {
            stats.bulletsScanned++;
            // Pass through anything that isn't a plain object — null,
            // strings, arrays, etc. The app's parseBullets drops these at
            // read time, but the backfill is conservative: leave the
            // shape alone so we don't introduce a silent data change.
            if (b === null || typeof b !== 'object' || Array.isArray(b)) {
                console.warn(`  ${table}.${row.id} — bullets[${stats.bulletsScanned}] is not a plain object (${JSON.stringify(b)?.slice(0, 80)}); passing through unchanged`);
                newBullets.push(b);
                continue;
            }
            const { changed: dedupChanged, out: dedupOut } = dedupBullet(b as BulletShape, stats, table, row.id);
            const { changed: conflictChanged, out: finalOut } = handleBulletConflicts(
                dedupOut,
                stats,
                table,
                row.id,
                resolveConflicts ? 'resolve' : 'log',
            );
            if (dedupChanged || conflictChanged) {
                stats.bulletsTouched++;
                rowChanged = true;
            }
            newBullets.push(finalOut);
        }

        if (rowChanged) {
            stats.rowsWritten++;
            if (apply) {
                const data = { bullets: JSON.stringify(newBullets) };
                if (table === 'workRole') await prisma.workRole.update({ where: { id: row.id }, data });
                else if (table === 'project') await prisma.project.update({ where: { id: row.id }, data });
                else await prisma.education.update({ where: { id: row.id }, data });
            }
        }
    }

    return stats;
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const apply = args.has('--apply');
    const explicitDryRun = args.has('--dry-run');
    const dryRun = explicitDryRun || !apply;
    const resolveConflicts = args.has('--resolve-conflicts');

    if (explicitDryRun && apply) {
        console.error('Pass either --dry-run or --apply, not both.');
        process.exit(2);
    }

    console.info(`Mode: ${apply ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}${resolveConflicts ? ' + RESOLVE-CONFLICTS' : ''}`);
    console.info(`DATABASE_URL: ${process.env.DATABASE_URL ?? '(unset)'}`);
    console.info('');

    const all: DedupeStats[] = [];
    for (const t of ['workRole', 'project', 'education'] as const) {
        console.info(`── ${t} ──`);
        const s = await dedupTable(t, apply, resolveConflicts);
        all.push(s);
        console.info(
            `  ${s.rowsScanned} rows scanned · ${s.bulletsScanned} bullets · ${s.bulletsTouched} bullets touched · ${s.rowsWritten} rows ${apply ? 'written' : 'would-write'}`,
        );
        console.info(
            `  dropped: tags=${s.tagsDroppedByBucket.tags} autoTags=${s.tagsDroppedByBucket.autoTags} removedTags=${s.tagsDroppedByBucket.removedTags} pinnedTags=${s.tagsDroppedByBucket.pinnedTags}`,
        );
        if (resolveConflicts) {
            if (s.conflictsResolved > 0) {
                console.info(`  ${s.conflictsResolved} conflict(s) resolved`);
            }
        } else if (s.crossBucketConflicts > 0) {
            console.warn(`  ${s.crossBucketConflicts} cross-bucket conflict(s) — see [CONFLICT] lines above (pass --resolve-conflicts to auto-strip from tags)`);
        }
        console.info('');
    }

    const totalDropped = all.reduce(
        (acc, s) => acc + s.tagsDroppedByBucket.tags + s.tagsDroppedByBucket.autoTags
            + s.tagsDroppedByBucket.removedTags + s.tagsDroppedByBucket.pinnedTags,
        0,
    );
    const totalConflicts = all.reduce((acc, s) => acc + s.crossBucketConflicts, 0);
    const totalResolved = all.reduce((acc, s) => acc + s.conflictsResolved, 0);
    console.info('── summary ──');
    console.info(`  ${totalDropped} duplicate tag(s) ${apply ? 'removed' : 'would be removed'} across all tables`);
    if (resolveConflicts) {
        console.info(`  ${totalResolved} cross-bucket conflict(s) ${apply ? 'resolved' : 'would be resolved'}`);
    } else if (totalConflicts > 0) {
        console.warn(`  ${totalConflicts} cross-bucket conflict(s) flagged for manual review (pass --resolve-conflicts to auto-strip)`);
    }
    if (!apply) {
        console.info('');
        console.info('Re-run with --apply to write the changes.');
    }

    await prisma.$disconnect();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
