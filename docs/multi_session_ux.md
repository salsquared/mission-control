# Multi-Session UX — Diagnosis and Fix Plan

> **Goal.** Same logical user, multiple concurrent device sessions (Mac mini in Chrome App Mode, phone via Cloudflare tunnel, occasional second laptop), with **no visible disruption** on already-open clients when a new device signs in.
>
> **TL;DR.** The backend already supports multi-session. What you are seeing on the desktop is **not** a single-session restriction; it's a frontend remount that *looks* like a reload because two consumers (`ApplicationsView`, `CalendarWidget`) treat every `useSession` revalidation as a brand-new mount. There is also a service-worker behaviour and a Google `Account` refresh-token edge case that can amplify it.

---

## 1. What already works (do not "fix")

| Layer | Evidence | State |
|---|---|---|
| **Session schema** | `prisma/schema.prisma:88-94` — `Session.sessionToken @unique`, no unique on `userId` | N rows per user is allowed |
| **NextAuth adapter** | `lib/auth.ts` uses `PrismaAdapter` with default DB strategy and no `signIn` callback that prunes other sessions | New device signin **inserts** a new `Session` row; never deletes others |
| **Account row** | One row per `(provider, providerAccountId)` per user | Shared across devices — refresh token rotates here on each signin (see §3.E) |
| **Cookies** | NextAuth writes HttpOnly cookies scoped to the request host | Per-device, per-origin — phone signin does **not** push a cookie to the computer |
| **Auth guard** | `lib/auth-guards.ts:requireLocalOrSession` exempts `mc.local` / `localhost` and requires a session for the tunnel host | Already supports the "LAN device + phone-on-tunnel" topology |

**Conclusion:** the architecture is already single-user, multi-session. MVP1 did not regress this; it never restricted it in the first place.

---

## 2. What you actually observe

Computer is open at the dashboard. Phone navigates to the Cloudflare tunnel URL and completes Google sign-in. The desktop UI flashes — the active view appears to remount (loader spinner reappears, network panel shows a burst of `/api/...` calls). The URL bar does not change; there is no `Doc` request to `/`. **It is a React remount, not a navigation.**

---

## 3. Root causes, ordered by likelihood

### A. `ApplicationsView` returns a different subtree on every `useSession` revalidation
**File:** `components/views/ApplicationsView.tsx:46-52`
```tsx
const { data: session, status } = useSession();
// ...
if (status === "loading") {
    return <Loader2 .../>;   // <-- whole subtree is a different element
}
```
NextAuth's `useSession` flips `status` back through `"loading"` whenever it revalidates (window focus, storage event, programmatic update). React sees a different return type and **unmounts everything below**, including `<KanbanWidget>` and `<CalendarWidget>`. SWR caches survive in module memory, but every child component re-runs its mount effects. That **is** the "reload" the user sees.

This is the dominant cause. Fixing only this will eliminate ~95% of the symptom.

### B. `CalendarWidget` re-fetches on every `session` object identity change
**File:** `components/widgets/CalendarWidget.tsx:39-43`
```tsx
useEffect(() => {
    if (session) { fetchEvents(); }
}, [session]);
```
`useSession`'s returned `session` object is **not reference-stable** across revalidations. Every revalidation re-runs `fetchEvents()`. Independently of the remount in §A, this throws an extra calendar GET on every focus event and every cross-device signin.

### C. Same-browser cookie sync (Chrome Sync, Safari iCloud Tabs)
If the desktop is **also** on the Cloudflare tunnel hostname *and* uses a Chrome profile that syncs with the phone, the `next-auth.session-token` cookie can propagate device-to-device through the browser sync layer. When that happens the desktop's `useSession` does see a different token and revalidates with new data, which triggers §A and §B more aggressively. This is environmental, not a bug — but the doc should call it out so future-us doesn't chase it.

### D. Service worker `clientsClaim` (production)
**File:** `app/sw.ts:18-19`
```ts
skipWaiting: !isDev,
clientsClaim: !isDev,
```
If a deploy happens between the desktop's last load and the phone's first load, the new SW version that the phone fetches and activates can also activate on the desktop the next time it has any network activity, and `clientsClaim: true` will take over the open page. That manifests as a navigation-style reload (true `Doc` request). Rare, but it does happen, and it is conflated with the §A remount in user reports.

### E. `Account.refresh_token` rotation
`lib/auth.ts` requests `access_type: "offline"` + `prompt: "select_account"`. Google **may** return a new refresh token on the phone's signin. PrismaAdapter writes it back to the single `Account` row, replacing the value the desktop's `getGoogleAuthClient` last used. If the desktop has an in-flight Gmail/Calendar call when the rotation happens, that call can fail with `invalid_grant`. SWR surfaces the error → user sees an error toast / partial render → indistinguishable from a reload in the moment.

This is rare but real, and the fix is independent of A/B/C/D.

---

## 4. What MVP1 omitted (this is the gap)

MVP1 hardened auth boundaries (1A/1B/1C) and made the LAN bypass explicit (`requireLocalOrSession`). It **did not**:

1. Codify the rule "components must not return a different subtree while a session is revalidating."
2. Configure `<SessionProvider>` props (uses defaults).
3. Document the Chrome-Sync caveat.
4. Disable `clientsClaim` after the SW landed.
5. Address refresh-token-rotation as a per-device concern.

None of these are *bugs* in MVP1's scope — but together they leave the multi-session UX feeling broken even though the data model is correct.

---

## 5. Fix plan

