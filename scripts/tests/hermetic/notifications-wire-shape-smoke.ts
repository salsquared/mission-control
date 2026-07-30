/**
 * Hermetic smoke for `GET /api/notifications` — the wire-shape contract between
 * the route's hand-written `serialize()` and
 * `lib/schemas/notifications.ts:NotificationSchema`, AND the critical-tier pin
 * that decides WHICH rows reach that wire at all.
 *
 *   npx tsx scripts/tests/hermetic/notifications-wire-shape-smoke.ts
 *
 * TWO REGRESSIONS, both fixed 2026-07-29, both guarded here. They are the same
 * bug seen from two ends: the client's critical-tier pin could not work, first
 * because the field it sorts on never arrived, then because the page it sorts
 * was already truncated.
 *
 * ── BUG 1: the dropped `tier` field ────────────────────────────────────────
 * `serialize()` in `app/api/notifications/route.ts` is hand-written — it does
 * NOT spread the Prisma row — so a field the schema requires can silently go
 * missing from the response. `tier` did exactly that from c5c8905 until
 * 2026-07-29: the row had it, the schema required it
 * (`z.enum(["critical","standard","low"])`), and the serializer never copied
 * it, so every notification went over the wire with `tier === undefined` for
 * months. Consequences, all silent:
 *   - `components/overlays/NotificationBell.tsx` pins critical-tier UNREAD rows
 *     to the top of the list (~L57-72) and styles critical rows (~L203). With
 *     `tier` undefined, `tierRank[tier] ?? 99` collapsed to the same constant
 *     for every row, so the tier sort AND the critical styling were no-ops.
 *   - The only detector was the dev-only `console.warn` in
 *     `lib/api-client.ts:jsonFetch`, which never throws and never fails a test.
 *
 * ── BUG 2: the pin could only reorder an already-truncated page ────────────
 * Even with `tier` on the wire, the bell's sort is CLIENT-side: it runs on
 * whatever the route already returned. The route was `orderBy createdAt desc` +
 * `take: limit` (the bell asks for `limit: 20`), so with a large low-tier
 * backlog an unread critical simply never arrived and the pin stayed a no-op.
 * Measured on real data before the fix: 0 of 4 unread criticals were inside the
 * newest-20 window on BOTH tiers, buried under 700+ unread low-tier posting
 * rows — and the 4 hidden ones were real application rejections. The fix is a
 * SECOND query (`pinnedWhere` = base where + `tier: "critical"`, `readAt: null`,
 * `dismissedAt: null`, `take: PINNED_CRITICAL_CAP`) merged AHEAD of the recency
 * window, deduped by id, then `.slice(0, limit)`. Response contract unchanged.
 *
 * Asserts, driving the REAL `GET` handler in-process (authenticated through the
 * `__seedViewer` seam, since an in-process call has no request scope and would
 * otherwise 401):
 *   1. 200 + the response parses against the REAL
 *      `NotificationsListResponseSchema`. THIS is the core wire assertion — it
 *      covers every field the schema requires, so a field added to the schema
 *      later and forgotten in `serialize()` fails here too, not just `tier`.
 *   2. That schema check HAS TEETH: dropping `tier` (and, separately,
 *      `createdAt`) from a known-good body must make the same parse fail. A
 *      guard nobody has watched fail is not a guard.
 *   3. `tier` explicitly — present, a valid tier literal, and round-tripped
 *      per-row by id — so the failure message names the actual regression
 *      instead of a generic "schema invalid".
 *   4. One row PER TIER is seeded, so a dropped-or-defaulted tier cannot hide
 *      behind a single-value fixture (all rows reading "low" would still parse).
 *   5. `unreadCount` is correct and scoped to the viewer; dismissed rows are
 *      excluded by default; `?includeDismissed=true` and `?unread=true` flip
 *      the filters (proving the default exclusion is the filter, not a row that
 *      failed to seed); a second user's rows never appear.
 *   6. A legacy row with malformed `payload` JSON still satisfies the schema
 *      (serializer's try/catch → `{}`), rather than 500ing or emitting a string.
 *   7. THE PIN (bug 2), against a deliberate flood fixture — one unread critical
 *      older than 30 newer unread low rows, requested at `limit=20`:
 *        a. The premise is PROVEN, not assumed: the critical's `createdAt` is
 *           older than every low row's, and the pre-fix query (pure recency,
 *           same where/order/take, run directly against the same DB) is shown
 *           NOT to contain it. Without this, "the critical is in the response"
 *           could pass for the trivial reason that it was in the window anyway.
 *        b. The unread critical IS in the response.
 *        c. `limit` is still respected — the merge slices.
 *        d. Ids are UNIQUE: a critical already inside the recency window must
 *           be returned once, not twice (seeded explicitly, not inferred).
 *        e. A DISMISSED unread critical is never re-pinned — absent by default,
 *           and still absent under `?includeDismissed=true` when it falls
 *           outside the recency window (the pin path is the only way it could
 *           appear there, so that assertion is a direct test of the forced
 *           `dismissedAt: null` in `pinnedWhere`).
 *        f. A READ critical outside the window is NOT pulled in (unread-only).
 *        g. `?unread=true` stays coherent with the pin, and `unreadCount` is
 *           unaffected by it.
 *
 * Genuinely hermetic: no server, no network, no PM2, no Chrome. The DB is a
 * THROWAWAY SQLite file in /tmp (DATABASE_URL pinned before any import that
 * reaches lib/prisma; tables created with raw DDL mirroring
 * prisma/schema.prisma). dev.db / prod.db are never touched.
 */
