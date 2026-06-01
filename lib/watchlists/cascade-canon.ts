import { prisma } from "@/lib/prisma";
import { deleteCanon } from "@/lib/repositories/canons";

/**
 * "Last-one-out" canon cleanup, fired after a watchlist is deleted.
 *
 * A SIDE canon is seeded one-per-side-watchlist (scripts/seed-side-canons.ts)
 * and the watchlist points at it via Watchlist.canonId. Users expect deleting
 * the watchlist to also retire its canon — but a single side canon can feed
 * MULTIPLE watchlists (the LinkedIn + Indeed halves of one Find-Roles search
 * share one canon by slug). So we only delete the canon when NO watchlist still
 * references it — i.e. the just-deleted watchlist was the last one out.
 *
 * Scope is SIDE-only by design: career canons are hand-authored and valuable,
 * so we never auto-delete one just because a linked watchlist was removed.
 *
 * Deleting the canon is FK-safe: Watchlist.canon / GeneratedResume.canon /
 * Application.canon are all `onDelete: SetNull`, so generated resumes (and any
 * applications) SURVIVE — they stay findable in the Generated Resumes card,
 * with their `canonId` nulled. Nothing is hard-deleted except the canon row.
 *
 * Call AFTER the watchlist row is deleted (so the count below excludes it).
 * Best-effort: callers should not fail the watchlist delete if this throws.
 *
 * @returns the canonId that was deleted, or null if nothing was deleted.
 */
export async function deleteOrphanedSideCanon(
    userId: string,
    canonId: string | null | undefined,
): Promise<string | null> {
    if (!canonId) return null;

    // Confirm the canon exists, is owned, and is a side canon. Career canons
    // are never auto-deleted (see doc comment).
    const canon = await prisma.canon.findFirst({
        where: { id: canonId, userId },
        select: { id: true, track: true },
    });
    if (!canon || canon.track !== "side") return null;

    // Any other watchlist still feeding this canon? (The deleted row is already
    // gone, so a count of 0 means we were the last one out.) Race-safe under the
    // concurrent Find-Roles group delete: each DELETE counts AFTER its own row
    // is gone, so whichever request finishes last always observes 0 and deletes
    // the canon; deleteMany makes a duplicate delete a harmless no-op.
    const remaining = await prisma.watchlist.count({ where: { userId, canonId } });
    if (remaining > 0) return null;

    const deleted = await deleteCanon(userId, canonId);
    return deleted ? canonId : null;
}
