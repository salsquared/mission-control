import { prisma } from '@/lib/prisma';
import type { ProfileSnapshot } from '@prisma/client';
import { findOrCreateProfile, type HydratedProfile } from '@/lib/repositories/profile';

// Story S7.6 — point-in-time captures of a user's profile. Button-triggered
// only (no auto-snapshot on every edit). The payload column stores the full
// HydratedProfile (Profile + workRoles + projects + education with parsed
// bullets) as JSON so a future rollback can restore exactly what was on
// screen. Rollback isn't wired yet; this is read-only safety-net wiring.

export interface SnapshotSummary {
    id: string;
    takenAt: Date;
    label: string | null;
}

export interface HydratedSnapshot extends SnapshotSummary {
    payload: HydratedProfile;
}

function toSummary(row: Pick<ProfileSnapshot, 'id' | 'takenAt' | 'label'>): SnapshotSummary {
    return { id: row.id, takenAt: row.takenAt, label: row.label };
}

export async function createProfileSnapshot(
    userId: string,
    label?: string | null,
): Promise<SnapshotSummary> {
    const profile = await findOrCreateProfile(userId);
    const row = await prisma.profileSnapshot.create({
        data: {
            userId,
            label: label ?? null,
            payload: JSON.stringify(profile),
        },
        select: { id: true, takenAt: true, label: true },
    });
    return toSummary(row);
}

export async function listProfileSnapshots(userId: string): Promise<SnapshotSummary[]> {
    const rows = await prisma.profileSnapshot.findMany({
        where: { userId },
        select: { id: true, takenAt: true, label: true },
        orderBy: { takenAt: 'desc' },
    });
    return rows.map(toSummary);
}

export async function getProfileSnapshot(
    userId: string,
    id: string,
): Promise<HydratedSnapshot | null> {
    const row = await prisma.profileSnapshot.findFirst({
        where: { id, userId },
        select: { id: true, takenAt: true, label: true, payload: true },
    });
    if (!row) return null;
    let payload: HydratedProfile;
    try {
        payload = JSON.parse(row.payload) as HydratedProfile;
    } catch (e) {
        // Corrupt JSON — surface as not-found rather than crashing the route.
        // Should never happen because we always write JSON.stringify output,
        // but defensive: a hand-edited row shouldn't 500 the API.
        console.error('[profile-snapshots] payload parse failed', { id, userId, e });
        return null;
    }
    return { id: row.id, takenAt: row.takenAt, label: row.label, payload };
}

export async function deleteProfileSnapshot(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.profileSnapshot.findFirst({
        where: { id, userId },
        select: { id: true },
    });
    if (!existing) return false;
    await prisma.profileSnapshot.delete({ where: { id } });
    return true;
}
