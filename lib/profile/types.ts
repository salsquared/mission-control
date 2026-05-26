// Bullet shape — stored as a JSON array inside WorkRole.bullets, Project.bullets,
// and Education.bullets. Each bullet has a stable id so the UI can lock/exclude
// and the resume-generation pipeline can cite "why this bullet was selected"
// (see §8 stories S8.1–S8.3).
//
// M8.5.1 added `autoTags` + `removedTags` (per user-stories.md Decision 6.1 + 6.3).
// `autoTags` is the subset of `tags` that the LLM auto-added during a resume
// generate (story S8.9) and the user hasn't yet "confirmed" by saving the
// bullet. The UI renders these with a Sparkles + cyan-border badge until next
// PATCH clears them. `removedTags` is a per-bullet blocklist — the auto-tag
// pass never proposes a keyword that's in this list, so removing a tag once
// makes it stick.
//
// M7.7.1 added `pinnedTags` (story S7.11). Pinned tags are user-anchored —
// the per-bullet AI-tag generator (S7.10) and the bulk auto-tag pass (S8.9)
// both treat them as immutable: never proposed for removal, never overwritten.
// Invariants enforced at the BulletWriteSchema layer: `pinnedTags ⊆ tags`
// (can't pin an unapplied tag) and `pinnedTags ∩ removedTags = ∅` (blocklist
// wins). All three array fields default to `[]` for back-compat.
export interface Bullet {
    id: string;
    text: string;
    tags: string[];
    autoTags: string[];
    removedTags: string[];
    pinnedTags: string[];
    locked: boolean;
    excluded: boolean;
}

// Profile JSON-column shapes. Live here (not in lib/repositories/profile) so
// client components can import the types without dragging the Prisma client
// into the browser bundle.
export interface ProfileLink {
    label: string;
    url: string;
}

export interface SkillGroup {
    category: string;
    items: string[];
}

// Ordered low → high so the UI radio renders left-to-right naturally.
// Wire/schema validation is order-independent.
export const LANGUAGE_PROFICIENCIES = ['Basic', 'Conversational', 'Professional', 'Fluent', 'Native'] as const;
export type LanguageProficiency = typeof LANGUAGE_PROFICIENCIES[number];

export interface LanguageEntry {
    name: string;
    proficiency: LanguageProficiency;
}
