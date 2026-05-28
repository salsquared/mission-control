import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Fires a self-addressed test notification through the in-app + Gmail send pipeline to verify the email side-channel works.",
    external: ['Gmail API v1'],
    notes: "Per-user 30s rate limit; email only actually sends when EMAIL_ENABLED=1.",
};
