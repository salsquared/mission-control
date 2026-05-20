# Dev server performance profile

**Snapshot taken 2026-05-19 against `mission-control-dev` (PM2, port 4101).**

Measured baseline (idle browser tab on Space dash, dev server up ~13 min, no active user interaction):

| Metric | Value | Source |
| --- | --- | --- |
| Dev process RSS | **1.13 GB / 2 GB max-old-space-size** | `/api/system` |
| Reported CPU % | 100 (saturated) | `/api/system` |
| `.next-dev/dev` build cache | 195 MB on disk (138 MB in `cache/`) | `du -sh` |
| Dependencies | 50 deps + 17 devDeps; Next 16.1.1, React 19.2.3 | `package.json` |

**Important: `pm2 list` / `pm2 jlist` see only the npm wrapper, not the actual worker.** The PM2-managed entry is `npm run dev`, which forks `next dev`, which forks the `next-server` worker. Only the worker holds the HTTP state — EventSources, React tree, query cache, etc. The wrapper sits idle at ~54 MB regardless of how loaded the worker is. So **don't trust `pm2 list` to gauge dev-server load**: it'll say "50 MB" while the worker is at "1 GB". Use `/api/system` (in-process, reads the worker) or `scripts/perf-monitor.ts` (which walks the process tree to the worker — corrected 2026-05-20).

For context, the **prod** PM2 process is sitting at ~50 MB in its npm wrapper; its worker has not been measured separately but the same wrapper-vs-worker caveat applies.

---

## Top causes, ranked by impact

### 1. `console.info('[DATABASE] ...')` on every Prisma query, fanned out to every SSE log subscriber

**Where**: `lib/prisma.ts:23` logs every operation via `console.info`. The patched console in `lib/logger.ts:97` then:
1. Pushes onto the global ring buffer (and `shift()`s if over 50).
2. Writes a JSON line to stdout (PM2 captures it).
3. **Calls every entry in `__LOG_LISTENERS`** — one per `/api/system/logs` SSE connection.

**Why it hurts dev specifically**: when the user is on the Internal Systems dash (or it's open in another tab), the SSE listener serialises + encodes the payload and the browser then runs `InternalView.tsx:122-130`:
- `setSysLogs([...prev, log])` — full array copy, up to 500 entries
- `computeHealth(nextLogs)` — `InternalView.tsx:76-96` walks every log, runs three regexes per entry, builds a fresh `HealthMap` object on **every push**
- The entire `staticCards` JSX array (lines 178-565) is rebuilt inline because it lives in the component body, not memoised.

So one HTTP request that triggers 5 Prisma queries → 5 stdout writes + 5 SSE pushes + 5 client re-renders walking 500 logs each.

**Fix candidates** (cheapest first):
- Gate `console.info('[DATABASE] ...')` on `process.env.NODE_ENV === 'production' || process.env.DEBUG_PRISMA === '1'`. Dev shouldn't be logging every query when it's flowing into a live UI feed. Estimated win: large — kills the dominant log volume.
- Drop the regex-driven `formatLogMessage` from the live SSE path; render plain text in the live tail, only colourise when "Load older" is clicked. Or pre-compile the regexes once at module scope (currently `new RegExp` literal inside a hot path).
- Memoise `staticCards` with `useMemo` keyed on the inputs that actually change (sysMetrics, sysLogs, fetcherHealth) — right now `views.map`, `colorPresets`, JSX for telemetry boxes are all rebuilt every push.

### 2. `useServerEvents` opens a fresh `EventSource` per call — and Strict Mode opens each one twice

**Where**: `hooks/useServerEvents.ts:9` — no connection sharing. Every component that subscribes spins its own `/api/events` EventSource. Mount sites:
- `CacheInvalidationListener` (always mounted via QueryProvider)
- `NotificationBell` (always mounted via Dashboard)
- `useServerEvents` calls per active view: ApplicationsView (2), ProfileView (1), PlanningView (2), WatchlistsCard (1), NewPostingsCard (1), FinanceView (1), SavedPapersOverlay (1 when open)

Two browser tabs on the Applications dash = **8 long-lived SSE responses** pinned in the dev process. Each holds its own `ReadableStream`, encoder, abort listener, and 30-second heartbeat interval (`app/api/events/route.ts:27`).

**Compounded by**: `next.config.ts:13` has `reactStrictMode: true`, while `CLAUDE.md:163` claims it's `false`. Strict Mode in React 19 dev double-invokes effects, so every `useServerEvents` opens → closes → opens again on mount. The drift is recent (last touch of `next.config.ts` was the webpack-fallback fix; CLAUDE.md hasn't caught up).

