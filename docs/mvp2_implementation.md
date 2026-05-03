# MVP2 Implementation Plan

> **Scope.** This document covers the items in `docs/architecture-critique.md` that you flagged as "plan for X" — the more ambitious successor to each MVP1 task. Order assumes MVP1 has shipped and stabilized; several MVP2 tasks rely on MVP1 scaffolding.
>
> **Prerequisite.** All of MVP1 is in production and has soaked for at least one week without rollback. MVP2 hardens what MVP1 made workable.
>
> **Convention.** Same as MVP1: tasks are labeled with their critique id (e.g. `[1.1b]`).

---

## 0. Carry-overs and assumptions from MVP1

**MVP1 is complete.** All 34 task-units shipped. The two items below were deferred from MVP1 and are the first things to close in MVP2.

### Task 0A 🔜 — Drop `CryptoPrice` schema (MVP1 Task 7A-ii)

`app/api/finance/route.ts` has zero references to `prisma` or `CryptoPrice` — the proxy swap (7A-i) was clean. This is pure housekeeping.

**Files:**
- `prisma/schema.prisma`: delete the `CryptoPrice` model.
- Run `npx prisma migrate dev --name remove_cryptoprice` then `npm run migrate:prod`.
- Delete `scripts/seed-crypto.ts` and `scripts/ingest-btc-history.ts`.

**Gate:** Pulsar's dev instance must be serving real data (CoinGecko + Mempool sources active) so you can verify FinanceView renders correctly before dropping the fallback table.

**Acceptance:** `npx prisma studio` shows no `CryptoPrice` table. `grep -r "cryptoPrice" app/ lib/ scripts/` returns zero matches.

---

### Task 0B 🔜 — Fix broken scrapers

Surfaced by MVP1 Task 2B's `ScraperBrokenError`. All produce `[SCRAPER BROKEN]` in the log and STALE-FALLBACK from cache. Fix by switching to `google-news` strategy in `lib/companies/registry.ts`.

| Company | Error | Fix |
|---|---|---|
| **xAI** | 403 from `x.ai/news` | Switch to `google-news` strategy |
| **AMD** | RSS `ir.amd.com/rss/PressRelease` → 404 | Switch to `google-news` strategy |
| **Google AI** | RSS `research.google/blog/feed/` → 404 | Update URL or switch to `google-news` |
| **ARM** | 541 KB HTML, regex matches nothing | Regex update or `google-news` |
| **Qualcomm** | 8.7 KB HTML (likely JS-rendered), 0 articles | Switch to `google-news` strategy |

**Acceptance:** Zero `[SCRAPER BROKEN]` lines in InternalView for these five companies after a cache bust.

---

**MVP1 scaffolding assumptions:**
- Shared-secret auth (`1.1a`) is in place on `/api/gmail/webhook`. MVP2 upgrades it to OIDC.
- `requireSession` helper (`1.3a`) is centralized in `lib/auth-guards.ts` — extends naturally for service tokens.
- The durable SQLite-backed cache from `[3.3c]` is live. MVP2 unifies it with the client.
- Zod schemas exist for the four critical write routes (`[8.2a]`). MVP2 expands them everywhere.
- The SSE event bus (per `db_source_of_truth_plan.md`) is in place. MVP2's optimistic-concurrency work depends on it.
- Pulsar (`salsquared/pulsar`) is owning financial ingestion (per MVP1 Task 7A). MVP2 formalizes the boundary: Pulsar **stays narrow** (financial only) and a separate `mission-control-scheduler` PM2 process owns all other recurring work.

---

## 1. Phase A — Auth and trust upgrades

### Task A1 — `[1.1b]` Pub/Sub OIDC verification
Replaces `[1.1a]`'s shared-secret with Google-issued OIDC tokens.

**Files:**
- `lib/google-oidc.ts` (new): fetches Google's JWKS at `https://www.googleapis.com/oauth2/v3/certs`, caches per `kid` for 24 h, verifies a Pub/Sub-attached JWT against the configured `aud` and the issuer `https://accounts.google.com`.
- `app/api/gmail/webhook/route.ts`: replace the bearer-token check with `await verifyPubSubOIDC(req, process.env.PUBSUB_AUDIENCE)`.
- Pub/Sub side: configure the push subscription's `oidc_token` with the dedicated service account; set `audience` to the route URL (e.g. `https://mc.local/api/gmail/webhook`).

**Why this matters now:** Once 9.2b's Caddy reverse proxy is live (MVP1 §8C), the webhook is reachable from the LAN. The shared-secret model has no replay protection and no upstream identity guarantee. OIDC gives both for free.

