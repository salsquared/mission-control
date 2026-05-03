# Architecture Critique & Solution Menu

> **How to read this document.** Each section identifies a real, code-grounded weakness in the current architecture (cross-referenced to `docs/architecture.md` where relevant). Every numbered issue is followed by **three concrete solution options labeled (a), (b), (c)** with different cost/blast-radius/ambition profiles. Pick one option per issue using the form `<section>.<issue><letter>` (e.g. `1.1b`, `3.2a`). I will then write a follow-up document that turns the chosen set into a single coherent implementation plan.
>
> Solutions are designed so any combination is internally consistent. The (a) options are usually "minimum viable fix," (b) the recommended middle path, and (c) the most ambitious / structural change.

---

## 1. Security and Trust Boundaries

### 1.1 The Gmail Pub/Sub webhook is unauthenticated

`POST /api/gmail/webhook` decodes the Pub/Sub envelope and looks up the `User` row by the envelope's `emailAddress`. There is no signature or OIDC token check. Anyone who can reach the endpoint and knows the user's email can synthesize a payload that triggers a real Gmail history pull and DB write under the user's stored OAuth tokens (`docs/architecture.md` §11). Today this is mitigated by `localhost`-only binding, but the open todo to expose the server to LAN/Cloudflare-tunnel removes that mitigation.

- **(a) Shared-secret header.** Add a fixed `Authorization: Bearer <PUBSUB_WEBHOOK_SECRET>` env-driven check in the route. Cheap, ~10 lines, no Google-side config beyond setting the header on the push subscription.
- **(b) OIDC verification.** Configure the Pub/Sub push subscription to attach a Google-issued OIDC token, verify the JWT signature against Google's JWKS, and check the `aud` claim matches a configured value. This is the documented best practice and proves the request originated from your Pub/Sub topic.
- **(c) Pull-based instead of push.** Drop the inbound webhook entirely; run a small in-process worker (driven by `instrumentation.ts` or a side process) that pulls from the subscription on an interval and processes messages. No public surface to attack at all; cost is added latency and a long-lived auth client.

### 1.2 Calendar endpoint trusts a client-supplied `userId`

`/api/calendar/event` GET/POST/DELETE pulls `userId` from the query string / body and feeds it directly to `getGoogleAuthClient(userId)`. Any caller can pass any user id. On localhost-only this is moot; it becomes a privilege boundary the moment LAN access opens up.

- **(a) Drop the param, derive from session.** Remove `userId` from the API; call `getServerSession(authOptions)` and use `session.user.id`, matching what `/api/applications` already does.
- **(b) Authorize the param against the session.** Keep the `userId` param for flexibility but reject if it doesn't match the session user (or if no session). Adds belt-and-suspenders without restructuring callers.
- **(c) Move calendar reads to a server component.** Render upcoming events server-side (via React Server Components fed by `getGoogleAuthClient(session.user.id)`) and only expose mutating endpoints. Eliminates the param entirely and trims a network round-trip per dashboard load.

### 1.3 Several DB endpoints are globally unauthenticated

`/api/settings`, `/api/goals`, `/api/research/saved`, and `/api/tasks` accept reads and writes from any caller. They also operate on a single global record set (no `userId` filter on `LifeGoal`, `SavedPaper`, `Task`, `GlobalSetting`). For a single-user box this is fine; once exposed beyond localhost it becomes a free public CRUD surface.

- **(a) Wrap a thin auth helper.** Add `requireSession(req)` middleware-equivalent that returns 401 if no session; apply uniformly to these four routes. No schema changes; goals/tasks/saved-papers stay single-tenant in DB.
- **(b) Make models user-scoped.** Add `userId` to `LifeGoal`, `SavedPaper`, `Task`, `GlobalSetting`, backfill the existing rows to the current user, filter all queries on session user. Future-proofs for multi-user but is a meaningful migration.
- **(c) Defense in depth via a Next.js middleware matcher.** Broaden `middleware.ts` to gate every `/api/*` route except `/api/auth/*` and `/api/gmail/webhook` behind a session check. Single chokepoint, no per-route changes; cost is the matcher needs careful exclusions and middleware now does more than logging.