**Fix candidates**:
- Move EventSource ownership up one layer: have `QueryProvider` (or a sibling `ServerEventsProvider`) own a **single** `/api/events` connection and dispatch to subscribers via a context-bound `Map<ModelName, Set<callback>>`. The hook becomes a registration call, not a connection opener. Big win in dev (8 → 1 connection) and a smaller, real win in prod.
- Decide on Strict Mode and reconcile the docs. If you want the double-mount safety net, keep it on and own the cost. If not, set `false` and delete the line in CLAUDE.md. Either way, stop the drift.

### 3. `CacheInvalidationListener` does a sledgehammer `invalidateQueries()` on every cache event

**Where**: `components/providers/CacheInvalidationListener.tsx:18`.

Any server-side `invalidateCacheKey('/api/foo')` broadcasts `'Cache'` → every client calls `queryClient.invalidateQueries()` (no filter) → **every** active TanStack query refetches. With `refetchOnWindowFocus: true` (QueryProvider:19) on top of this, alt-tabbing back to the browser triggers another full refetch.

**Fix**: include the invalidated cache key/prefix in the SSE payload and pass a `predicate` to `invalidateQueries` that only refetches queries whose `queryKey[0]` matches the prefix. The doc-comment in CacheInvalidationListener.tsx already calls this out ("The mapping is heavy-handed…") — it's a known trade-off but worth revisiting now that the query graph has grown.

### 4. Internal Systems telemetry polls every 5 s, always

**Where**: `components/views/InternalView.tsx:68` — `refetchInterval: 5000` with no `enabled` gate.

This fires `/api/system` every 5 s even when the dash isn't visible (the carousel renders one dash at a time, but mounting state of the Internal view persists across slide changes via React tree — actually it does NOT, Dashboard only renders the current view by index). Confirm by reading line 202 of `Dashboard.tsx`: `orderedDashes[currentIndex]?.component` — only the active dash mounts. So this is fine when the user is elsewhere.

But the `/api/system` handler **runs a Prisma `pingDatabase()`** on every tick (`app/api/system/route.ts:80`), which itself emits a `[DATABASE]` log line → which fans back out through SSE → see issue 1. **The telemetry poll is feeding its own log stream.**

**Fix**: cache `pingDatabase()` for 15-30 s in-process; or skip the DB ping unless a query parameter requests it. The "Database Status" pill doesn't need 5 s freshness.

### 5. Per-card setInterval timers

**Where**: each runs unconditionally once mounted:
- `NewsCyclingCard.tsx:28` — interval (verify duration)
- `NextLaunchCard.tsx:46` — **1 Hz** countdown timer, re-renders the whole card every second
- `ResearchPaperCard.tsx:36` — paper cycling
- `FinanceView.tsx:17` — 30 s clock tick for relative timestamps
- `ApplicationsView.tsx:92` — 5-minute Gcal sync trigger

The 1 Hz NextLaunch timer is the only one worth flagging on its own — render the seconds-precision off a `requestAnimationFrame` derived clock or a single global tick context so multiple "T-minus" displays share one source. Otherwise each card is its own tick + state set.

### 6. Build-side noise (dev only, not the dominant issue)

- `.next-dev/dev/cache` is 138 MB of webpack persistent cache. That's not "leaking" — it's how Next keeps HMR fast — but if you suspect a corrupt cache after dependency changes, deleting it gets you a fresh baseline. Don't reach for this routinely.
- `next.config.ts:14` correctly isolates `distDir: '.next-dev'` so dev and prod builds don't clobber each other; keep this.
- Heavy server-only deps (`googleapis`, `puppeteer-core`, `html-to-docx`, `mammoth`, `pdf-parse`, `jose`) are already in `serverExternalPackages` — they don't get webpack-bundled.

---

## Shipped (2026-05-20)

All 9 originally-identified fixes shipped, plus 3 follow-on bundle-side wins discovered while measuring, plus a Turbopack flip. Each was measured with `scripts/perf-monitor.ts` against a cold-restart worker (via `MC_PERF_RESTART=1`).