**Risk:** Medium. JWKS rotation, clock skew, audience misconfiguration are all common foot-guns. Verify against Google's [Pub/Sub auth docs](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions) directly when implementing.

**Acceptance:** Forging the previous shared-secret fails; only requests signed by the configured Pub/Sub service account succeed.

---

### Task A2 — Service-token auth path for internal callers
MVP1 confirmed `1.2a`: `/api/calendar/event` now derives `userId` from session, so external services (Pulsar, future agents, scheduled jobs in `mission-control-scheduler`) can't hit it without an interactive cookie. Task A2 adds a parallel service-token path.

**Files:**
- `lib/auth-guards.ts` (already exists from MVP1 Task 1B):
  - Add `requireServiceToken(req, envName)` — checks `Authorization: Bearer ${process.env[envName]}`.
  - Add `requireSessionOrService(req, serviceConfig)` — returns `{ userId }` from either an interactive session or a configured service token, where `serviceConfig` declares which env var holds the token and which user id it's bound to.
- `app/api/calendar/event/route.ts`: swap `requireSession` for `requireSessionOrService`. Service-token callers include a `?onBehalfOf=<userId>` parameter that must equal the user the configured token is bound to (otherwise 403).
- Env vars: e.g. `SERVICE_TOKEN_PULSAR=...` and `SERVICE_TOKEN_PULSAR_USER_ID=<userId>`. Document in `.env` and add a one-time setup step to `docs/hosting.md`.

**Acceptance:** Pulsar (or any other configured service) can `POST /api/calendar/event` with the service token + matching `onBehalfOf` and create events. Anonymous callers still get 401; mismatched `onBehalfOf` still gets 403; interactive sessions are unaffected.

---

## 2. Phase B — Repository pattern (`[2.1c]`)

Centralize Prisma access behind a thin repository layer so route handlers don't speak Prisma directly. This pays off in three places: testability, future caching/auditing, and a clean swap target if you ever migrate off SQLite.

**Files:**
- `lib/repositories/`:
  - `tasks.ts`
  - `applications.ts`
  - `goals.ts`
  - `saved-papers.ts`
  - `settings.ts` (already started in MVP1 Task 5A)
  - `crypto.ts`
  - `cache.ts`
- Each exports a small set of named functions: `findTaskById(id)`, `upsertApplication(input)`, etc.
- Route handlers swap `prisma.task.update(...)` for `tasks.updateStatus(id, status)`.
- Add a Vitest mock for each repo so route tests don't need a real DB.

**Dependencies:** MVP1 Task 5A (settings repository already extracted) is the template.

**Acceptance:** A `grep` for `from '@prisma/client'` in `app/api/**/route.ts` returns zero matches. All Prisma calls live in `lib/repositories/`.

**Risk:** Low but tedious. Do it incrementally — one model per PR.

---

## 3. Phase C — Test contracts at every boundary (`[3.1c]`, `[8.2b]`)

Combine the two related "Zod schemas everywhere" picks into one push.

### Task C1 — Zod schemas for every API request and response
Extends MVP1's `lib/schemas/` to cover all routes, not just the four critical writes. Add a parallel `responses.ts` per route.

**Files:**
- `lib/schemas/<feature>.ts` (one per app/api/<feature>): `XxxRequestSchema`, `XxxResponseSchema`.
- Route handlers parse on the way in (`safeParse` → 400) and validate on the way out in dev (`parse` → throw, surfaces in logs).

### Task C2 — Generated typed client
Use the schemas to generate a small client SDK so the frontend doesn't hand-write fetch calls.

**Files:**
- `lib/api-client.ts` (generated or hand-written from schemas): functions like `api.tasks.update({ id, status })` returning `z.infer<typeof TaskResponseSchema>`.
- Replace all `fetch('/api/tasks', {...})` call sites with `api.tasks.update(...)` etc.
- SWR keys become tuples (`['tasks']`, `['research', topic]`) instead of raw URLs.

**Dependencies:** MVP1 Task 4A (SWR adoption) — the client integrates with SWR's `fetcher` parameter.

**Acceptance:**
- Renaming a request/response field is a TypeScript error in every consumer.
- Server returns malformed data in a test → dev-only assertion fires loudly.
- `grep "fetch('/api/" components/` returns zero matches.

**Risk:** Medium. Big diff (many files) but most changes are mechanical.

---

## 4. Phase D — Optimistic concurrency on settings (`[6.1c]`)

