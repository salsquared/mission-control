import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// One row of the owner-only crew table (docs/multi-user-crew.html P7).
// `role` is echoed rather than assumed: the list includes the OWNER row so the
// UI can render the exactly-one-owner invariant (OQ4a) instead of hiding it,
// and so a second owner — which would be a real incident — is visible rather
// than silently filtered out of the page meant to show who has access.
//
// There is deliberately NO "added on" field: `User` has no `createdAt` column
// (the NextAuth adapter never needed one), and deriving a date from the cuid's
// embedded timestamp would be a guess rendered as a fact. If provisioning dates
// are ever wanted, that is a migration, not a serializer change.
export const CrewMemberSchema = z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: z.string(),

    // Usage counters. Both are what this person costs the OWNER, which is the
    // question the page exists to answer — they spend the owner's Gemini key
    // (lib/ai/quota.ts) and the owner's single outbound IP (the scheduler's
    // crawls). `aiUsedToday` is the CURRENT UTC day's bucket only, matching the
    // window the 429 enforces, so a number here lines up with what that person
    // is actually seeing.
    aiUsedToday: z.number().int(),
    watchlistCount: z.number().int(),
    applicationCount: z.number().int(),
});
export type CrewMember = z.infer<typeof CrewMemberSchema>;

export const CrewListResponseSchema = z.object({
    crew: z.array(CrewMemberSchema),
    // The per-crew daily AI allowance in force right now, so the UI can render
    // "3 / 20" rather than a bare count. Re-read per request by
    // lib/ai/quota.ts:crewAiDailyLimit(), so it can change without a deploy.
    aiDailyLimit: z.number().int(),
    // Surfaced so the page can shout if it is ever not 1 (OQ4a).
    ownerCount: z.number().int(),
});

// ─── Create ────────────────────────────────────────────────────────────────
// Email ONLY. There is deliberately no `role` field: accepting one would make
// this route able to mint an owner, which is the single thing both provisioning
// surfaces are built to prevent (lib/crew/core.ts). Zod cannot express "reject
// unknown keys" and "never mint an owner" as the same rule, so `.strict()`
// carries the first half and the absence of the field carries the second.
export const CrewCreateSchema = z.object({
    email: z.string().min(3).max(320),
}).strict();

// ─── Delete ────────────────────────────────────────────────────────────────
// The id names the row; `confirmEmail` is what the human typed into the modal.
// The server asserts the two agree BEFORE deleting, so a stale list, a race, or
// a UI bug cannot delete a different person than the one the confirmation
// dialog named. This is belt-and-braces on an irreversible cascading delete —
// the CLI's equivalent friction is `--confirm-delete`.
export const CrewDeleteSchema = z.object({
    confirmEmail: z.string().min(3).max(320),
}).strict();

// ─── Response envelopes ────────────────────────────────────────────────────
export const CrewCreateResponseSchema = z.object({
    email: z.string(),
    role: z.string(),
});

export const CrewDeleteResponseSchema = z.object({
    email: z.string(),
    deletedFiles: z.number().int(),
    // Files the cascade could not unlink. NOT an error — the row is already
    // gone, so a failed request here would misreport a completed delete. The UI
    // surfaces these so the owner can sweep them by hand.
    orphanedFiles: z.array(z.string()),
});