---

## 2. Data Integrity and Persistence

### 2.1 `app/api/settings/route.ts` constructs its own `PrismaClient`

That route does `const prisma = new PrismaClient()` instead of importing the shared client from `@/lib/prisma`. Consequences: it bypasses the `$allOperations` query-logging extension (so settings writes are invisible in the in-app log viewer), and on dev HMR it leaks new clients each reload because the `globalForPrisma` cache in `lib/prisma.ts` is bypassed.

- **(a) One-line fix.** Delete the `new PrismaClient()` and import `prisma` from `@/lib/prisma`. No other changes.
- **(b) Lint the pattern out.** Apply the (a) fix, then add an ESLint rule (or a custom no-restricted-imports) that forbids `new PrismaClient()` outside `lib/prisma.ts` so this can't recur.
- **(c) Centralize repository functions.** Apply (a), then move all `prisma.globalSetting.*` calls into a `lib/repositories/settings.ts` module so route handlers don't touch the ORM directly. Same pattern can grow to other models. Higher upfront cost; pays off when you want to add caching, validation, or a different store later.

### 2.2 The crypto time-series has user-traffic-dependent gaps

`/api/finance` writes a `CryptoPrice` row only on cache miss. If no one opens the FinanceView for a day, there's a hole in the time series. The seed scripts (`scripts/seed-crypto.ts`, `scripts/ingest-btc-history.ts`) exist as backstops but aren't scheduled; the FinanceView's history chart silently degrades.

- **(a) Cron-style ingester.** Add a `setInterval(fetchAndInsert, 5 * 60 * 1000)` in `instrumentation.ts` (Node-only branch) that hits CoinGecko independently of user requests. Lives inside the existing Next process, no new infra.
- **(b) PM2 secondary process.** Add a second PM2 entry (`mission-control-ingester`) running a small standalone Node script. Decouples ingestion from the web process, avoids competing for memory, gives PM2-native restart semantics. Documented in `hosting.md`.
- **(c) Push-based source of truth.** Stop opportunistic inserts entirely. Move BTC history to be served from a real time-series store (DuckDB file, ClickHouse local, or a dedicated SQLite table with an enforced 5-min cadence). The route just reads. Unifies the seed scripts + opportunistic insert + read paths into one ingestion pipeline.

### 2.3 Dev/prod databases drift independently

`prisma/dev.db` and `prisma/prod.db` share a schema but have no migration parity. Running `prisma migrate dev` only touches dev. Prod is patched ad hoc, which means a feature that works in dev can fail on prod startup if a migration didn't run there.

- **(a) Add a `migrate:prod` script.** A new `package.json` script: `"migrate:prod": "DATABASE_URL=file:./prisma/prod.db prisma migrate deploy"`, called from `launch-ms.sh` before `pm2 start`. Idempotent, near-zero cost.
- **(b) Single database file, two NODE_ENVs.** Drop `prod.db`; both `next dev` and `next start` point at the same `prisma/db.db`. Eliminates the divergence. Cost: dev experimentation now touches the same data the user actually relies on.
- **(c) Versioned schema with explicit promotion.** Treat `prisma/dev.db` as scratch; commit `prisma/migrations/` (already done by Prisma) and add a one-shot `npm run promote` that runs `prisma migrate deploy` against prod and a Prisma data-copy script for any seed/reference rows. Most disciplined; most overhead.

---

## 3. Resilience and Reliability

### 3.1 No automated tests

`scripts/tests/*` is a folder of one-off `tsx` scripts (`.agents/rules/scripts.md` enforces it as a convention). Critical paths — the markdown task parser, the cache wrapper, the company-registry strategy dispatch, the Gmail webhook parser — have zero regression coverage. The "frontend sessions interfere" issue in `todo.md:288` is a textbook symptom of untested concurrent state.