Two browser tabs editing the dash order race today; the SSE event bus from MVP1 reduces but doesn't eliminate the race window. Optimistic concurrency makes it provably safe.

**Files:**
- `prisma/schema.prisma`: add `version Int @default(0)` to `GlobalSetting` (already typed as columns post-MVP1 Task 5A).
- `lib/repositories/settings.ts`: every update reads `version`, sends `If-Match: <version>` from the client, and bumps it server-side. Mismatch → 409.
- `components/providers/state/index.ts` (the unified store from MVP1 Task 5B): on 409, refetch and surface a "Your settings were updated elsewhere — reloaded" toast.

**Dependencies:** MVP1 Task 5A and 5B.

**Acceptance:** Two tabs reorder dashes simultaneously; one wins, the other refetches and reflects the winning state without losing local edits in flight.

---

## 5. Phase E — Background work and live data (`[7.1b]`, `[2.2b]` follow-up)

This phase has two threads, both shaped by the same constraint that the web tier should not host long-lived background work:

1. **Scheduler process** (Tasks E1–E3) — a dedicated `mission-control-scheduler` PM2 process owns all *non-financial* recurring jobs (cache pruning, weekly paper picks, notification digests). Pulsar stays narrow and continues to own financial fetches; this scheduler exists to keep mission-control from acquiring its own ingestion creep.
2. **Pulsar WebSocket relay** (Task E4) — replaces FinanceView's 5-minute poll with push updates from Pulsar's `/ws/prices` plumbed through MVP1's SSE event bus.

> **Reversed from the original plan.** An earlier draft positioned Pulsar as the canonical scheduler for everything. Pulsar's scope is "just for financial information," and overloading it would defeat the boundary that makes the architecture clean. The scheduler process below is the right home for non-financial recurring work.

### Task E1 — Standalone scheduler process
**Files:**
- `scheduler/index.ts` (new top-level dir): a long-lived Node process with a small declarative schedule:
  ```typescript
  const SCHEDULES = [
    { name: 'cache-prune',         intervalMs: 5 * 60 * 1000 },
    { name: 'weekly-paper-pick',   cron: '0 9 * * 1' },     // Mon 09:00
    { name: 'notification-digest', cron: '0 8 * * *' },     // 08:00 daily
    { name: 'fetcher-health-roll', intervalMs: 60 * 1000 },
  ];
  ```
- `scheduler/jobs/<name>.ts` per job — each is a small `async function run()` that imports from `lib/repositories/*` and `lib/...` exactly the way the web process does. Same Prisma client, same DB file.
- `lib/prisma.ts`: enable WAL mode on every `PrismaClient` instantiation. Today mission-control is single-writer so it runs SQLite's default rollback-journal mode. Adding the scheduler makes it multi-writer; without WAL, concurrent writes will race and one will get `SQLITE_BUSY`. Add the same PRAGMA stanza Pulsar uses (per `pulsar/docs/architecture.md` §"SQLite write concurrency"):
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  ```
  Apply them via Prisma's `$queryRawUnsafe` on client init.
- `launch-ms.sh`: add a second PM2 entry:
  ```bash
  NODE_OPTIONS='--max-old-space-size=512' pm2 start scheduler/dist/index.js --name "mission-control-scheduler"
  ```
- `package.json`: add `"build:scheduler": "tsc -p scheduler/tsconfig.json"` and run it from `npm run build`.

**Dependencies:**
- MVP1 Task 2A (durable cache → cache-prune lives there).
- MVP2 Task B (repository pattern → jobs use repos, not Prisma directly).

**Acceptance:**
- Stopping the scheduler with `pm2 stop mission-control-scheduler` halts background work without affecting the web tier.
- Logs go to `~/.pm2/logs/mission-control-scheduler-out.log`; the InternalView log panel can read both via the historical endpoint from MVP1 Task 2C (extend it to take a `?process=web|scheduler` filter).
- Restarting the web tier does not restart the scheduler and vice versa.
- `sqlite3 prisma/prod.db "PRAGMA journal_mode;"` returns `wal` after the next clean restart.

### Task E2 — Pulsar boundary stays narrow
**Files:** none in mission-control.
- Document explicitly in `docs/architecture.md` (post-MVP1 update) and in Pulsar's README: Pulsar owns financial fetches and writes; the scheduler owns everything else.
- Resist the temptation to add non-financial jobs to Pulsar even if it's tempting "since it already exists."

**Acceptance:** A `grep` of Pulsar's source for non-financial concepts (papers, notifications, cache, settings) returns zero matches. A grep of `scheduler/jobs/` for financial concepts (CoinGecko, Mempool, BTC, ETH) returns zero matches.

### Task E3 — Cache pruning moves out of the web process
**File:** `instrumentation.ts`, `scheduler/jobs/cache-prune.ts`.
- Remove the `setInterval(pruneExpiredCache, 5 * 60 * 1000)` registered in MVP1 Task 2A.
- Re-implement as `scheduler/jobs/cache-prune.ts` that imports `pruneExpiredCache` from `lib/cache.ts` (already there).

**Dependencies:** Task E1 (scheduler process exists).

**Acceptance:** `prisma.cacheEntry` row count stays bounded; the web process never schedules anything.

---

### Task E4 — `[2.2b]` Live price updates via Pulsar WebSocket relay

Replaces FinanceView's 5-minute polling interval with event-driven updates pushed from Pulsar through mission-control's SSE event bus.

**Prerequisites (all from MVP1):** Phase 3 SSE event bus (`lib/events.ts` + `app/api/events/route.ts`), Phase 4A SWR adoption in FinanceView, Phase 7 Task 7A-i proxy swap (mission-control already talking to Pulsar REST).

**Files:**
- `lib/pulsar-ws-relay.ts` (new): long-lived WebSocket client that connects to `ws://localhost:3103/ws/prices`. On startup, sends `{ "type": "subscribe", "assetIds": ["bitcoin", "ethereum", "solana"] }`. On each `tick` message, calls `broadcastEvent({ model: 'FinanceTick', action: 'upsert', id: assetId, timestamp: Date.now() })` via the existing event bus.
  - Reconnects with exponential backoff (starting at 1 s, cap at 30 s) if the Pulsar WS drops.
  - Logs `[PULSAR WS] connected / reconnecting / tick received` at `console.info` level so the InternalView log panel captures it.
