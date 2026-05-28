import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Standard NextAuth.js handler; single Google provider with offline access plus the Gmail readonly/send and Calendar events scopes, storing the refresh token on the Account row.',
  external: ['Google OAuth 2.0'],
};