- **(a) Vitest on the parser + cache only.** Install `vitest`, write tests for `lib/tasks/parser.ts` (idempotent re-parse, ID injection, indent → parent) and `lib/cache.ts` (hit/miss/stale fallback). ~30 tests, highest-value paths first.
- **(b) Vitest + Playwright smoke.** (a), plus a Playwright suite that boots the app, loads each dash, and asserts the network request panel shows expected `/api/*` calls returning 200 within a budget. Catches whole-app regressions without unit-testing every component.
- **(c) Test contracts at every boundary.** (a) + (b), plus add Zod schemas for each API route's request and response (matching the patterns already in `lib/email-parser.ts`), and generate runtime-validated client SDK fns from them. Gives compile-time + runtime safety on the API surface and makes fetcher tests trivial.

### 3.2 HTML scrapers rot silently

`lib/fetchers/scrape-fetcher.ts` and the inline custom fetchers in `lib/company-registry.ts` rely on regexes against third-party HTML. When LM Arena, Anthropic, Cerebras, etc. redesign, the regex returns zero matches, the cache STALE-FALLBACKs forever, and nobody is told until the user notices a stale Internal Systems log.

- **(a) Fail-loud sentinel.** Each fetcher must return at least N items or throw `ScraperBrokenError(name, snippetLength)`; throw is logged at `error` level and surfaces in the InternalView log panel with red highlighting. No alerting, but the user sees it.
- **(b) Per-fetcher health table.** Add a `FetcherHealth` Prisma model (`name`, `lastOk`, `lastError`, `consecutiveFailures`). Every fetch updates the row; a new card on InternalView shows the table sorted by `consecutiveFailures DESC`. Operational visibility without external infra.
- **(c) Replace regex scrapers with a structured tool.** Migrate `scrape` and `custom` strategies onto a single library — either Cheerio with declarative selectors, or `@browserbasehq/stagehand`/headless Chrome for the truly hostile ones. Selector-based extraction breaks more loudly and is easier to fix than regex.

### 3.3 The in-process cache is unbounded

`lib/cache.ts` is a `Map<string, {data, expiry}>` with no size cap, no LRU eviction, and no thundering-herd dedup. Two simultaneous misses on the same key both run the handler. A bug that mints unique query strings (e.g. a client that includes `&now=<now>` in cache-key-relevant params) will grow the map until OOM.

- **(a) Add `lru-cache`.** Replace the bare `Map` with `lru-cache` capped at 500 entries / 64 MB. Drop-in API. Solves OOM; doesn't dedup concurrent misses.
- **(b) (a) plus in-flight dedup.** Track `Map<key, Promise<NextResponse>>` of pending fetches; second caller with the same key awaits the same promise. Eliminates herd. ~20 lines on top of (a).
- **(c) Move cache to durable storage.** SQLite-backed cache (a `CacheEntry` model with TTL), or a small embedded KV store. Survives restarts (today the cache is cold for ~30 s after every PM2 reload). Cost: synchronous DB hit on every request, mitigated by an in-memory L1 in front.

---

## 4. Observability

### 4.1 The log ring buffer is lost on restart

`lib/logger.ts` keeps the last 500 entries on `globalThis`. Every restart of the dev server, every PM2 reload, every redeploy starts fresh. Post-mortem debugging an incident the user noticed an hour ago is impossible — the relevant logs are gone.

- **(a) Append to a rotating file.** Tee everything in `addLog` to `logs/system-<YYYY-MM-DD>.log`, rotate daily, retain 30 days. Read from disk on `getLogs()` for entries older than the buffer.
- **(b) SQLite-backed log model.** A `Log` Prisma model with `id, level, ts, message`. Insert on every `addLog` (batched every 1 s to avoid write amplification). The log viewer can now scroll back arbitrarily far and filter by level or time range.
- **(c) Pipe to PM2's log file with structured output.** Drop the in-process buffer; emit JSON-lines to stdout, let PM2 capture them in `~/.pm2/logs/*`, and have InternalView read those files via a new `/api/system/logs/historical?from=...` endpoint. Reuses PM2's log rotation (already configured in prod).

### 4.2 No fetcher / external-API health surface

The cache does log `[CACHE FALLBACK]` lines, but they're indistinguishable from normal noise unless the user catches them on screen. There is no aggregate view of "which external APIs have been failing today."