- `instrumentation.ts` (Node-only branch): add `startPulsarRelay()` alongside `startFileWatcher()` and `initLogger()`.
- `components/views/FinanceView.tsx`: add `useServerEvents('FinanceTick', () => mutate('/api/finance'))` (SWR `mutate` from Phase 4A). Remove or disable the 5-minute `setInterval` polling — push replaces it. Keep SWR's `refreshInterval` at 5 min as a safety-net fallback for when the relay is down.

**Dependencies:** MVP1 Phase 3 (event bus), MVP1 Phase 4A (SWR in FinanceView), MVP1 Task 7A-i (Pulsar REST proxy swap), MVP2 Task E1 (so the web process contains no other in-process schedulers — keeps the new relay the only persistent background connection).

**Acceptance:**
- BTC price updates appear in FinanceView within ~5 s of a Pulsar `PriceTick` insertion (visible in the network tab as an SSE event, not a polling fetch).
- Restarting Pulsar (`pm2 restart pulsar`) causes a brief stale-data window then automatic reconnect; FinanceView recovers without a page reload.
- `pm2 restart mission-control` cleanly tears down the relay and re-establishes it on the next boot (no leaked WS connections).
- InternalView log panel shows `[PULSAR WS] connected` entries; a Pulsar restart shows `reconnecting` then `connected` again.

---

## 6. Phase F — Unified cache abstraction (`[7.2c]`)

Today (post-MVP1) the cache exists in two places: server (`lib/cache.ts` durable SQLite) and client (SWR). They share none of their machinery. Unifying them makes deduplication, invalidation, and revalidation policies coherent.

**Files:**
- `lib/cache/contract.ts`: a `CacheBackend` interface (`get`, `set`, `inflight`, `invalidate`).
- Two backends: `MemorySQLiteBackend` (server) and `SWRBackend` (client adapter).
- `lib/cache/use-cached-fetch.ts`: a single hook (`useCachedFetch(key, ttl, fetcher)`) used by both server actions and client components, dispatching to the right backend.
- The SSE event bus's `broadcastEvent` invokes `cache.invalidate(model)` on the server and broadcasts an `invalidate` event the client picks up to invalidate its keys.

**Dependencies:** MVP1 Tasks 2A, 4A, and the SSE event bus from `db_source_of_truth_plan.md`.

**Acceptance:**
- Same key invalidated server-side instantly invalidates on every connected client.
- Removing the bare `withCache` wrapper still leaves all routes correctly cached.

**Risk:** High. Cache abstractions are notoriously easy to get wrong. Consider keeping `withCache` as a *thin convenience wrapper* over `useCachedFetch` rather than removing it.

---

