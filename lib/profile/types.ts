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
// makes it stick. Both default to `[]` for back-compat with bullets written
// before this migration.
export interface Bullet {
    id: string;
    text: string;
    tags: string[];
    autoTags: string[];
    removedTags: string[];
    locked: boolean;
    excluded: boolean;
}