- **(a) Dashboard tile.** Compute hit/miss/stale-fallback ratios from the existing log buffer and render a single tile on InternalView showing the last hour's per-host failure rate. No new persistence; just aggregation.
- **(b) `/api/system/fetchers` endpoint.** Track fetcher health in-process with a small struct keyed by host; expose as a JSON endpoint for InternalView and for any future external observer.
- **(c) Open-source observability.** Stand up a local OpenTelemetry collector or PostHog instance and emit traces for every `withCache` invocation and external fetch. Gives flame graphs, percentile latencies, and per-host error rates for free; cost is a second process and a bit of metric plumbing.

### 4.3 No alert path when something is broken

There is no surface that says "your data is stale because the upstream is down." The user notices because a card looks weird.

- **(a) Toast on every X-Cache: STALE-FALLBACK.** The frontend reads the response header and shows a transient toast naming the affected feed. Cheap; can be ignored.
- **(b) Persistent banner in InternalView.** When any fetcher has been failing >1 h, a yellow banner appears on the Internal Systems dash listing the dead feeds. Backed by 4.2's tracking.
- **(c) Outbound notification.** A Pushover/ntfy.sh/Discord webhook hit when failure rate crosses a threshold. Reaches the user even when they're not on the dashboard. Requires a notification channel (already a planned feature in `todo.md`).

---

## 5. Frontend Data Layer

### 5.1 Every view manually wires `useEffect` + `fetch`

There is no shared client-side cache. SpaceView, AIView, PhysicsView all call overlapping `/api/research/*` endpoints; switching between them re-fetches. The same is true of `/api/company-news` calls keyed by company id. The server-side `withCache` saves the upstream API but not the client's bandwidth or the load-time spinner.

- **(a) Adopt SWR.** Lightweight, fits the existing `fetch`-everywhere style. Replace `useEffect`+`fetch` patterns with `useSWR(key, fetcher)`. ~1 day of diff. Gives dedup, focus revalidation, and stale-while-revalidate on the client.
- **(b) Adopt TanStack Query.** Heavier than SWR but gives mutations, optimistic update primitives, devtools, and a richer cache model. Worth it because optimistic updates are already hand-rolled in PlanningView and SavedPapersOverlay; TanStack would replace ~100 lines of state management.
- **(c) Server Components + RSC streaming.** Keep `app/page.tsx` client-side for the dashboard shell, but make each view a Server Component that fetches on the server and streams to the client. Eliminates the client fetch entirely for read paths; mutations stay client-side. Biggest architectural shift; aligns with Next 16 idioms.

### 5.2 AICompanion is a stub the UI advertises as real

`components/AICompanion.tsx` returns a hardcoded mock response from a `setTimeout`. The Dashboard's bottom nav, the activeContext prop wiring, and even the welcome copy ("Systems online. Monitoring all frequencies.") all suggest a working assistant. The Gemini infrastructure already exists in `lib/email-parser.ts`.

- **(a) Hide it behind a feature flag.** Use the existing `settingsStore` (`backgroundTasks` is unused; rename to `aiCompanionEnabled`), default off. Stops promising functionality that doesn't exist; preserves the UI for future work.
- **(b) Wire to a `/api/ai/chat` streaming route.** New route using `streamText` from the `ai` SDK with `google("gemini-3.0-flash")`. Pass `activeContext` into the system prompt. Maintain message history client-side only initially. ~half a day of work.
- **(c) Context-aware agent with tool use.** (b), plus expose a few read-only tools the model can call (`getRecentLaunches`, `getUpcomingEvents`, `getTasks`) bound to the existing API routes via the AI SDK's tool feature. The companion can answer "what's my next interview?" or "summarize today's papers." Higher cost; usable result.

### 5.3 Cross-tab interference is a known unresolved bug

`docs/todo.md:288` records the bug that two browser sessions interfere. This is structural: every PATCH writes the markdown file *and* the DB; both tabs poll independently and lose each other's changes if they refresh at the wrong moment. The optimistic UI on each tab amplifies the issue.