## 7. Phase G — Plugin contract for company adapters (`[8.1c]`)

After MVP1 Task 8A splits the registry into files, MVP2 promotes "a company" from a config row to a typed adapter.

**Files:**
- `lib/companies/adapter.ts`: `interface CompanyAdapter { id, name, view, category, fetch(): Promise<NewsArticle[]>, healthCheck?(): Promise<HealthSnapshot> }`.
- `lib/companies/<id>.ts` for each company — one file per adapter.
- The strategies (`rss`, `scrape`, `snapi`, `google-news`) become factory functions imported by adapters: `createRssAdapter({...})`.
- The registry becomes an auto-discovery list: every `lib/companies/*.ts` exports a default adapter; the index file globs and assembles them.
- Each adapter can declare its own retry/backoff/health policy.

**Dependencies:** MVP1 Task 8A (split file).

**Acceptance:**
- Adding a company is one new file in `lib/companies/`, no edits to a central registry table.
- Health checks per company surface in the InternalView fetcher tile (MVP1 Task 2D).
- A single adapter can be unit-tested in isolation by importing it directly.

**Risk:** Medium. Plugin architectures over-engineer easily; resist the urge to make the contract too rich. Stick to `fetch + health` and let composition do the rest.

---

## 8. Phase summary (suggested order)

| Order | Task | Why this order |
|---|---|---|
| 1 | Phase B (`[2.1c]` repositories) | Unblocks every later refactor; small, mechanical, safe to ship in slices. |
| 2 | Phase C (`[3.1c]` + `[8.2b]` Zod everywhere + typed client) | Pays off in every subsequent refactor. Catches regressions during the harder phases. |
| 3 | Phase A (`[1.1b]` OIDC + service tokens) | Hardens the LAN-exposed surface before more callers (Pulsar's expanded job set) exist. |
| 4 | Phase E (`[7.1b]` scheduler + Task E4 Pulsar WS relay) | Scheduler owns non-financial recurring work; WS relay replaces FinanceView polling. Note: Pulsar stays financial-only. |
| 5 | Phase D (`[6.1c]` optimistic concurrency) | Small, contained. Could ship anywhere after MVP1 5A/5B but pairs well with Phase E because that's when "another caller might be writing" stops being hypothetical. |
| 6 | Phase F (`[7.2c]` unified cache) | Highest risk; do last so you have the testing scaffolding from Phase C and the repository abstraction from Phase B. |
| 7 | Phase G (`[8.1c]` adapter plugin) | Independent; can be done at any point after MVP1 Task 8A. Sequenced last only because it's the lowest-priority structural change. |

---

## 9. What MVP2 deliberately does *not* address

- **AICompanion productionization** — `[5.2b]` and `[5.2c]` are real next steps but were not flagged as "plan for X." If you want them in MVP2, say so and I'll add a Phase H.
- **Postgres / Turso migration** — `[9.1c]` is left out; SQLite + Litestream-style backups (or just MVP1's nightly file copy) is sufficient until the user count grows.
- **Full RSC migration** — `[5.1c]` is left out; SWR + SSE invalidation from MVP1 covers the use cases.
- **External observability stack** — `[4.2c]` (OpenTelemetry/PostHog) was not selected; in-app tile + PM2 logs are adequate.
- **Replacing regex scrapers with headless browsers** — `[3.2c]` was not selected; the fail-loud sentinel from MVP1 plus the adapter contract from Phase G is enough to keep them maintainable.

---

## 10. Decisions still open at MVP2 kickoff

These don't block MVP1 — pick them when MVP2 is about to start.

1. **Phase E scheduler jobs:** confirm which recurring work migrates to the new `mission-control-scheduler` process. Default plan:
   - Cache pruning (Task E3 explicitly covers this) — moves out of the web process.
   - Weekly paper pick selection (currently lazy on first view of the week) — moves to scheduler.
   - Future notification digests (`docs/todo.md` lines 80–93) — implemented in scheduler.
   - Crypto ingest stays in Pulsar — leave it there.

2. **Phase F (unified cache):** custom abstraction vs. adopting TanStack Query everywhere and accepting the bundle cost? TanStack is more battle-tested; the custom path is lighter. **Decide this before Phase C ships** — TanStack would replace the bespoke `api-client.ts`, so the typed-client work changes shape depending on the call.

3. **Phase G (adapter plugin):** compile-time discovery (explicit `import` index) vs. runtime glob (`fs.readdir + dynamic import`)? Recommend compile-time — harder to mis-wire, easier to type-check, no surprises in prod.