const TMP_DB = `/tmp/notifications-wire-shape-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${TMP_DB}`;
// GET sends nothing, but keep the master Gmail-send switch off so no import
// side-effect in the route's dependency graph can ever reach a real mailbox.
process.env.EMAIL_ENABLED = "0";

import { unlinkSync } from "node:fs";
import { NextRequest } from "next/server";
import { __seedViewer, __resetViewer } from "@/lib/viewer";
import {
    NOTIFICATION_TIERS,
    NotificationsListResponseSchema,
    type NotificationTier,
} from "@/lib/schemas/notifications";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// Hand-maintained DDL — it does NOT track prisma/schema.prisma automatically.
// The Notification table needs EVERY column in the model (Prisma's create()
// selects them all back), so a new column there breaks these creates with P2022
// until it is mirrored here.
const DDL = [
    `CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT,
        "email" TEXT,
        "emailVerified" DATETIME,
        "image" TEXT,
        "lastSyncedHistoryId" TEXT,
        "role" TEXT NOT NULL DEFAULT 'crew'
    )`,
    `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
    `CREATE TABLE "Notification" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "tier" TEXT NOT NULL DEFAULT 'low',
        "title" TEXT NOT NULL,
        "body" TEXT,
        "payload" TEXT NOT NULL,
        "channels" TEXT NOT NULL DEFAULT 'in_app',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "readAt" DATETIME,
        "dismissedAt" DATETIME,
        "emailSentAt" DATETIME,
        "emailError" TEXT,
        "dedupKey" TEXT,
        "scopeKey" TEXT,
        "emailMessageId" TEXT,
        CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "Notification"("dedupKey")`,
    `CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt")`,
    `CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt")`,
    `CREATE INDEX "Notification_userId_scopeKey_createdAt_idx" ON "Notification"("userId", "scopeKey", "createdAt")`,
];

const OWNER = "owner-notifications-wire-shape-smoke";
const OWNER_ADDRESS = "owner@notifications-wire-shape-smoke.invalid";
const CREW = "crew-notifications-wire-shape-smoke";

/**
 * The fixture set. One row PER TIER among the default-visible rows is the point
 * of item 4 above: if every seeded row were tier="low", the column's
 * `@default('low')` — or a serializer that hardcoded a tier — would satisfy
 * both the schema and a naive round-trip check.
 */
interface Fixture {
    id: string;
    tier: NotificationTier;
    kind: "posting" | "application" | "system";
    read: boolean;
    dismissed: boolean;
    payload: string;
    body: string | null;
}

const FIXTURES: Fixture[] = [
    { id: "nwss-critical-unread", tier: "critical", kind: "application", read: false, dismissed: false, payload: JSON.stringify({ applicationId: "app-1" }), body: "An offer landed" },
    { id: "nwss-standard-unread", tier: "standard", kind: "posting", read: false, dismissed: false, payload: JSON.stringify({ postingId: "post-1" }), body: null },
    { id: "nwss-low-unread", tier: "low", kind: "system", read: false, dismissed: false, payload: JSON.stringify({ note: "housekeeping" }), body: "Nightly prune finished" },
    // Read but NOT dismissed — still returned by default, must not be counted.
    { id: "nwss-critical-read", tier: "critical", kind: "application", read: true, dismissed: false, payload: JSON.stringify({ applicationId: "app-2" }), body: null },
    // Malformed legacy payload. serialize()'s try/catch must yield `{}` so the
    // schema's `z.record` still holds (item 6).
    { id: "nwss-low-malformed-payload", tier: "low", kind: "system", read: false, dismissed: false, payload: "{not json at all", body: null },
    // Dismissed and NOT read: excluded from the default list AND from
    // unreadCount (the count's `dismissedAt: null` clause, not its readAt one).
    { id: "nwss-standard-dismissed", tier: "standard", kind: "posting", read: false, dismissed: true, payload: JSON.stringify({ postingId: "post-2" }), body: null },
];

const VISIBLE = FIXTURES.filter(f => !f.dismissed);
const EXPECTED_UNREAD = VISIBLE.filter(f => !f.read).length;
const EXPECTED_TIER_SET = [...new Set(VISIBLE.map(f => f.tier))].sort().join(",");

// ───────────────────────────────────────────────────────────────────────────
//  Fixtures for BUG 2 — the critical-tier pin.
//
//  These live on their OWN users so the bug-1 assertions above (which count
//  rows and compare tier SETS for OWNER) are untouched by a 30-row flood. Their
//  presence in the same DB also strengthens the existing cross-user-leak check.
//
//  Two scenarios, one user each:
//    FLOOD — the real-world shape: one old unread critical buried under a
//            backlog of newer unread low rows, plus the three criticals that
//            must NOT be pinned (read / dismissed-old / dismissed-recent).
//    DUP   — the small-list shape: an unread critical INSIDE the recency
//            window, where the merge must dedupe rather than double it.
// ───────────────────────────────────────────────────────────────────────────

