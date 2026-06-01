import { Prisma } from "@prisma/client";
import type { Canon } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeRoleName } from "@/lib/applications/normalize-role";
import type { CanonWire, CanonPostInput, CanonPatchInput, CanonSelection } from "@/lib/schemas/canons";
import { CanonSelectionSchema } from "@/lib/schemas/canons";

// Tolerant JSON-array parse for resumeEntityIds (mirrors settings.ts helpers).
function parseStringArray(json: string | null): string[] {
    if (!json) return [];
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export function serializeCanon(row: Canon, versionCount = 0): CanonWire {
    return {
        id: row.id,
        userId: row.userId,
        name: row.name,
        slug: row.slug,
        track: row.track as CanonWire["track"],
        description: row.description,
        keywords: row.keywords,
        onePage: row.onePage,
        currentResumeId: row.currentResumeId,
        resumeStale: row.resumeStale,
        resumeEntityIds: parseStringArray(row.resumeEntityIds),
        hasSelection: row.selection != null,
        versionCount,
        active: row.active,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

// Count canonical VERSIONS (isCanonical=true) per canon — excludes specialized
// children (isCanonical=false). One groupBy instead of N counts.
async function versionCounts(userId: string, canonIds: string[]): Promise<Map<string, number>> {
    if (canonIds.length === 0) return new Map();
    const grouped = await prisma.generatedResume.groupBy({
        by: ["canonId"],
        where: { userId, isCanonical: true, canonId: { in: canonIds } },
        _count: { _all: true },
    });
    const m = new Map<string, number>();
    for (const g of grouped) {
        if (g.canonId) m.set(g.canonId, g._count._all);
    }
    return m;
}

export async function listCanons(
    userId: string,
    opts?: { track?: "career" | "side" },
): Promise<CanonWire[]> {
    const rows = await prisma.canon.findMany({
        where: { userId, ...(opts?.track ? { track: opts.track } : {}) },
        orderBy: [{ track: "asc" }, { name: "asc" }],
    });
    const counts = await versionCounts(userId, rows.map((r) => r.id));
    return rows.map((r) => serializeCanon(r, counts.get(r.id) ?? 0));
}

export async function getCanon(userId: string, id: string): Promise<CanonWire | null> {
    const row = await prisma.canon.findFirst({ where: { id, userId } });
    if (!row) return null;
    const counts = await versionCounts(userId, [row.id]);
    return serializeCanon(row, counts.get(row.id) ?? 0);
}

// Raw row fetch (ownership-checked) for callers that need the entity itself —
// e.g. the resumes route building a synthetic posting from canon.keywords.
export async function getCanonRow(userId: string, id: string): Promise<Canon | null> {
    return prisma.canon.findFirst({ where: { id, userId } });
}

export async function createCanon(userId: string, input: CanonPostInput): Promise<CanonWire> {
    const row = await prisma.canon.create({
        data: {
            userId,
            name: input.name,
            slug: normalizeRoleName(input.name),
            track: input.track,
            keywords: input.keywords ?? "",
            description: input.description ?? null,
            onePage: input.onePage ?? true,
            // resumeStale defaults true — never generated yet.
        },
    });
    return serializeCanon(row, 0);
}

export async function updateCanon(
    userId: string,
    id: string,
    patch: CanonPatchInput,
): Promise<CanonWire | null> {
    const existing = await prisma.canon.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return null;

    const data: Prisma.CanonUpdateInput = {};
    if (patch.name !== undefined) {
        data.name = patch.name;
        data.slug = normalizeRoleName(patch.name);
    }
    if (patch.keywords !== undefined) {
        data.keywords = patch.keywords;
        // A keyword change invalidates the current resume (§6 Q7).
        data.resumeStale = true;
    }
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.onePage !== undefined) data.onePage = patch.onePage;
    if (patch.active !== undefined) data.active = patch.active;

    const row = await prisma.canon.update({ where: { id }, data });
    const counts = await versionCounts(userId, [id]);
    return serializeCanon(row, counts.get(id) ?? 0);
}

export async function deleteCanon(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.canon.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return false;
    await prisma.canon.delete({ where: { id } });
    return true;
}

// ─── Manual builder selection (docs/resume-manual-builder.html) ──────────────
// The per-Canon hand-curated selection lives in Canon.selection (JSON). Parsed
// leniently — corrupt/legacy JSON degrades to null (treated as "not curated").

export async function getCanonSelection(userId: string, id: string): Promise<CanonSelection | null> {
    const row = await prisma.canon.findFirst({ where: { id, userId }, select: { selection: true } });
    if (!row || row.selection == null) return null;
    try {
        return CanonSelectionSchema.parse(JSON.parse(row.selection));
    } catch {
        return null; // best-effort — corrupt JSON is treated as no selection
    }
}

export async function saveCanonSelection(
    userId: string,
    id: string,
    selection: CanonSelection,
): Promise<boolean> {
    const existing = await prisma.canon.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return false;
    await prisma.canon.update({ where: { id }, data: { selection: JSON.stringify(selection) } });
    return true;
}

// ─── Staleness (§6 Q7) ───────────────────────────────────────────────────────
// Entity-scoped: a canon goes stale only when an entity in its current resume's
// selection (resumeEntityIds) changes. resumeEntityIds is JSON, so we can't
// filter inside it in SQL — fetch the user's still-fresh canons and check
// membership in JS (N ≈ a handful). MUST be called from the profile-entity
// ROUTE handlers (work-roles / projects / education PATCH+DELETE), never the
// repo layer, so a gen-time auto-tag write can't self-stale.
export async function markCanonsStaleForEntity(userId: string, entityId: string): Promise<number> {
    const rows = await prisma.canon.findMany({
        where: { userId, resumeStale: false },
        select: { id: true, resumeEntityIds: true },
    });
    const staleIds = rows
        .filter((r) => parseStringArray(r.resumeEntityIds).includes(entityId))
        .map((r) => r.id);
    if (staleIds.length === 0) return 0;
    await prisma.canon.updateMany({ where: { id: { in: staleIds } }, data: { resumeStale: true } });
    return staleIds.length;
}

// ─── Generation persistence (§6 Q9 — P2.4) ───────────────────────────────────
// Next canonical version number for a canon (max existing version + 1).
export async function nextCanonVersion(canonId: string): Promise<number> {
    const top = await prisma.generatedResume.aggregate({
        where: { canonId, isCanonical: true },
        _max: { canonVersion: true },
    });
    return (top._max.canonVersion ?? 0) + 1;
}

// After a successful canon generate: point the canon at the new version, record
// its dependency set, clear stale. Call LAST (after the gen-time auto-tag
// write) so the canon can't self-stale.
export async function finalizeCanonGeneration(
    canonId: string,
    currentResumeId: string,
    resumeEntityIds: string[],
): Promise<void> {
    await prisma.canon.update({
        where: { id: canonId },
        data: {
            currentResumeId,
            resumeEntityIds: JSON.stringify(resumeEntityIds),
            resumeStale: false,
        },
    });
}
