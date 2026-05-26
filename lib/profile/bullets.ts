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
        return parsed.filter(isBulletShape).map(hydrateBulletDefaults);
    } catch {
        return [];
    }
}

export function serializeBullets(bullets: Bullet[]): string {
    return JSON.stringify(bullets);
}

export function newBulletId(): string {
    // Uses globalThis.crypto.randomUUID — supported in Node 19+ and all
    // modern browsers, so card components can mint client-side ids during
    // optimistic updates without a server round-trip.
    return 'b_' + globalThis.crypto.randomUUID();
}

// Build a fresh bullet from text + optional tags. Defaults locked/excluded to false.
export function makeBullet(text: string, tags: string[] = []): Bullet {
    return { id: newBulletId(), text, tags, autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false };
}

// Structural check — accepts bullets written before M8.5.1 (no autoTags /
// removedTags fields) and M7.7.1 (no pinnedTags). The hydrateBulletDefaults
// step downstream fills in the new fields with `[]`, so callers always see
// the full Bullet shape.
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

// Default-fallback the M8.5.1 + M7.7.1 fields on legacy bullets parsed from
// JSON written before those fields existed. Idempotent — bullets that already
// have valid arrays pass through unchanged.
function hydrateBulletDefaults(bullet: Bullet): Bullet {
    return {
        ...bullet,
        autoTags: Array.isArray(bullet.autoTags) ? bullet.autoTags : [],
        removedTags: Array.isArray(bullet.removedTags) ? bullet.removedTags : [],
        pinnedTags: Array.isArray(bullet.pinnedTags) ? bullet.pinnedTags : [],
    };
}

// Normalize an incoming bullet payload from an API write: stamp an id if
// missing, coerce missing fields to safe defaults. Lets the UI send `{text}`
// for a brand-new bullet without filling in tags/locked/excluded.
export function normalizeBullet(input: Partial<Bullet> & { text: string }): Bullet {
    return {
        id: input.id || newBulletId(),
        text: input.text,
        tags: input.tags ?? [],
        autoTags: input.autoTags ?? [],
        removedTags: input.removedTags ?? [],
        pinnedTags: input.pinnedTags ?? [],
        locked: input.locked ?? false,
        excluded: input.excluded ?? false,
    };
}
