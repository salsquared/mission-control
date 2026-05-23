import { z } from 'zod';

// Story 50 — recruiter / hiring-manager contacts per application. Optional
// (cold portal applies have none). Stored bare on Contact rows; the stale-
// nudge scheduler reads the most-recent contact (by lastTouchedAt, then
// position) to make the follow-up suggestion personal.

const NAME_MAX = 200;
const EMAIL_MAX = 320; // RFC 5321 limit; SQLite has no per-column cap so this is purely a sanity guard.
const ROLE_MAX = 100;
const NOTES_MAX = 4_000;

export const ContactSchema = z.object({
    id: z.string(),
    applicationId: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    role: z.string().nullable(),
    notes: z.string().nullable(),
    lastTouchedAt: z.string().datetime().nullable(),
    position: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

// Email is intentionally non-strict (z.string(), not .email()) — recruiter
// scribbles like "alice (talent)" or pasted "Alice Smith <alice@…>" can show
// up before the user cleans them up. We don't gate creation on RFC parseability.
// We do trim and cap length so storage stays sane.
export const ContactPostSchema = z.object({
    applicationId: z.string().min(1),
    name: z.string().min(1).max(NAME_MAX),
    email: z.string().max(EMAIL_MAX).nullable().optional(),
    role: z.string().max(ROLE_MAX).nullable().optional(),
    notes: z.string().max(NOTES_MAX).nullable().optional(),
    lastTouchedAt: z.string().datetime().nullable().optional(),
    position: z.number().int().optional(),
});

export const ContactPatchSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(NAME_MAX).optional(),
    email: z.string().max(EMAIL_MAX).nullable().optional(),
    role: z.string().max(ROLE_MAX).nullable().optional(),
    notes: z.string().max(NOTES_MAX).nullable().optional(),
    lastTouchedAt: z.string().datetime().nullable().optional(),
    position: z.number().int().optional(),
}).refine(
    (d) => Object.keys(d).length > 1, // 'id' alone is not enough
    { message: 'At least one mutable field must be provided alongside id' },
);

export const ContactDeleteSchema = z.object({ id: z.string().min(1) });

export const ContactsListResponseSchema = z.object({
    contacts: z.array(ContactSchema),
});
export const ContactMutationResponseSchema = z.object({
    contact: ContactSchema,
});
export const ContactDeleteResponseSchema = z.object({
    success: z.literal(true),
    id: z.string(),
});

export type ContactWire = z.infer<typeof ContactSchema>;
