import { prisma } from "@/lib/prisma";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";

export interface BlacklistEntry {
    id: string;
    name: string;
    normalizedName: string;
    reason: string | null;
    createdAt: string;
}

function serialize(row: {
    id: string; name: string; normalizedName: string;
    reason: string | null; createdAt: Date;
}): BlacklistEntry {
    return {
        id: row.id,
        name: row.name,
        normalizedName: row.normalizedName,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
    };
}

export async function listBlacklist(userId: string): Promise<BlacklistEntry[]> {
    const rows = await prisma.blacklistedCompany.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
    });
    return rows.map(serialize);
}

export type AddBlacklistResult =
    | { ok: true; entry: BlacklistEntry }
    | { ok: false; reason: "empty" | "duplicate" };

export async function addToBlacklist(
    userId: string,
    rawName: string,
    reason: string | null,
): Promise<AddBlacklistResult> {
    const name = rawName.trim();
    if (!name) return { ok: false, reason: "empty" };
    const normalizedName = normalizeCompanyName(name).toLowerCase();
    if (!normalizedName) return { ok: false, reason: "empty" };

    try {
        const row = await prisma.blacklistedCompany.create({
            data: { userId, name, normalizedName, reason },
        });
        return { ok: true, entry: serialize(row) };
    } catch (e) {
        // P2002 = unique-constraint violation on (userId, normalizedName).
        // Treat as soft success from the caller's POV — surface the existing
        // entry so the UI can reflect it.
        if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002") {
            const existing = await prisma.blacklistedCompany.findUnique({
                where: { userId_normalizedName: { userId, normalizedName } },
            });
            if (existing) return { ok: true, entry: serialize(existing) };
        }
        throw e;
    }
}

export async function removeFromBlacklist(userId: string, id: string): Promise<boolean> {
    const result = await prisma.blacklistedCompany.deleteMany({
        where: { id, userId },
    });
    return result.count > 0;
}

export async function blacklistedNormalizedNames(userId: string): Promise<Set<string>> {
    const rows = await prisma.blacklistedCompany.findMany({
        where: { userId },
        select: { normalizedName: true },
    });
    return new Set(rows.map(r => r.normalizedName));
}
