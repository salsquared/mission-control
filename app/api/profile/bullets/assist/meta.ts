import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Generates AI bullet suggestions for a profile entry — fill mode drafts starter bullets, rewrite mode revises one bullet, tags mode proposes skill tags — without persisting; the client accepts via the entity PATCH.",
    external: ["Gemini"],
    notes: "Grounds the LLM call on sibling bullets, prior-upload archive spans, and the entity scratchpad; per-user rate-limited at 20/10min.",
};