- **(a) Single-flight via BroadcastChannel.** All same-origin tabs share a `BroadcastChannel('mc-state')`; mutations broadcast `{type, id, status}` and other tabs apply the change locally without refetching. Cheap, no server changes.
- **(b) SSE invalidation channel.** Add `/api/events` SSE that broadcasts `{model: 'Task', id, action}` from the server every time PATCH/POST runs. Frontend invalidates SWR/TanStack keys on receipt. Generalizes to all models.
- **(c) Replace polling with realtime.** Adopt a small realtime layer (libSQL with Cloudflare-style listen, or `electric-sql` over the existing SQLite) so the client reactively renders the DB. Eliminates the file/DB ↔ UI desync entirely. Largest scope.

---

## 6. State Management and Sync

### 6.1 `themeStore` syncs to `/api/settings` on every change

`ThemeProvider.tsx` subscribes to the entire `themeStore` and POSTs the diff on any change. During an active drag in LaunchpadOverlay this could fire many times — though LaunchpadOverlay deliberately uses local state until `dragend` to mitigate this. There's still a hot loop available: editing a dash title via the input element causes one POST per keystroke.

- **(a) Debounce the sync.** Wrap the subscribe handler in a 500 ms debounce. Trivial; prevents keystroke-storm POSTs.
- **(b) Explicit save points.** Drop the auto-sync; `setDashTitle`/`setDashOrder`/`setIsDarkMode` each become "stage local; save on blur or explicit Done button." LaunchpadOverlay already has a Done button; reuse the pattern.
- **(c) Optimistic concurrency.** Each `GlobalSetting` row carries a `version`; ThemeProvider sends `If-Match: <version>` and the server rejects stale writes. Useful only if §1.3(b) is taken (multi-user scope); overkill alone.

### 6.2 `GlobalSetting` is one row of stringly-typed JSON

`prisma/schema.prisma:GlobalSetting` is a single row keyed `"global"` with a `data: String` (JSON). No schema, no per-user split, no migration story for the JSON shape. If you rename a key, old data is silently ignored.

- **(a) Versioned JSON envelope.** Bump the saved JSON to `{ schemaVersion: 1, data: {...} }` and run a migration step on read. Add `parseGlobalSetting()` in `lib/repositories/settings.ts` that reshapes by version.
- **(b) Zod schema at the boundary.** Define `GlobalSettingsSchema` in Zod, parse on every read, fall back to defaults on parse failure. Tighter contract; doesn't fix per-user.
- **(c) Promote to columns.** Replace the JSON blob with explicit columns (`isDarkMode`, `viewHues`, `dashOrder`, `dashTitles`, all typed). Pair with §1.3(b) for `userId` scoping. Most disciplined; most schema churn.

### 6.3 Mixed persistence rules across stores

`themeStore` syncs to `/api/settings` (DB), `settingsStore` persists to `localStorage`, the active dash id goes to `localStorage` directly, NextAuth session lives in cookies, and Prisma owns the rest. There's no documented rule for "where does X live." The architecture review reverse-engineered the policy ("device-local vs cross-device") but it's not encoded anywhere.

- **(a) Add a "Persistence" doc.** One-page `docs/persistence.md` listing each store, what it holds, where it lives, and why. No code changes; future contributors (and future-Claude) have a reference.
- **(b) Codify with helpers.** Create `useDeviceLocalState(key, default)` and `useCrossDevicePref(key, default)` wrappers that internally route to localStorage vs `/api/settings` and replace the ad-hoc Zustand stores. Hides the divergence.
- **(c) Single-source-of-truth store.** One Zustand store with per-key persistence policy declared in metadata; a shim layer routes each key to the right backend. Most invasive; pays off only if the prefs surface keeps growing.

---

## 7. Background Work and Scheduling

### 7.1 No scheduler — everything is opportunistic or user-driven

There is no scheduled task surface. Crypto ingestion happens when someone visits FinanceView. Weekly paper picks happen the first time someone opens the AI/Physics view that week. The `todo.md`-noted notification feature has no place to live. The Claude Code `/loop` and `/schedule` slash commands are the de facto scheduler today.

