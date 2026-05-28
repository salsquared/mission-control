import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Promotes a tracked job posting into a draft Application on the user's job-tracker board.",
    external: [],
    notes: "Dedups via postingId → sourceJobId → (company+role+track); returns created/merged flags.",
};
