import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Drafts (or enhances an existing) profile tagline from the session user's profile via the LLM, returning a transient proposal the client persists on accept.",
    external: ["Gemini"],
    notes: "Does not persist; per-user rate-limited at 10/10min.",
};