- **(a) `setInterval` in `instrumentation.ts`.** Add a `startSchedules()` function called from the Node-only branch of the register hook, with declarative entries (`{ name, intervalMs, fn }`). Survives within the lifetime of the Next process.
- **(b) Dedicated `mission-control-scheduler` PM2 process.** A new top-level `scheduler.ts` script that PM2 keeps alive separately. Imports the same `lib/` code as the web process. Won't compete with the request thread; can be restarted independently; its own log.
- **(c) Cron + tunnel-triggered jobs.** Use macOS `launchd` or `cron` to hit dedicated `/api/jobs/<name>` routes on a schedule (with auth from §1.x). Job code lives in the web app; scheduling lives in the OS. Most "ops"-flavored; survives Node-process crashes.

### 7.2 No request-coalescing for hot keys

If two views open simultaneously and both miss the cache for `/api/research?topic=ai&timeframe=yesterday`, both run the (slow) Hugging Face → arXiv → Semantic Scholar fan-out. See §3.3(b) for the cache-side fix; this is the question of whether the *client* should also cooperate.

- **(a) Server-side dedup only.** Cover this exclusively via §3.3(b)'s in-flight dedup. Frontend stays naive.
- **(b) Client-side dedup via SWR/TanStack.** Adopt §5.1(a/b); both libraries dedup by key automatically. Combined with server-side dedup this is fully herd-resistant.
- **(c) Unify under one cache layer.** Pull `withCache` and the client cache under a single notion (e.g. a `useCachedFetch(key, ttl, fetcher)` hook backed by the same underlying store). Most coherent; costs an abstraction layer.

---

## 8. Code Health and Developer Experience

### 8.1 `lib/company-registry.ts` mixes config, custom fetchers, and aliases

909 lines, growing. `fetchSpaceX`, `fetchOpenAI`, `fetchGroq`, `fetchCerebras`, `fetchMetaAI` live inline with the registry table. The aliases map (`'rocket-lab' → 'rocketlab'`) is at the bottom. New companies are easy to add but the file fights a "find anything" search.

- **(a) Split by file.** `lib/companies/registry.ts` (config table only), `lib/companies/custom-fetchers.ts` (the inline functions), `lib/companies/aliases.ts`. No code change; just better navigation.
- **(b) Custom fetchers as a directory.** `lib/companies/custom/spacex.ts`, `lib/companies/custom/groq.ts`, etc., each exporting a default function. The registry references them by import. Discoverable per company; trivial to test in isolation.
- **(c) Promote scrapers to a plugin contract.** Define a `CompanyAdapter` interface (`fetch`, `healthCheck`, `metadata`); each company is one file implementing it. Strategies become library functions an adapter can compose. Highest ceremony; opens the door to letting external authors contribute adapters.

### 8.2 No runtime validation on API request/response shapes

Only `lib/email-parser.ts` uses Zod. Every other API route trusts that `body.id`, `body.text`, etc. exist and have the right type. The `Task` PATCH route does several manual `if (!id || (!status && text === undefined && ...))` checks; the Calendar route does similar.

- **(a) Zod schemas in critical write routes.** Start with `/api/tasks`, `/api/calendar/event`, `/api/research/import`, `/api/gmail/webhook`. Parse the body, return 400 with the issue path on failure. Cheap, high-value.
- **(b) Schemas everywhere + shared types.** A `lib/schemas/` directory with one schema per route; client uses the inferred types via `z.infer<typeof X>` so the client and server agree on shape.
- **(c) tRPC.** Replace the `app/api/*` REST surface with tRPC procedures defined per feature. Strongly-typed end-to-end, eliminates manual fetches and parsing. Largest refactor; pays off most for the Planning, Applications, and Settings flows that are heavy on round-trips.

### 8.3 `reactStrictMode: false`

Disabling strict mode hides effect-cleanup bugs. The InternalView's `setInterval` + `EventSource` teardown is correct today; nothing enforces it stays correct. Re-enabling strict mode is a one-line change but will surface some currently-hidden issues that need fixing first.

