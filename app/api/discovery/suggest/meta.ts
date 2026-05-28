import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Suggests new companies to watch for a given topic, excluding ones already in the directory, the user's watchlists, and their blacklist.",
    external: ['Gemini'],
    notes: "Results cached 6h keyed on topic + hashed exclude list; maps Gemini quota errors to a 429.",
};
