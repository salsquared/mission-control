import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Parses one or more uploaded resume files into structured profile data and merges them into the session user's CV profile (append-never-overwrite), archiving each upload.",
    external: ["Gemini"],
    notes: "Per file: extract text → LLM-extract a tree → synthesize a master resume → deterministic merge; per-user rate-limited at 5/10min.",
};