/** What `NotificationBell.tsx` actually requests (`api.notifications.list({ limit: 20 })`). */
const PIN_LIMIT = 20;
/** Strictly greater than PIN_LIMIT — that inequality is what buries the critical. */
const FLOOD_LOW_COUNT = 30;

const FLOOD = "flood-notifications-wire-shape-smoke";
const FLOOD_ADDRESS = "flood@notifications-wire-shape-smoke.invalid";
const DUP = "dup-notifications-wire-shape-smoke";
const DUP_ADDRESS = "dup@notifications-wire-shape-smoke.invalid";

const BURIED_CRITICAL = "flood-critical-buried";
const READ_CRITICAL = "flood-critical-read-old";
const DISMISSED_CRITICAL_OLD = "flood-critical-dismissed-old";
const DISMISSED_CRITICAL_RECENT = "flood-critical-dismissed-recent";
const WINDOW_CRITICAL = "dup-critical-recent";
const DUP_DISMISSED_CRITICAL = "dup-critical-dismissed-recent";

interface PinFixture {
    id: string;
    userId: string;
    tier: NotificationTier;
    kind: "posting" | "application" | "system";
    /** Seconds after PIN_EPOCH. Distinct per row — ties make `orderBy createdAt desc` arbitrary. */
    offset: number;
    read?: boolean;
    dismissed?: boolean;
}

const PIN_EPOCH = Date.UTC(2026, 6, 1, 0, 0, 0);
const pinCreatedAt = (offset: number) => new Date(PIN_EPOCH + offset * 1000);

const FLOOD_LOW_IDS = Array.from(
    { length: FLOOD_LOW_COUNT },
    (_, i) => `flood-low-${String(i + 1).padStart(2, "0")}`,
);

const PIN_FIXTURES: PinFixture[] = [
    // Offsets 0-2 are the OLDEST rows for this user, so all three criticals sit
    // outside the newest-PIN_LIMIT window. Only the unread, non-dismissed one
    // may be pinned back in.
    { id: DISMISSED_CRITICAL_OLD, userId: FLOOD, tier: "critical", kind: "application", offset: 0, dismissed: true },
    { id: READ_CRITICAL, userId: FLOOD, tier: "critical", kind: "application", offset: 1, read: true },
    { id: BURIED_CRITICAL, userId: FLOOD, tier: "critical", kind: "application", offset: 2 },
    // The backlog: FLOOD_LOW_COUNT (> PIN_LIMIT) unread low rows, ALL newer than
    // every critical above. This is the 700+-unread-posting-rows shape, shrunk.
    ...FLOOD_LOW_IDS.map((id, i): PinFixture => ({
        id, userId: FLOOD, tier: "low", kind: "posting", offset: 10 + i,
    })),
    // Newest row for this user, and dismissed: under ?includeDismissed=true it
    // legitimately arrives via the RECENCY query, so it is the fixture that
    // proves the merge dedupes rather than the fixture that proves the filter.
    { id: DISMISSED_CRITICAL_RECENT, userId: FLOOD, tier: "critical", kind: "application", offset: 100, dismissed: true },

    // DUP: 5 rows total, all inside a limit=20 window. The critical is in the
    // MIDDLE of the recency order, so a merge that forgot to dedupe returns it
    // at position 0 *and* at position 2.
    { id: "dup-low-1", userId: DUP, tier: "low", kind: "posting", offset: 0 },
    { id: "dup-low-2", userId: DUP, tier: "low", kind: "posting", offset: 1 },
    { id: WINDOW_CRITICAL, userId: DUP, tier: "critical", kind: "application", offset: 2 },
    { id: "dup-low-3", userId: DUP, tier: "low", kind: "posting", offset: 3 },
    { id: DUP_DISMISSED_CRITICAL, userId: DUP, tier: "critical", kind: "application", offset: 4, dismissed: true },
];

/** FLOOD's unread + non-dismissed rows: the buried critical + the whole backlog. */
const EXPECTED_FLOOD_UNREAD = FLOOD_LOW_COUNT + 1;
/** DUP's default-visible set — nothing dismissed, all within one page. */
const DUP_VISIBLE_IDS = PIN_FIXTURES
    .filter(f => f.userId === DUP && !f.dismissed)
    .map(f => f.id)
    .sort();

/**
 * Route handlers' inferred return type carries a phantom `| undefined`
 * (pre-existing codebase-wide TS quirk); at runtime every path returns a
 * NextResponse. Assert it rather than non-null-asserting at each call site.
 */
function mustRespond<T>(r: T | undefined, label: string): T {
    if (r === undefined) throw new Error(`${label} returned undefined`);
    return r;
}

type WireBody = { notifications: Array<Record<string, unknown>>; unreadCount: number };

const idsOf = (rows: Array<Record<string, unknown>>): string[] => rows.map(r => String(r.id));

/** Ids appearing more than once. The dedupe in the merge is what must keep this empty. */
function duplicateIds(rows: Array<Record<string, unknown>>): string[] {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const id of idsOf(rows)) {
        if (seen.has(id)) dups.add(id);
        seen.add(id);
    }
    return [...dups];
}