- **(a) Re-enable, fix what breaks.** Flip the flag, run the dashboards, fix any double-mount-induced bugs (most likely in `Dashboard.tsx`'s `useEffect` that reads `mc-active-view`). One-time cleanup pass.
- **(b) Re-enable in dev only.** Conditional on `process.env.NODE_ENV !== 'production'` so prod is unaffected during the cleanup. Lets you discover issues without changing prod behavior.
- **(c) Leave off, document why.** If the cost-benefit is wrong for a single-user app, codify the choice in CLAUDE.md so it doesn't get accidentally flipped on later. Honest non-action.

---

## 9. Deployment, Hosting, and Disaster Recovery

### 9.1 No backups of `prisma/prod.db`

The user's saved papers, applications, life goals, and settings live in one `.db` file with no replication. A bad migration, an `rm` typo, or a disk failure loses everything.

- **(a) Nightly file copy.** A `launchd` plist (or `cron`) that runs `sqlite3 prisma/prod.db .backup ~/backups/mc-$(date).db` daily, keeps 30 days. Native, free, sufficient for one machine.
- **(b) Litestream replication to S3 / B2.** Continuous WAL streaming to cheap object storage; point-in-time restore. Adds a daemon and an external dependency but is the canonical SQLite-to-cloud story.
- **(c) Postgres or Turso instead.** Drop SQLite for a hosted Postgres (Neon free tier) or Turso (libSQL). Replication, backups, and a remote query interface come for free; cost is a network round-trip per query and a meaningful migration.

### 9.2 LAN access still blocked

`launch-ms.sh` binds the prod server to `localhost`. The `todo.md` task to make Mission Control reachable from a phone on the same Wi-Fi is unresolved.

- **(a) Bind to `0.0.0.0` plus a NextAuth domain check.** Change the PM2 invocation to `-H 0.0.0.0`; require `NEXTAUTH_URL` to match the request `Host` header to prevent open relays.
- **(b) Reverse-proxy via local Caddy.** Caddy listens on the LAN with auto-TLS via local CA, proxies to `localhost:3101`. Solves the cookie-secure-flag problem when adding HTTPS for auth.
- **(c) Tailscale.** Put the Mac mini on the user's tailnet; phone connects via WireGuard. No port exposure to the LAN itself; works outside the home network. Requires the user to install Tailscale client on each device.

### 9.3 Single-process model with no graceful restart

PM2 restarts the process hard on crash. There is no signal-handling or cleanup; in-flight requests are dropped, the SSE log clients reconnect, and the cache is cold for ~30 s. A long-running fetcher (Groq's dual-page scrape, OGS enrichment) can leave a corrupt file write if killed mid-flight (mitigated only by the in-process `Mutex`, which doesn't survive process death).

- **(a) Add `SIGTERM` handlers.** Hook `SIGTERM` in `instrumentation.ts` to flush in-flight file writes and close the SSE stream gracefully. PM2 already sends `SIGINT` then `SIGKILL`; this catches the window.
- **(b) Prisma migration locking + write-ahead protections.** Add a `restartGuard` that refuses new write requests while a flag file exists, used by `launch-ms.sh --restart` to drain before kill. Combined with (a) gives clean restarts.
- **(c) Run the web tier behind a thin proxy.** A small reverse-proxy (e.g. a Bun script on a different port) accepts requests and forwards to whichever Next instance is current; restarts swap which Next is "live." Zero-downtime restarts; significant complexity.

---

## How to choose

When you reply, give me a list like:

```
1.1b, 1.2a, 1.3a
2.1a, 2.2a, 2.3a
3.1b, 3.2b, 3.3b
4.1b, 4.2a, 4.3a
5.1a, 5.2b, 5.3a
6.1a, 6.2b, 6.3a
7.1a, 7.2b
8.1b, 8.2b, 8.3a
9.1a, 9.2c, 9.3a
```

You can skip issues you don't want to address. I'll synthesize the chosen options into a single architecture-and-implementation plan in a follow-up document, calling out interactions where two of your choices reinforce or conflict with each other.
