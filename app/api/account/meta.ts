import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: "Returns the calling viewer's identity (id, email, role) and whether their Google account is connected with the required Gmail/Calendar scopes — the one route every client hits before rendering, and the frontend's replacement for useSession. Crew never connect Google, so googleConnected is permanently false for them.",
  external: [],
};