const countOf = (rows: Array<Record<string, unknown>>, id: string): number =>
    idsOf(rows).filter(x => x === id).length;

async function main() {
    // Dynamic imports: DATABASE_URL must be pinned before lib/prisma loads.
    const { prisma } = await import("@/lib/prisma");
    for (const ddl of DDL) await prisma.$executeRawUnsafe(ddl);

    const notificationsRoute = await import("@/app/api/notifications/route");

    const get = async (query = ""): Promise<{ status: number; body: WireBody }> => {
        const res = mustRespond(
            await notificationsRoute.GET(new NextRequest(`http://localhost/api/notifications${query}`)),
            `notifications GET ${query || "(no query)"}`,
        );
        return { status: res.status, body: (await res.json()) as WireBody };
    };

    try {
        await prisma.user.create({ data: { id: OWNER, email: OWNER_ADDRESS, role: "owner" } });
        await prisma.user.create({ data: { id: CREW, email: "crew@notifications-wire-shape-smoke.invalid" } });

        // Explicit, distinct createdAt values: the route orders by createdAt
        // desc, and same-millisecond ties would make the ordering arbitrary.
        let tick = 0;
        for (const f of FIXTURES) {
            const created = new Date(Date.UTC(2026, 6, 20, 12, 0, tick++));
            await prisma.notification.create({
                data: {
                    id: f.id,
                    userId: OWNER,
                    kind: f.kind,
                    tier: f.tier,
                    title: `${f.tier} / ${f.kind}`,
                    body: f.body,
                    payload: f.payload,
                    channels: f.tier === "critical" ? "in_app,email" : "in_app",
                    createdAt: created,
                    readAt: f.read ? created : null,
                    dismissedAt: f.dismissed ? created : null,
                },
            });
        }
        // A second user's unread row. Must never appear in the owner's list and
        // must never land in the owner's unreadCount.
        await prisma.notification.create({
            data: {
                id: "nwss-crew-unread", userId: CREW, kind: "system", tier: "critical",
                title: "crew-only", body: null, payload: "{}", channels: "in_app",
                createdAt: new Date(Date.UTC(2026, 6, 20, 12, 0, tick++)),
            },
        });

        // Pin fixtures (bug 2). Seeded BEFORE the owner assertions run, so those
        // execute against a DB that also holds ~35 other-user rows — the
        // cross-user scoping check below is stronger for it. Both users are
        // `crew`: `requireSession()` admits any provisioned viewer, and the pin
        // is not role-conditional.
        await prisma.user.create({ data: { id: FLOOD, email: FLOOD_ADDRESS } });
        await prisma.user.create({ data: { id: DUP, email: DUP_ADDRESS } });
        for (const f of PIN_FIXTURES) {
            const created = pinCreatedAt(f.offset);
            await prisma.notification.create({
                data: {
                    id: f.id,
                    userId: f.userId,
                    kind: f.kind,
                    tier: f.tier,
                    title: `${f.tier} / ${f.kind} / +${f.offset}s`,
                    body: null,
                    payload: JSON.stringify({ offset: f.offset }),
                    channels: f.tier === "critical" ? "in_app,email" : "in_app",
                    createdAt: created,
                    readAt: f.read ? created : null,
                    dismissedAt: f.dismissed ? created : null,
                },
            });
        }

        // In-process handler calls have no request scope, so `headers()` throws
        // and resolveViewer() would 401 every one of them. The seam is the
        // sanctioned injection point; the finally clears it so it cannot leak
        // this smoke's throwaway viewer into the next suite in the gate.
        __seedViewer({ id: OWNER, email: OWNER_ADDRESS, role: "owner" });

        // ── 1. 200 + the REAL schema parses the REAL response ────────────────
        const { status, body } = await get("?limit=50");
        if (status !== 200) {
            fail(`GET /api/notifications should 200, got ${status}`, body);
        } else {
            pass("GET /api/notifications → 200");
        }

        const parsed = NotificationsListResponseSchema.safeParse(body);
        if (!parsed.success) {
            // The dropped-`tier` regression surfaces HERE, as an
            // `invalid_type`/`invalid_union` issue at
            // `notifications.<i>.tier` with received "undefined".
            fail(
                "response does NOT satisfy NotificationsListResponseSchema — a field the " +
                "schema requires is missing from serialize() in app/api/notifications/route.ts",
                `\n${JSON.stringify(parsed.error.issues, null, 2)}`,
            );
        } else {
            pass("response satisfies the REAL NotificationsListResponseSchema (all required fields present)");
        }

        // ── 2. …and that check has TEETH ─────────────────────────────────────
        // Prove the parse above can actually fail, using this very body: strip
        // one required field and it must be rejected, with the issue naming the
        // field. Without this, a schema loosened to `.optional()` later would
        // make step 1 pass vacuously and the regression would return unseen.
        for (const field of ["tier", "createdAt"]) {
            const mutilated = JSON.parse(JSON.stringify(body)) as WireBody;
            const row = mutilated.notifications[0];
            if (!row) { fail(`teeth check needs at least one row on the wire (field ${field})`); continue; }
            delete row[field];
            const reparsed = NotificationsListResponseSchema.safeParse(mutilated);
            const names = reparsed.success
                ? []
                : reparsed.error.issues.filter(i => i.path.join(".").endsWith(field));
            if (reparsed.success) {
                fail(`teeth: schema ACCEPTED a response with '${field}' dropped — it can no longer catch this regression class`);
            } else if (names.length === 0) {
                fail(`teeth: schema rejected the '${field}'-less response but no issue points at '${field}'`, reparsed.error.issues);
            } else {
                pass(`teeth: dropping '${field}' from the wire is rejected by the schema (issue at ${names[0]!.path.join(".")})`);
            }
        }

        // ── 3. `tier` explicitly, and round-tripped per row ─────────────────
        const rows = body.notifications ?? [];
        const missingTier = rows.filter(r => typeof r.tier !== "string");
        if (missingTier.length > 0) {
            fail(
                `${missingTier.length}/${rows.length} rows carry no string 'tier' — THE regression: ` +
                `serialize() dropped it, so NotificationBell's critical-tier sort + styling is a no-op`,
                rows.map(r => ({ id: r.id, tier: r.tier })),
            );
        } else if (rows.some(r => !(NOTIFICATION_TIERS as readonly string[]).includes(r.tier as string))) {
            fail("a row's tier is not one of critical|standard|low", rows.map(r => ({ id: r.id, tier: r.tier })));
        } else {
            pass("every row carries a valid 'tier' literal");
        }

        const seededTier = new Map(FIXTURES.map(f => [f.id, f.tier as string]));
        const wrongTier = rows.filter(r => seededTier.get(r.id as string) !== r.tier);
        if (wrongTier.length > 0) {
            fail(
                "tier does not round-trip: the wire value differs from the seeded row",
                wrongTier.map(r => ({ id: r.id, onWire: r.tier, seeded: seededTier.get(r.id as string) })),
            );
        } else {
            pass("tier round-trips per row (wire value === seeded value, matched by id)");
        }

        // ── 4. All three tiers actually made it onto the wire ───────────────
        const tierSet = [...new Set(rows.map(r => String(r.tier)))].sort().join(",");
        if (tierSet !== EXPECTED_TIER_SET) {
            fail(
                `the SET of tiers on the wire ('${tierSet}') differs from the SET seeded ('${EXPECTED_TIER_SET}') — ` +
                "a serializer that hardcoded or defaulted the tier would collapse it like this",
            );
        } else {
            pass(`the set of tiers on the wire equals the set seeded (${tierSet}) — a single-value fixture can't hide a default`);
        }

        // ── 5. Filters + per-user scoping ───────────────────────────────────
        const dismissedId = FIXTURES.find(f => f.dismissed)!.id;
        const returnedIds = new Set(rows.map(r => String(r.id)));
        if (rows.length !== VISIBLE.length) {
            fail(`default list should return ${VISIBLE.length} rows (non-dismissed, owner-only), got ${rows.length}`, [...returnedIds]);
        } else if (returnedIds.has(dismissedId)) {
            fail("default list included a dismissed row", dismissedId);
        } else if (returnedIds.has("nwss-crew-unread")) {
            fail("default list leaked another user's notification");
        } else if (rows.some(r => r.userId !== OWNER)) {
            fail("default list returned a row not owned by the viewer", rows.map(r => r.userId));
        } else {
            pass(`default list: ${VISIBLE.length} owner rows, dismissed excluded, no cross-user leak`);
        }

        if (body.unreadCount !== EXPECTED_UNREAD) {
            fail(
                `unreadCount should be ${EXPECTED_UNREAD} (unread AND non-dismissed, owner only), got ${body.unreadCount}`,
            );
        } else {
            pass(`unreadCount === ${EXPECTED_UNREAD} (excludes the read row, the dismissed-but-unread row, and the other user's)`);
        }

        // The malformed-payload row must still be an object on the wire.
        const malformed = rows.find(r => r.id === "nwss-low-malformed-payload");
        if (!malformed) {
            fail("the malformed-payload fixture is missing from the response");
        } else if (typeof malformed.payload !== "object" || malformed.payload === null || Array.isArray(malformed.payload)) {
            fail("a malformed legacy payload must serialize to {}, not a string/null/array", malformed.payload);
        } else {
            pass("malformed legacy payload JSON degrades to {} and still satisfies the schema");
        }

        // ?includeDismissed=true — proves the default exclusion is the FILTER,
        // not a fixture that failed to seed.
        const withDismissed = await get("?includeDismissed=true&limit=50");
        const withDismissedParsed = NotificationsListResponseSchema.safeParse(withDismissed.body);
        const dismissedIds = new Set(withDismissed.body.notifications?.map(r => String(r.id)) ?? []);
        if (!withDismissedParsed.success) {
            fail("?includeDismissed=true response fails the schema", `\n${JSON.stringify(withDismissedParsed.error.issues, null, 2)}`);
        } else if (dismissedIds.size !== FIXTURES.length || !dismissedIds.has(dismissedId)) {
            fail(`?includeDismissed=true should return all ${FIXTURES.length} owner rows, got ${dismissedIds.size}`, [...dismissedIds]);
        } else {
            pass(`?includeDismissed=true returns all ${FIXTURES.length} owner rows (the dismissed row exists; the default merely hides it)`);
        }

        // ?unread=true — the read row drops out, the count is unchanged.
        const unreadOnly = await get("?unread=true&limit=50");
        const unreadParsed = NotificationsListResponseSchema.safeParse(unreadOnly.body);
        const unreadRows = unreadOnly.body.notifications ?? [];
        if (!unreadParsed.success) {
            fail("?unread=true response fails the schema", `\n${JSON.stringify(unreadParsed.error.issues, null, 2)}`);
        } else if (unreadRows.length !== EXPECTED_UNREAD || unreadRows.some(r => r.readAt !== null)) {
            fail(`?unread=true should return the ${EXPECTED_UNREAD} unread, non-dismissed owner rows`, unreadRows.map(r => ({ id: r.id, readAt: r.readAt })));
        } else if (unreadOnly.body.unreadCount !== EXPECTED_UNREAD) {
            fail(`?unread=true unreadCount should stay ${EXPECTED_UNREAD}, got ${unreadOnly.body.unreadCount}`);
        } else {
            pass(`?unread=true returns only the ${EXPECTED_UNREAD} unread rows, still schema-valid`);
        }

        // ══ BUG 2 — the critical-tier pin ════════════════════════════════════
        // Everything below drives the FLOOD / DUP users. Re-seeding the viewer
        // seam swaps identity; the finally still clears it.
        __seedViewer({ id: FLOOD, email: FLOOD_ADDRESS, role: "crew" });

        // ── 6. The premise, PROVEN rather than assumed ───────────────────────
        // "The critical is in the response" is only meaningful if the critical
        // could not have arrived via recency. Two independent proofs.

        // (a) Fixture arithmetic, read back from the DB rather than trusted:
        //     the buried critical predates every row in the backlog, and the
        //     backlog alone is larger than the page.
        const buriedRow = await prisma.notification.findUnique({
            where: { id: BURIED_CRITICAL },
            select: { createdAt: true, tier: true, readAt: true, dismissedAt: true },
        });
        const floodLowRows = await prisma.notification.findMany({
            where: { userId: FLOOD, tier: "low" },
            select: { id: true, createdAt: true },
        });
        const oldestLow = floodLowRows.length > 0
            ? Math.min(...floodLowRows.map(r => r.createdAt.getTime()))
            : Number.NEGATIVE_INFINITY;
        if (!buriedRow) {
            fail(`premise: ${BURIED_CRITICAL} failed to seed`);
        } else if (floodLowRows.length !== FLOOD_LOW_COUNT) {
            fail(`premise: expected ${FLOOD_LOW_COUNT} low rows for the flood user, got ${floodLowRows.length}`);
        } else if (FLOOD_LOW_COUNT <= PIN_LIMIT) {
            fail(`premise: FLOOD_LOW_COUNT (${FLOOD_LOW_COUNT}) must exceed the requested limit (${PIN_LIMIT}) or nothing is buried`);
        } else if (buriedRow.createdAt.getTime() >= oldestLow) {
            fail(
                `premise: the unread critical (${buriedRow.createdAt.toISOString()}) is NOT older than every low row ` +
                `(oldest low ${new Date(oldestLow).toISOString()}) — the fixture no longer buries it`,
            );
        } else if (buriedRow.readAt !== null || buriedRow.dismissedAt !== null || buriedRow.tier !== "critical") {
            fail("premise: the buried fixture must be an UNREAD, non-dismissed critical", buriedRow);
        } else {
            pass(
                `premise (a): the unread critical is older than all ${FLOOD_LOW_COUNT} low rows, ` +
                `and ${FLOOD_LOW_COUNT} newer rows > limit=${PIN_LIMIT}`,
            );
        }

        // (b) Run the PRE-FIX query verbatim (pure recency, same where / order /
        //     take) against this same DB and show the critical is absent from
        //     it. This is the measured production failure, reproduced.
        const recencyOnly = await prisma.notification.findMany({
            where: { userId: FLOOD, dismissedAt: null },
            orderBy: { createdAt: "desc" },
            take: PIN_LIMIT,
            select: { id: true },
        });
        if (recencyOnly.length !== PIN_LIMIT) {
            fail(`premise (b): the recency window should be full (${PIN_LIMIT} rows), got ${recencyOnly.length}`);
        } else if (recencyOnly.some(r => r.id === BURIED_CRITICAL)) {
            fail(
                `premise (b): ${BURIED_CRITICAL} IS inside the pure-recency newest-${PIN_LIMIT} window, so this ` +
                "fixture cannot prove the pin does anything — the flood is not deep enough",
            );
        } else {
            pass(
                `premise (b): the PRE-FIX query (orderBy createdAt desc + take ${PIN_LIMIT}) does NOT contain the ` +
                "unread critical — exactly the production failure (0 of 4 criticals in the newest-20)",
            );
        }

        // ── 7. THE core regression: the buried critical must be returned ─────
        const flood = await get(`?limit=${PIN_LIMIT}`);
        const floodRows = flood.body.notifications ?? [];
        const floodIds = idsOf(floodRows);
        const floodParsed = NotificationsListResponseSchema.safeParse(flood.body);
        if (flood.status !== 200) {
            fail(`flood GET ?limit=${PIN_LIMIT} should 200, got ${flood.status}`, flood.body);
        } else if (!floodParsed.success) {
            fail("the pinned response fails the schema (pinned rows go through the same serialize())",
                `\n${JSON.stringify(floodParsed.error.issues, null, 2)}`);
        } else if (!floodIds.includes(BURIED_CRITICAL)) {
            fail(
                `THE REGRESSION: the unread critical ${BURIED_CRITICAL} is ABSENT from ?limit=${PIN_LIMIT} — it is ` +
                `buried under ${FLOOD_LOW_COUNT} newer low-tier rows, so the critical-tier pin (pinnedWhere + merge ` +
                "in app/api/notifications/route.ts) is missing or no longer merges ahead of the recency window. " +
                "On real data this hid genuine application rejections from the bell entirely.",
                floodIds,
            );
        } else {
            pass(
                `pin: the unread critical is present at index ${floodIds.indexOf(BURIED_CRITICAL)} of ` +
                `?limit=${PIN_LIMIT} despite being older than all ${FLOOD_LOW_COUNT} backlog rows`,
            );
        }

        // ── 8. `limit` is still respected — the merge slices ────────────────
        if (floodRows.length > PIN_LIMIT) {
            fail(
                `pin: response carries ${floodRows.length} rows for ?limit=${PIN_LIMIT} — the merge must end in ` +
                "`.slice(0, limit)`; pinned rows are not a bonus page",
            );
        } else if (floodRows.length !== PIN_LIMIT) {
            fail(
                `pin: the window should be full at ${PIN_LIMIT} rows ` +
                `(${PIN_FIXTURES.filter(f => f.userId === FLOOD && !f.dismissed).length} visible for this user), ` +
                `got ${floodRows.length}`,
                floodIds,
            );
        } else {
            pass(`pin: limit respected — exactly ${PIN_LIMIT} rows returned (1 pinned + ${PIN_LIMIT - 1} of the recency window)`);
        }

        // ── 9. No duplicates in the flooded response ────────────────────────
        const floodDups = duplicateIds(floodRows);
        if (floodDups.length > 0) {
            fail("pin: duplicate ids in the response — the merge's dedupe is broken", floodDups);
        } else {
            pass("pin: ids are unique in the flooded response");
        }

        // ── 10. A READ critical outside the window is NOT pinned ────────────
        if (floodIds.includes(READ_CRITICAL)) {
            fail(
                `pin: the READ critical ${READ_CRITICAL} was pulled in — pinnedWhere must force \`readAt: null\`, ` +
                "otherwise every critical the user has already seen permanently occupies the pin slots",
            );
        } else {
            pass("pin: a read critical outside the recency window is NOT pinned (pin is unread-only)");
        }

        // ── 11. DISMISSED criticals are absent from the default view ────────
        const dismissedLeak = [DISMISSED_CRITICAL_OLD, DISMISSED_CRITICAL_RECENT].filter(id => floodIds.includes(id));
        if (dismissedLeak.length > 0) {
            fail("pin: a dismissed critical appeared in the default view — dismissing must stay a hide", dismissedLeak);
        } else {
            pass("pin: both dismissed criticals stay hidden from the default view");
        }

        // ── 12. `unreadCount` is untouched by the pin ───────────────────────
        if (flood.body.unreadCount !== EXPECTED_FLOOD_UNREAD) {
            fail(
                `pin: unreadCount should be ${EXPECTED_FLOOD_UNREAD} (the ${FLOOD_LOW_COUNT} low rows + the buried ` +
                `critical; read and dismissed excluded), got ${flood.body.unreadCount} — the count is a separate ` +
                "query and must not be derived from the merged page",
            );
        } else {
            pass(`pin: unreadCount === ${EXPECTED_FLOOD_UNREAD}, unaffected by the merge`);
        }

        // ── 13-14. ?includeDismissed=true — the pin must not re-pin ─────────
        // Under this flag the base `where` drops its `dismissedAt` clause, so
        // pinnedWhere's OWN forced `dismissedAt: null` is the only thing keeping
        // dismissed criticals out of the pin. DISMISSED_CRITICAL_OLD is outside
        // the recency window, so the pin path is the ONLY way it could appear:
        // its absence is a direct test of that clause. DISMISSED_CRITICAL_RECENT
        // is the newest row, so it legitimately arrives via recency — it must
        // appear EXACTLY once.
        const floodArchive = await get(`?includeDismissed=true&limit=${PIN_LIMIT}`);
        const archiveRows = floodArchive.body.notifications ?? [];
        const archiveIds = idsOf(archiveRows);
        if (archiveIds.includes(DISMISSED_CRITICAL_OLD)) {
            fail(
                `pin: ?includeDismissed=true re-pinned the dismissed critical ${DISMISSED_CRITICAL_OLD}, which is ` +
                "OUTSIDE the recency window — pinnedWhere must force `dismissedAt: null` and not inherit it from `where`",
                archiveIds,
            );
        } else {
            pass("pin: a dismissed critical outside the window is never re-pinned, even under ?includeDismissed=true");
        }

        const archiveDups = duplicateIds(archiveRows);
        const recentDismissedCount = countOf(archiveRows, DISMISSED_CRITICAL_RECENT);
        if (archiveDups.length > 0) {
            fail("pin: duplicate ids under ?includeDismissed=true", archiveDups);
        } else if (recentDismissedCount !== 1) {
            fail(
                `pin: the newest (dismissed) critical should appear exactly once under ?includeDismissed=true via the ` +
                `recency query, got ${recentDismissedCount}`,
                archiveIds,
            );
        } else if (!archiveIds.includes(BURIED_CRITICAL)) {
            fail(`pin: the unread critical ${BURIED_CRITICAL} is missing under ?includeDismissed=true`, archiveIds);
        } else if (archiveRows.length !== PIN_LIMIT) {
            fail(`pin: ?includeDismissed=true should still cap at ${PIN_LIMIT} rows, got ${archiveRows.length}`);
        } else {
            pass("pin: ?includeDismissed=true — unread critical pinned, the dismissed newest row appears exactly once, limit held");
        }

        // ── 15. ?unread=true stays coherent with the pin ────────────────────
        const floodUnread = await get(`?unread=true&limit=${PIN_LIMIT}`);
        const floodUnreadRows = floodUnread.body.notifications ?? [];
        const floodUnreadIds = idsOf(floodUnreadRows);
        const floodUnreadDups = duplicateIds(floodUnreadRows);
        if (!floodUnreadIds.includes(BURIED_CRITICAL)) {
            fail(`pin: ?unread=true dropped the buried unread critical ${BURIED_CRITICAL}`, floodUnreadIds);
        } else if (floodUnreadDups.length > 0) {
            fail("pin: ?unread=true returned duplicate ids", floodUnreadDups);
        } else if (floodUnreadRows.length !== PIN_LIMIT) {
            fail(`pin: ?unread=true should return ${PIN_LIMIT} rows, got ${floodUnreadRows.length}`, floodUnreadIds);
        } else if (floodUnreadRows.some(r => r.readAt !== null || r.dismissedAt !== null)) {
            fail("pin: ?unread=true leaked a read or dismissed row", floodUnreadRows.map(r => ({ id: r.id, readAt: r.readAt, dismissedAt: r.dismissedAt })));
        } else {
            pass(`pin: ?unread=true — critical present, no duplicates, ${PIN_LIMIT} rows, nothing read or dismissed`);
        }

        // ── 16-17. A critical ALREADY inside the window: dedupe + lossless ──
        // The DUP user's whole set fits in one page, and its critical sits in
        // the MIDDLE of the recency order — so a merge that skipped the dedupe
        // returns it twice, and one that sliced wrongly loses a low row.
        __seedViewer({ id: DUP, email: DUP_ADDRESS, role: "crew" });
        const dupResp = await get(`?limit=${PIN_LIMIT}`);
        const dupRows = dupResp.body.notifications ?? [];
        const dupRowIds = idsOf(dupRows);
        const inWindowCount = countOf(dupRows, WINDOW_CRITICAL);
        const dupDups = duplicateIds(dupRows);
        if (dupResp.status !== 200) {
            fail(`DUP GET should 200, got ${dupResp.status}`, dupResp.body);
        } else if (inWindowCount !== 1) {
            fail(
                `pin: a critical already inside the recency window must be returned ONCE, got ${inWindowCount} — ` +
                "the merge's `pinnedIds` dedupe is missing",
                dupRowIds,
            );
        } else if (dupDups.length > 0) {
            fail("pin: duplicate ids for the in-window critical case", dupDups);
        } else if (dupRowIds[0] !== WINDOW_CRITICAL) {
            fail(`pin: the unread critical should lead the merged page, got '${dupRowIds[0]}' first`, dupRowIds);
        } else {
            pass("pin: an in-window unread critical is returned exactly once and leads the page (dedupe works)");
        }

        const dupSorted = [...dupRowIds].sort();
        if (dupSorted.join(",") !== DUP_VISIBLE_IDS.join(",")) {
            fail(
                "pin: the merge is LOSSY — the returned set differs from the seeded visible set, so pinning a row " +
                "already in the window silently evicted another row",
                { returned: dupSorted, expected: DUP_VISIBLE_IDS },
            );
        } else {
            pass(`pin: merge is lossless when the critical is in-window — exactly the ${DUP_VISIBLE_IDS.length} visible rows, dismissed critical excluded`);
        }
    } finally {
        // Clear the identity seam FIRST — a seam left armed here would hand the
        // next suite in the pre-push gate this smoke's throwaway viewer.
        __resetViewer();
        try {
            const { prisma } = await import("@/lib/prisma");
            await prisma.$disconnect();
        } catch { /* best-effort */ }
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            try { unlinkSync(TMP_DB + suffix); } catch { /* may not exist */ }
        }
    }
}

/**
 * The exit path lives OUT here, not at the bottom of `main()`, so no early
 * `return` inside the body can skip it — the false-green class fixed in 0a235be
 * (`resume-list-smoke.ts` printed `[FAIL]` and still exited 0, and the pre-push
 * gate, which reads only the exit code, passed a red suite).
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().then(finish, (e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
