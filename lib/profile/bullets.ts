import crypto from 'crypto';
import type { Bullet } from './types';

// JSON storage helpers for the `bullets` columns on WorkRole / Project / Education.
// The DB column is a TEXT column with a JSON array; these helpers keep the
// parse/serialize boundary explicit so route code never deals with the raw
// string form.

export function parseBullets(raw: string | null | undefined): Bullet[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isBulletShape);
    } catch {
        return [];
    }
}

export function serializeBullets(bullets: Bullet[]): string {
    return JSON.stringify(bullets);
}

export function newBulletId(): string {
    // Short, URL-safe, collision-resistant. Not a cuid (we don't need DB-style
    // ordering inside an array); 12 random base64url chars is fine for a
    // single-user dataset.
    return 'b_' + crypto.randomBytes(9).toString('base64url');
}

// Build a fresh bullet from text + optional tags. Defaults locked/excluded to false.
export function makeBullet(text: string, tags: string[] = []): Bullet {
    return { id: newBulletId(), text, tags, locked: false, excluded: false };
}

function isBulletShape(x: unknown): x is Bullet {
    if (!x || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    return (
        typeof o.id === 'string' &&
        typeof o.text === 'string' &&
        Array.isArray(o.tags) && o.tags.every((t) => typeof t === 'string') &&
        typeof o.locked === 'boolean' &&
        typeof o.excluded === 'boolean'
    );
}

// Normalize an incoming bullet payload from an API write: stamp an id if
// missing, coerce missing fields to safe defaults. Lets the UI send `{text}`
// for a brand-new bullet without filling in tags/locked/excluded.
export function normalizeBullet(input: Partial<Bullet> & { text: string }): Bullet {
    return {
        id: input.id || newBulletId(),
        text: input.text,
        tags: input.tags ?? [],
        locked: input.locked ?? false,
        excluded: input.excluded ?? false,
    };
}
