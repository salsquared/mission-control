/**
 * Colocated prose for the API-doc generator (`scripts/gen-api-docs.ts`).
 *
 * The generator derives everything *structural* about a route from the code
 * itself — HTTP methods, auth guard, `withCache` TTL/upstream, and the Zod
 * request schema (via `z.toJSONSchema`). The only things it can't infer are
 * INTENT: what the route is for and which external service it talks to.
 *
 * Put that intent in a `meta.ts` file **next to** the route (e.g. for
 * `app/api/ai/route.ts` create `app/api/ai/meta.ts`):
 *
 *   import type { ApiMeta } from '@/lib/api-docs/meta';
 *
 *   export const apiMeta: ApiMeta = {
 *     purpose: 'One sentence on what this route does.',
 *     external: ['Gmail API v1', 'Gemini'],   // omit / [] for DB-only routes
 *   };
 *
 * It lives in the route's own folder, so it gets updated in the same PR as the
 * code — that's the whole point (the old `docs/apis.md` rotted precisely
 * because it lived far from the routes it described).
 *
 * Why a sibling file and NOT an export from `route.ts`: Next.js validates the
 * named exports of a route module (its generated `.next/types/**\/route.ts`
 * uses an `OmitWithTag<…, "">` check), so an unknown `apiMeta` export there is
 * a build/`tsc` error. A `meta.ts` sibling isn't a route file, so it escapes
 * that validation. It's also never imported by runtime code, so Next never
 * bundles it.
 *
 * The literal is read STATICALLY by the generator (parsed, not executed), so
 * it must be a plain literal: strings, numbers, booleans, arrays, and nested
 * object literals only — no function calls, spreads, or imported constants.
 */
export interface ApiMeta {
  /** One-sentence statement of what the route does. Required. */
  purpose: string;
  /**
   * External services the route consumes. Plain labels, e.g.
   * `['Hacker News Algolia API']` or `['Gmail API v1', 'Gemini']`.
   * Omit or leave empty for database-only / pure-computation routes.
   */
  external?: string[];
  /** Optional extra prose — caveats, gotchas, links to deeper docs. */
  notes?: string;
  /**
   * Optional per-method overrides. Keys are HTTP verbs. Use when one verb on a
   * multi-method route needs its own purpose/external (e.g. GET reads the DB
   * but POST hits Google Calendar).
   */
  methods?: Partial<Record<'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', { purpose?: string; external?: string[] }>>;
}