1. ✅ **Silence `[DATABASE]` query logs in dev** unless `DEBUG_PRISMA=1` — `lib/prisma.ts`.
2. ✅ **`reactStrictMode: false`** — `next.config.ts`. Reconciled with CLAUDE.md's stated invariant.
3. ✅ **Shared `/api/events` EventSource** across all `useServerEvents` callers — refcounted, auto-reconnect — `hooks/useServerEvents.ts`.
4. ✅ **Memoise `InternalView` + move `computeHealth` to a 5 s timer** instead of per log push — `components/views/InternalView.tsx`. Log buffer capped at 200 (was 500), rendered list capped at last 100.
5. ✅ **Debounced `CacheInvalidationListener`** (300 ms) so a scheduler tick's invalidation burst collapses into one refetch wave — `components/providers/CacheInvalidationListener.tsx`. Per-query scoping deferred — single-tab dev usage doesn't warrant the cache-key↔query-key schema work.
6. ✅ **Cached `pingDatabase()` + `pulsarOnline` for 15 s** in `/api/system`. The poll-loop was self-feeding.
7. ✅ **L1 cache expiry sweep** every 5 min — `lib/cache.ts`. Was unbounded prior.
8. ✅ **Dev-mute the chatty per-request logs** (`[CACHE HIT/MISS]`, `[API Request]`) behind `DEBUG_VERBOSE_LOG=1` — `lib/cache.ts`, `proxy.ts`. Same prod-on / dev-gated pattern as `DEBUG_PRISMA`.
9. ✅ **Pulsar WS reconnect backoff** extended to 5 min after 10 failed attempts — `lib/pulsar-ws-relay.ts`. Was 30 s indefinitely, ~360 log entries/hr against a dead service.
10. ✅ **Lazy-load every dash via `next/dynamic`** — `components/Dashboard.tsx`. The biggest single dev-floor lever; before, all 8 views compiled at module top.
11. ✅ **Dropped `react-icons` (83 MB)** by replacing 8 moon-phase icons with U+1F311 – U+1F318 unicode glyphs — `components/views/SpaceView.tsx`. Removed the dep from `package.json`.
12. ✅ **`experimental.optimizePackageImports`** for `lucide-react`, `framer-motion`, and the `@radix-ui/*` primitives — `next.config.ts`. Next 14+ feature; transforms barrel imports to per-icon paths at compile.
13. ✅ **`next dev --turbopack`** — `package.json`. Single biggest measured win after all the above landed. Production `build` stays on webpack (see CLAUDE.md "Dev vs prod tooling split" for the rationale).

### Measured deltas (cold 5-min idle, worker RSS, vs original baseline)

| Run | RSS median | RSS p95 | RSS max | CPU max |
| --- | ---: | ---: | ---: | ---: |
| baseline (pre-fix-1) | 1263 MB | 1432 MB | **1464 MB** | 14.8% |
| after fixes 1–9 (webpack) | 1098 MB | 1112 MB | 1113 MB | 4.2% |
| + lazy-load + bundle opts (webpack) | 999 MB | 1191 MB | 1542 MB | 165% |
| **+ Turbopack** (final) | **722 MB** | **777 MB** | **951 MB** | **73%** |

Total cut: **−43 % RSS median, −35 % RSS max, 100 % CPU peg → transient 73 % bursts**.

### Prod sanity check (2026-05-20)

For comparison, the prod tier (`next start`, webpack-built) ran a 5-min sample after a `pm2 restart mission-control`:

| Metric | Value |
| --- | ---: |
| Worker RSS median | **279 MB** |
| Worker RSS p95 | 300 MB |
| Worker RSS max | 387 MB |
| Worker RSS floor | 279 MB (flat for the entire post-warmup window) |
| Worker CPU max | 13.5 % |

So the app's actual runtime footprint is ~280 MB. The dev/prod ratio is now ~2.6 ×, which is normal for a Next app of this size. The remaining dev overhead is structural to dev tooling (HMR, Turbopack in-memory state, source maps, error overlay).

## Out-of-scope / future

- **Production `build` still uses webpack** (`next build --webpack`). Turbopack's build path is stable in Next 16 but not yet verified against this stack (`@serwist/next` SW generation, Prisma client gen quirks, CSS chunk hashing differences). Flip is a re-test, not a commit-and-ship.
- `instrumentation.ts` still starts the Pulsar WS relay on boot. With the fix-9 backoff change it's now ~once per 5 min when Pulsar is offline, down from ~once per 30 s. Benign.
- `scripts/perf-monitor.ts` is now the canonical observation tool. Use `MC_PERF_RESTART=1` for cold-baseline AB measurements; leave unset for "is it stable over N minutes" observation. Reports per-process-tree RSS so it doesn't get fooled by the `pm2 list` npm-wrapper trap.