Tasks are sized so that **5.1 alone is the minimum acceptable fix**. 5.2–5.5 are quality/robustness add-ons.

### Task 5.1 ✅ — Stop unmounting on session revalidation **(must)**
**Files:** `components/views/ApplicationsView.tsx`, plus an audit of any other view that early-returns on `status === "loading"`.

Replace the early-return pattern with a "show loader only on the **first** load" pattern:
```tsx
const { data: session, status } = useSession();
const hasEverAuthed = useRef(false);
if (status === "authenticated") hasEverAuthed.current = true;

const showInitialLoader = status === "loading" && !hasEverAuthed.current;
if (showInitialLoader) return <Loader2 .../>;
// otherwise render the view; treat session revalidation as a background event
```
Or, equivalently and simpler: change the gate so the *signed-out CTA* is what renders when `status === "unauthenticated"`, and the loader only renders when there is genuinely no session yet (`status === "loading" && !session`).

**Acceptance:** Sign in on the phone with the desktop open. The desktop's ApplicationsView does **not** flash to the spinner. Network tab shows `/api/auth/session` revalidation but no remount of `<KanbanWidget>` (verified by attaching a `console.log` to a child mount effect, or by inspecting React DevTools — the component's "key/instance" should be stable).

### Task 5.2 ✅ — Stabilize `CalendarWidget`'s effect dependency **(must)**
**File:** `components/widgets/CalendarWidget.tsx:39-43`

Key the effect on `session?.user?.id` (or `status === 'authenticated'`), not on the `session` object reference:
```tsx
const userId = (session?.user as any)?.id ?? null;
useEffect(() => {
    if (userId) fetchEvents();
}, [userId]);
```
**Acceptance:** Repeated `useSession` revalidations on focus do not produce additional `GET /api/calendar/event` requests when the user identity hasn't changed.

### Task 5.3 ✅ — Configure `<SessionProvider>` explicitly **(should)**
**File:** `components/providers/SessionProvider.tsx`

Make the cadence intentional. Suggested:
```tsx
<SessionProvider
  refetchOnWindowFocus={true}      // good UX; the §5.1 fix neutralizes its cost
  refetchInterval={5 * 60}         // 5 min — quietly catches token expiry
  refetchWhenOffline={false}
>
  {children}
</SessionProvider>
```
**Acceptance:** Clearly documented in `CLAUDE.md` (or inline) why each prop is what it is, so a future change doesn't silently regress §5.1.

### Task 5.4 ✅ — Disable `clientsClaim` in production **(should)**
**File:** `app/sw.ts`

Change:
```ts
skipWaiting: !isDev,
clientsClaim: !isDev,
```
to:
```ts
skipWaiting: false,
clientsClaim: false,
```
The user gets the new SW on the **next** full navigation, which is exactly the intent for an app-mode dashboard. We give up zero real benefit and remove a class of "the page reloaded itself" reports.

**Acceptance:** Deploying a new SW does not cause any open client to navigate. New SW becomes active on next deliberate refresh.

### Task 5.5 — Refresh-token rotation safety **(could, MVP2)**
**File:** `lib/googleapis.ts` (and wherever Gmail/Calendar calls are made).

Two options, pick one:
- **(a) Catch and retry once.** Wrap Google API calls so an `invalid_grant` triggers a re-read of `Account.refresh_token` from DB and one retry. Cheap and addresses the symptom.
- **(b) Per-device `Account` partitioning.** Move from one `Account` row per provider to one row per `(provider, deviceId)`. Bigger schema change, only worth it if (a) proves insufficient. **Defer to MVP2** unless we observe `invalid_grant` in logs after 5.1–5.4 ship.

**Acceptance:** A phone signin during an in-flight desktop Gmail/Calendar call does not produce a user-visible error.

### Task 5.6 — Document Chrome-Sync caveat **(could, doc-only)**
**File:** `docs/architecture.md` or `docs/hosting.md`

Add a short note that if both devices use the same browser profile *and* the same hostname (the tunnel), the session cookie is synced through the browser cloud, which is harmless after 5.1 but worth knowing during debugging.

---

## 6. Verification protocol

Run after 5.1 + 5.2 ship; before 5.3/5.4 are required.

1. **Confirm it's a remount, not a navigation.** DevTools → Network → filter `Doc`. Reproduce. There should be **zero** new top-level document requests.
2. **Confirm two Session rows exist.** `npx prisma studio` (or `sqlite3 prisma/prod.db "select id, userId, expires from Session"`) — expect at least 2 rows for your user after both devices sign in. If you see only 1, the multi-session premise is wrong and §1 of this doc is incorrect.
3. **Confirm SWR cache survives.** Add a `console.log('mount')` to `KanbanWidget`. Reproduce. After 5.1, you should see the log fire once on initial desktop load and **not** again when the phone signs in.
4. **Stress test.** Open four devices simultaneously, sign in on each. Mutate a task on one. Confirm `useServerEvents('Task')` propagates to the other three within ~500ms (this exercises the Phase 3 SSE bus end-to-end across multi-session).

---

## 7. Cross-references

- Phase 1 of `docs/mvp1_implementation.md` (auth guards) — this work *complements* it; nothing here invalidates 1A/1B/1C.
- `docs/architecture.md` §"Auth (Google OAuth + offline access)" — should be updated with a one-liner pointing here once 5.1–5.3 ship.
- `docs/architecture-critique.md` line 169 (state-routing policy) — multi-session UX is a frontend-state-routing concern in addition to an auth concern; this doc closes that loop.
