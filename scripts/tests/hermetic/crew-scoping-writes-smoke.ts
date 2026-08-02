/**
 * Route-layer per-user scoping on the WRITE surface — docs/multi-user-crew.html
 * §2.4's second invariant ("every crew-allowed handler MUST scope its queries by
 * session.user.id"), the mutating half.
 *
 *   npx tsx scripts/tests/hermetic/crew-scoping-writes-smoke.ts
 *
 * WHY THIS FILE EXISTS — the half `crew-scoping-routes-smoke.ts` cannot reach.
 *
 *   That suite is READ-ONLY by construction: it drives every crew-allowed GET,
 *   scans the raw body for another user's marker, and asserts a foreign id
 *   answers 404. It ends with an explicit "the read phases mutated nothing"
 *   census, which is the honest admission that the write surface is untested.
 *
 *   The write surface is the more dangerous one. A missing `userId` on a read
 *   LEAKS data; the same omission on a write DESTROYS it. And the write bug is
 *   quieter: the shape being hunted here is
 *
 *       prisma.X.updateMany({ where: { id } })      // no userId
 *       prisma.X.deleteMany({ where: { id } })      // no userId
 *
 *   inside a handler that has already answered 404 (or 200-with-count-0) on some
 *   OTHER basis. There is no error, no stack trace, and no wrong-looking
 *   response — the caller sees a perfectly ordinary rejection while another
 *   user's row is silently rewritten or gone.
 *
 * THE TWO ASSERTIONS, AND WHY THE SECOND IS THE LOAD-BEARING ONE.
 *
 *   Every foreign-id attempt below asserts BOTH:
 *
 *     1. The RESPONSE refuses — the declared status, never 403 (§2.3 reserves
 *        403 for the ROLE decision; using it for "not yours" turns the route
 *        into an existence oracle), and never a success.
 *     2. The DATABASE is byte-for-byte unchanged — every row of every table
 *        under test, snapshotted before and re-read after, compared as
 *        canonical JSON.
 *
 *   Only (2) catches the bug. A handler can return a flawless 404 having already
 *   run the unscoped `updateMany` a few lines earlier, and (1) alone reports
 *   PASS on it. That is not hypothetical — it is precisely the failure the teeth
 *   check in phase 2 constructs and proves this file rejects.
 *
 *   The snapshot is whole-database, not per-target-row, on purpose: a botched
 *   where-clause does not politely restrict itself to the id you named. A
 *   `deleteMany({ where: {} })` empties the table, and a per-row re-read of the
 *   named target would see "still absent, as expected" and pass.
 *
 * BOTH DIRECTIONS, PLUS A CONTROL.
 *
 *   Phase 3 — as CREW B, naming the owner's and crew A's ids. The classic bug.
 *   Phase 4 — as the OWNER, naming crew A's and crew B's ids. Independent: a
 *             handler that resolves its userId via `resolveOwner()` instead of
 *             the session is INVISIBLE to phase 3 (the owner's id is the one it
 *             uses anyway) and only misbehaves in this direction.
 *   Phases 5 + 6 — the same routes against the caller's OWN ids, as the owner
 *             and then as crew B, asserting they SUCCEED and change only that
 *             caller's rows. Without this the suite could pass gloriously with
 *             every route returning 404 to everybody.
 *
 *   Crew A is never the actor and never the target of an own-write, so their
 *   fixture stays a pristine third party for the whole run — any write that
 *   touches it is unambiguously wrong.
 *
 * ORDERING. Phases 3 and 4 assert ZERO database delta, so they must run before
 * the own-write phases legitimately mutate things. Within phases 5/6 the case
 * list is ordered PATCH-before-DELETE and child-before-parent, so a cascade
 * never removes a row a later case still needs.
 *
 * Hermetic: no network, no PM2, no Gemini, no Google. The schema is pushed into
 * a THROWAWAY SQLite file in /tmp (`prisma db push`) with DATABASE_URL pinned
 * before any import; dev.db / prod.db are never opened. Routes that would leave
 * the box (a watchlist crawl, a Gcal sync, any Gemini callsite) are covered only
 * in the directions that refuse BEFORE reaching the side effect, and are listed
 * with their reason in SKIPPED below.
 */

const SCRATCH_DB = `/tmp/crew-scoping-writes-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
// Belt-and-braces against a write path that would leave the box. `EMAIL_ENABLED`
// gates lib/email/send.ts; `GCAL_SYNC_ENABLED` gates lib/calendar/sync.ts. The
// cases below are also chosen so neither gate is the ONLY thing standing in the
// way (fixture events carry no `scheduledAt` and no `gcalEventId`, which makes
// both helpers benign no-ops on their own), but a suite that mails the owner
// when one assumption slips is not a suite anyone wants in a pre-push hook.
process.env.EMAIL_ENABLED = "0";
process.env.GCAL_SYNC_ENABLED = "0";
// Every phase chooses its actor through the `__seedViewer` seam and must not
// inherit a break-glass escape from the shell the pre-push hook runs in (P5.1.3).
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { NextRequest } from "next/server";
import { __seedViewer, __resetViewer, type Viewer } from "@/lib/viewer";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
function section(title: string) { console.log(`\n── ${title}`); }

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

const OWNER: Viewer = { id: "owner-crew-writes-smoke", email: "owner@crew-writes-smoke.invalid", role: "owner" };
const CREW_A: Viewer = { id: "crew-a-crew-writes-smoke", email: "crew-a@crew-writes-smoke.invalid", role: "crew" };
const CREW_B: Viewer = { id: "crew-b-crew-writes-smoke", email: "crew-b@crew-writes-smoke.invalid", role: "crew" };
/**
 * A fourth user that no route is ever driven against. Phase 2 vandalises its
 * rows with the exact unscoped statements this suite exists to catch, to prove
 * the detector detects. Keeping that vandalism off the three real fixtures is
 * what lets the teeth check use REAL writes and REAL snapshots rather than a
 * synthetic diff that only proves the comparison function compares.
 */
const CANARY: Viewer = { id: "canary-crew-writes-smoke", email: "canary@crew-writes-smoke.invalid", role: "crew" };

/** Per-user token stamped into every text column of that user's rows. */
const MARK: Record<string, string> = {
    [OWNER.id]: "OWNERWMARK",
    [CREW_A.id]: "CREWAWMARK",
    [CREW_B.id]: "CREWBWMARK",
    [CANARY.id]: "CANARYWMARK",
};

interface Fixture {
    viewer: Viewer;
    mark: string;
    applicationId: string;
    contactId: string;
    eventId: string;
    watchlistId: string;
    postingId: string;
    canonId: string;
    notificationId: string;
    taskId: string;
    goalId: string;
    blacklistId: string;
    snapshotId: string;
    workRoleId: string;
    projectId: string;
    educationId: string;
}

type Prisma = typeof import("@/lib/prisma").prisma;

/**
 * One row in every table a crew-allowed write can reach, all tagged with the
 * user's marker. Ids are deterministic (`<table>-<mark>`) rather than cuids so a
 * failure message names the owner of the mutated row directly.
 */
async function createFixture(prisma: Prisma, viewer: Viewer): Promise<Fixture> {
    const mark = MARK[viewer.id];
    const id = (table: string) => `${table}-${mark.toLowerCase()}`;

    // `name` carries the marker for the same reason every other row does: the
    // collateral-damage checks in phases 7 and 8 attribute a changed row by
    // scanning it for a foreign marker, and an unmarked row is invisible to
    // them. The User row is the one a role-escalation or account-clobber bug
    // would touch, so leaving it unattributed was exactly the wrong omission.
    await prisma.user.create({
        data: { id: viewer.id, email: viewer.email, role: viewer.role, name: `${mark} Person` },
    });

    const application = await prisma.application.create({
        data: {
            id: id("app"),
            userId: viewer.id,
            company: `${mark} Industries`,
            normalizedCompany: `${mark.toLowerCase()}industries`,
            normalizedRole: `${mark.toLowerCase()}engineer`,
            role: `${mark} Engineer`,
            status: "APPLIED",
            track: "career",
            nextSteps: `${mark} follow up`,
        },
    });
    const contact = await prisma.contact.create({
        data: { id: id("contact"), applicationId: application.id, name: `${mark} Recruiter`, notes: `${mark} notes` },
    });
    // No `scheduledAt` and no `gcalEventId`: syncEventToGcal returns null on the
    // first line for an event with no schedule, and purgeApplicationEvents only
    // reaches Google for rows that carry a gcalEventId. Both write paths below
    // are therefore inert without depending on the env gates above.
    const event = await prisma.applicationEvent.create({
        data: {
            id: id("event"),
            applicationId: application.id,
            kind: "NOTE",
            title: `${mark} note`,
            notes: `${mark} event notes`,
            occurredAt: new Date("2026-07-01T12:00:00Z"),
        },
    });
    const watchlist = await prisma.watchlist.create({
        data: {
            id: id("wl"),
            userId: viewer.id,
            name: `${mark} watchlist`,
            kind: "greenhouse",
            config: JSON.stringify({ kind: "greenhouse", companyName: `${mark} Industries`, boardSlug: mark.toLowerCase() }),
            track: "career",
        },
    });
    const posting = await prisma.jobPosting.create({
        data: {
            id: id("posting"),
            watchlistId: watchlist.id,
            externalId: `${mark}-external-1`,
            company: `${mark} Industries`,
            title: `${mark} Engineer`,
            sourceUrl: `https://jobs.invalid/${mark.toLowerCase()}/1`,
            status: "new",
            raw: "{}",
        },
    });
    const canon = await prisma.canon.create({
        data: {
            id: id("canon"),
            userId: viewer.id,
            name: `${mark} Canon`,
            slug: `${mark.toLowerCase()}-canon`,
            track: "career",
            description: `${mark} description`,
        },
    });
    const notification = await prisma.notification.create({
        data: {
            id: id("notif"),
            userId: viewer.id,
            kind: "system",
            tier: "standard",
            title: `${mark} notification`,
            payload: "{}",
        },
    });
    const task = await prisma.task.create({
        data: { id: id("task"), userId: viewer.id, text: `${mark} task`, status: "TODO" },
    });
    const goal = await prisma.lifeGoal.create({
        data: { id: id("goal"), userId: viewer.id, text: `${mark} goal` },
    });
    const blacklist = await prisma.blacklistedCompany.create({
        data: {
            id: id("blacklist"),
            userId: viewer.id,
            name: `${mark} BadCo`,
            normalizedName: `${mark.toLowerCase()}badco`,
        },
    });
    const snapshot = await prisma.profileSnapshot.create({
        data: { id: id("snap"), userId: viewer.id, label: `${mark} snapshot`, payload: "{}" },
    });
    // GlobalSetting has no id-taking route — the only crew-reachable writer is
    // POST /api/settings, which keys on the caller's own userId. It is here so
    // phase 7's cross-user clobber check has an owner row to find intact.
    await prisma.globalSetting.create({
        data: { id: id("settings"), userId: viewer.id, dashTitles: JSON.stringify({ mark }) },
    });

    const profile = await prisma.profile.create({
        data: { id: id("profile"), userId: viewer.id, headline: `${mark} Person` },
    });
    const workRole = await prisma.workRole.create({
        data: {
            id: id("workrole"),
            profileId: profile.id,
            company: `${mark} Industries`,
            title: `${mark} Engineer`,
            startDate: new Date("2024-01-01T00:00:00Z"),
        },
    });
    const project = await prisma.project.create({
        data: { id: id("project"), profileId: profile.id, name: `${mark} Project` },
    });
    const education = await prisma.education.create({
        data: { id: id("education"), profileId: profile.id, institution: `${mark} University` },
    });

    return {
        viewer,
        mark,
        applicationId: application.id,
        contactId: contact.id,
        eventId: event.id,
        watchlistId: watchlist.id,
        postingId: posting.id,
        canonId: canon.id,
        notificationId: notification.id,
        taskId: task.id,
        goalId: goal.id,
        blacklistId: blacklist.id,
        snapshotId: snapshot.id,
        workRoleId: workRole.id,
        projectId: project.id,
        educationId: education.id,
    };
}

// ---------------------------------------------------------------------------
// Whole-database snapshot + diff
//
// Read through raw `SELECT *` rather than a Prisma `select`, so a column added
// to the schema tomorrow is covered without touching this file — the point is
// "byte-for-byte unchanged", and a hand-listed column set silently stops being
// that the moment the schema moves.
// ---------------------------------------------------------------------------

/** Every table a crew-allowed write could plausibly reach. */
const SNAPSHOT_TABLES = [
    "User", "Profile", "WorkRole", "Project", "Education", "ProfileSnapshot",
    "Application", "Contact", "ApplicationEvent",
    "Watchlist", "JobPosting", "Canon",
    "Notification", "Task", "LifeGoal", "BlacklistedCompany",
    "GlobalSetting", "GeneratedResume", "AiUsage",
] as const;

function encodeValue(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "bigint") return `"bigint:${v.toString()}"`;
    if (v instanceof Date) return `"date:${v.toISOString()}"`;
    if (v instanceof Uint8Array) return `"bytes:${Buffer.from(v).toString("base64")}"`;
    return JSON.stringify(v);
}

/** Column-order-independent canonical form, so a driver reordering columns is not a "change". */
function canonicalRow(row: Record<string, unknown>): string {
    return `{${Object.keys(row).sort().map(k => `${JSON.stringify(k)}:${encodeValue(row[k])}`).join(",")}}`;
}

type Snapshot = Map<string, string>;

async function snapshot(prisma: Prisma): Promise<Snapshot> {
    const out: Snapshot = new Map();
    for (const table of SNAPSHOT_TABLES) {
        // Table names come from the frozen literal list above — never from input.
        const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}"`);
        for (const row of rows) {
            const key = `${table}#${String(row.id ?? canonicalRow(row))}`;
            out.set(key, canonicalRow(row));
        }
    }
    return out;
}

interface Change { key: string; before: string | null; after: string | null }

function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
    const changes: Change[] = [];
    for (const [key, value] of before) {
        const now = after.get(key);
        if (now === undefined) changes.push({ key, before: value, after: null });
        else if (now !== value) changes.push({ key, before: value, after: now });
    }
    for (const [key, value] of after) {
        if (!before.has(key)) changes.push({ key, before: null, after: value });
    }
    return changes;
}

function describeChange(c: Change): string {
    if (c.after === null) return `${c.key} DELETED`;
    if (c.before === null) return `${c.key} CREATED`;
    return `${c.key} MUTATED`;
}

/** A change is a foreign one when either version of the row carries a foreign marker. */
function touchesMarks(c: Change, marks: string[]): string[] {
    const blob = `${c.before ?? ""}${c.after ?? ""}`;
    return marks.filter(m => blob.includes(m));
}

// ---------------------------------------------------------------------------
// Driving real route handlers in-process
// ---------------------------------------------------------------------------

type Method = "POST" | "PATCH" | "PUT" | "DELETE";

interface Res {
    status: number;
    /** Raw body text. */
    text: string;
    /** Parsed body, `null` when the response was not JSON. */
    body: unknown;
}

function field(body: unknown, key: string): unknown {
    return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Call a real exported handler. `route` is the path under app/api; `id` fills the
 * dynamic segment a `[id]` route awaits.
 *
 * A throw is NOT swallowed into a status. These handlers run with a viewer
 * seeded, so the body really executes; an exception is a genuine failure worth
 * reporting verbatim rather than a rejection to classify. (It is also the shape
 * a scoping bug can take — an unscoped `update` throwing P2025 after the write
 * it should never have attempted.)
 */
async function drive(
    route: string,
    method: Method,
    url: string,
    opts?: { body?: unknown; id?: string },
): Promise<Res> {
    const mod = await import(`@/app/api/${route}/route`);
    const handler = mod[method] as ((req: NextRequest, ctx?: unknown) => Promise<Response | undefined>) | undefined;
    if (typeof handler !== "function") throw new Error(`/api/${route} exports no ${method}`);

    const req = new NextRequest(`http://crew-writes-smoke.invalid${url}`, {
        method,
        ...(opts?.body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(opts.body) }),
    });
    const ctx = opts?.id === undefined ? undefined : { params: Promise.resolve({ id: opts.id }) };
    const res = await handler(req, ctx);
    if (!res) throw new Error(`/api/${route} ${method} returned undefined`);
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, text, body };
}

// ---------------------------------------------------------------------------
// The rule, as a pure predicate
//
// Kept pure and separate from the reporting so phase 2 can point it at a REAL
// unscoped write and prove it rejects one. A predicate nobody has watched fail
// is a predicate nobody has shown can fail.
// ---------------------------------------------------------------------------

/**
 * What a route is expected to answer when handed an id it does not own.
 *
 * `status` is per-case rather than a hardcoded 404 because two crew-allowed
 * routes legitimately answer otherwise, and pinning the real value is what makes
 * a future drift visible instead of tolerated:
 *
 *   - `bulkNoop` routes take an ARRAY of ids and are documented to silently drop
 *     the ones the caller does not own (see the header of
 *     app/api/applications/bulk-track/route.ts). 200 with a zero count is the
 *     contract; the security property is the count and the empty DB delta.
 *   - `/api/goals` answers 500, not 404 — see the GOALS note on its cases below.
 */
type Refusal =
    | { kind: "refused"; status: number; why?: string }
    | { kind: "bulkNoop"; countField: string };

interface RefusalCheckInput {
    res: Res;
    changes: Change[];
    expect: Refusal;
}

/**
 * Returns null when the foreign-id attempt was correctly refused, else how it was
 * not. Order matters: the DATABASE verdict comes first because it is the one that
 * matters, and a suite that reported "wrong status code" while a row was being
 * deleted underneath would be burying the incident under the paperwork.
 */
function refusalViolation({ res, changes, expect }: RefusalCheckInput): string | null {
    if (changes.length > 0) {
        return (
            `THE DATABASE CHANGED (${changes.length} row(s): ${changes.slice(0, 5).map(describeChange).join(", ")}` +
            `${changes.length > 5 ? ", …" : ""}). The handler answered ${res.status}, but a foreign id must be a ` +
            `complete no-op — this is an unscoped updateMany/deleteMany writing through another user's row.`
        );
    }
    if (res.status === 403) {
        return (
            `answered 403. §2.3 reserves 403 for the ROLE decision; using it for "that row is not yours" makes the ` +
            `route an existence oracle — "this id is real, it just is not yours" enumerates the other user's corpus.`
        );
    }
    if (expect.kind === "bulkNoop") {
        if (res.status !== 200) return `bulk route expected 200 + a zero count, got ${res.status}`;
        const count = field(res.body, expect.countField);
        if (count !== 0) {
            return (
                `bulk route reported ${expect.countField}=${String(count)} for ids it does not own — expected 0. ` +
                `(The DB is unchanged, so this is a miscount rather than a write, but the caller is being told a ` +
                `foreign row moved.)`
            );
        }
        return null;
    }
    if (res.status < 400) {
        return `answered ${res.status} — a foreign id must never be reported as a success, even with no DB change`;
    }
    if (res.status !== expect.status) {
        return (
            `expected ${expect.status}, got ${res.status}${expect.why ? ` (declared: ${expect.why})` : ""}. ` +
            `The DB is unchanged, so scoping still holds — if you deliberately CHANGED this route's rejection code, ` +
            `update this case's \`expect.status\` (and its \`why\`) rather than widening the check.`
        );
    }
    return null;
}

/** Returns null when an own-id write correctly succeeded and touched nobody else. */
function ownWriteViolation(
    res: Res,
    changes: Change[],
    opts: { status: number; mustChange: boolean; foreignMarks: string[]; countField?: string },
): string | null {
    if (res.status !== opts.status) {
        return `expected ${opts.status} on the caller's OWN row, got ${res.status}`;
    }
    const foreign = changes.filter(c => touchesMarks(c, opts.foreignMarks).length > 0);
    if (foreign.length > 0) {
        return (
            `writing its OWN row also touched ${foreign.length} foreign row(s): ` +
            `${foreign.slice(0, 5).map(c => `${describeChange(c)} [${touchesMarks(c, opts.foreignMarks).join("/")}]`).join(", ")}`
        );
    }
    if (opts.mustChange && changes.length === 0) {
        return (
            `answered ${res.status} but changed NOTHING. The foreign-id phases above assert this route refuses; ` +
            `if it also refuses its own owner then those assertions are vacuous — the route is simply broken.`
        );
    }
    if (opts.countField !== undefined) {
        const count = field(res.body, opts.countField);
        if (count !== 1) return `expected ${opts.countField}=1 on the caller's own row, got ${String(count)}`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// The case table
//
// One entry per (route, method) on the crew-allowed mutating surface, listed in
// the order phases 5 + 6 must execute them (every PATCH/PUT/POST before any
// DELETE; children before parents, so a cascade never removes a row a later case
// still needs).
// ---------------------------------------------------------------------------

interface WriteCase {
    label: string;
    route: string;
    method: Method;
    /** Path-segment id, when the route has a `[id]`. */
    id?: (f: Fixture) => string;
    /** Query string appended to the route path. */
    query?: (f: Fixture) => string;
    /** JSON request body. */
    body?: (f: Fixture) => unknown;
    /**
     * TEETH ONLY — never set on a real case. Replaces the `drive()` call with an
     * in-test stand-in, so phase 2 can push a deliberately-unscoped statement
     * through the SAME per-case pipeline the real phases use (snapshot → drive →
     * snapshot → diff → predicate → verdict) and require it to come back FAILED.
     * Without this the teeth prove only that the predicate rejects; they do not
     * prove the plumbing around it carries the rejection to an exit code.
     */
    handler?: (f: Fixture) => Promise<Res>;
    /** What a foreign id must answer. */
    expect: Refusal;
    /** Own-id success status (default 200). */
    ownStatus?: number;
    /** Own-id count assertion, for the bulk routes. */
    ownCountField?: string;
    /**
     * Skip the own-id direction, with the reason. Only ever set for a route whose
     * SUCCESS path leaves the box — the refusal path is still covered, because it
     * returns before reaching the side effect.
     */
    skipOwn?: string;
}

const ISO = "2026-07-15T09:00:00.000Z";

const CASES: WriteCase[] = [
    // ── applications ───────────────────────────────────────────────────────
    {
        label: "PATCH /api/applications",
        route: "applications", method: "PATCH",
        body: f => ({ id: f.applicationId, nextSteps: `${f.mark} patched` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "PATCH /api/applications/contacts",
        route: "applications/contacts", method: "PATCH",
        body: f => ({ id: f.contactId, notes: `${f.mark} patched` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "PATCH /api/applications/events",
        route: "applications/events", method: "PATCH",
        body: f => ({ id: f.eventId, notes: `${f.mark} patched` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        // The parent-id direction: a foreign applicationId must not become a
        // child row hanging off someone else's application.
        label: "POST /api/applications/contacts (parent applicationId)",
        route: "applications/contacts", method: "POST",
        body: f => ({ applicationId: f.applicationId, name: `${f.mark} new contact` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "POST /api/applications/events (parent applicationId)",
        route: "applications/events", method: "POST",
        body: f => ({ applicationId: f.applicationId, kind: "NOTE", title: `${f.mark} new note` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        // Documented bulk contract: cross-user ids silently drop. The security
        // property is `updated: 0` plus an untouched DB, not a 404.
        label: "POST /api/applications/bulk-track",
        route: "applications/bulk-track", method: "POST",
        body: f => ({ ids: [f.applicationId], track: "side" }),
        expect: { kind: "bulkNoop", countField: "updated" },
        ownCountField: "updated",
    },

    // ── notifications ──────────────────────────────────────────────────────
    {
        // The `updateMany({ where: { id: { in: ids } } })` shape this whole file
        // is named for — one missing `userId` and any caller marks any other
        // user's notifications read.
        label: "PATCH /api/notifications (ids filter)",
        route: "notifications", method: "PATCH",
        body: f => ({ ids: [f.notificationId], readAt: ISO }),
        expect: { kind: "bulkNoop", countField: "updated" },
        ownCountField: "updated",
    },

    // ── postings & watchlists ──────────────────────────────────────────────
    {
        label: "PATCH /api/postings/[id]",
        route: "postings/[id]", method: "PATCH",
        id: f => f.postingId,
        body: () => ({ status: "tracked" }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "POST /api/postings/[id]/track-as-application",
        route: "postings/[id]/track-as-application", method: "POST",
        id: f => f.postingId,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "PATCH /api/watchlists/[id]",
        route: "watchlists/[id]", method: "PATCH",
        id: f => f.watchlistId,
        body: f => ({ name: `${f.mark} renamed` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "POST /api/watchlists/[id]/run",
        route: "watchlists/[id]/run", method: "POST",
        id: f => f.watchlistId,
        expect: { kind: "refused", status: 404 },
        skipOwn:
            "the SUCCESS path calls runWatchlist(), which crawls a live ATS over the network and can spend Gemini. " +
            "The refusal path returns 404 from the ownership findFirst before either — which is the direction this " +
            "file is about, and is covered.",
    },

    // ── canons ─────────────────────────────────────────────────────────────
    {
        label: "PATCH /api/canons/[id]",
        route: "canons/[id]", method: "PATCH",
        id: f => f.canonId,
        body: f => ({ description: `${f.mark} patched` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "PUT /api/canons/[id]/selection",
        route: "canons/[id]/selection", method: "PUT",
        id: f => f.canonId,
        // Every field on CanonSelectionSchema has a default, so `{}` is a valid
        // full selection — the point here is the id, not the payload.
        body: () => ({}),
        expect: { kind: "refused", status: 404 },
    },

    // ── shell: tasks + goals ───────────────────────────────────────────────
    {
        label: "PATCH /api/tasks",
        route: "tasks", method: "PATCH",
        body: f => ({ id: f.taskId, status: "DONE" }),
        expect: { kind: "refused", status: 404 },
    },
    {
        // GOALS ANSWER 500, NOT 404 — recorded here, not papered over.
        //
        // lib/repositories/goals.ts uses Prisma's extended unique-where
        // (`update({ where: { id, userId } })`), so the row is CORRECTLY
        // protected: a foreign id matches nothing and nothing is written — which
        // is why the DB-delta assertion (the load-bearing one) passes. But
        // P2025 then escapes into the route's generic `catch` and becomes
        // `{ error: <prisma message> }` with status 500, where every sibling
        // route pre-checks ownership and returns 404.
        //
        // Not a scoping hole, so not a gate failure; a rough edge worth pinning
        // so it cannot silently become something else. The existence-oracle
        // check still applies and still holds: a nonexistent id answers 500 too,
        // so the two are indistinguishable.
        label: "PATCH /api/goals",
        route: "goals", method: "PATCH",
        body: f => ({ id: f.goalId, completed: true }),
        expect: {
            kind: "refused", status: 500,
            why: "Prisma P2025 from the scoped `where: { id, userId }` escapes the route's generic catch; " +
                 "the row is protected, only the status code is wrong (should be 404, as its siblings are)",
        },
    },

    // ── profile children ───────────────────────────────────────────────────
    {
        label: "PATCH /api/profile/work-roles",
        route: "profile/work-roles", method: "PATCH",
        body: f => ({ id: f.workRoleId, company: `${f.mark} Renamed Co` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "PATCH /api/profile/projects",
        route: "profile/projects", method: "PATCH",
        body: f => ({ id: f.projectId, name: `${f.mark} Renamed Project` }),
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "PATCH /api/profile/education",
        route: "profile/education", method: "PATCH",
        body: f => ({ id: f.educationId, institution: `${f.mark} Renamed University` }),
        expect: { kind: "refused", status: 404 },
    },

    // ── deletes (children first, then parents) ─────────────────────────────
    {
        label: "DELETE /api/applications/contacts",
        route: "applications/contacts", method: "DELETE",
        query: f => `?id=${f.contactId}`,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/applications/events",
        route: "applications/events", method: "DELETE",
        query: f => `?id=${f.eventId}`,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/profile/work-roles",
        route: "profile/work-roles", method: "DELETE",
        query: f => `?id=${f.workRoleId}`,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/profile/projects",
        route: "profile/projects", method: "DELETE",
        query: f => `?id=${f.projectId}`,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/profile/education",
        route: "profile/education", method: "DELETE",
        query: f => `?id=${f.educationId}`,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/profile/snapshots/[id]",
        route: "profile/snapshots/[id]", method: "DELETE",
        id: f => f.snapshotId,
        expect: { kind: "refused", status: 404 },
    },
    {
        // removeFromBlacklist is a literal `deleteMany({ where: { id, userId } })`
        // — the defect shape with the userId still present. Drop that one word
        // and this case is what catches it.
        label: "DELETE /api/blacklist/[id]",
        route: "blacklist/[id]", method: "DELETE",
        id: f => f.blacklistId,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/tasks",
        route: "tasks", method: "DELETE",
        query: f => `?id=${f.taskId}`,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/goals",
        route: "goals", method: "DELETE",
        body: f => ({ id: f.goalId }),
        expect: {
            kind: "refused", status: 500,
            why: "same P2025-through-the-generic-catch as PATCH /api/goals above; the row is protected",
        },
    },
    {
        label: "DELETE /api/canons/[id]",
        route: "canons/[id]", method: "DELETE",
        id: f => f.canonId,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/applications",
        route: "applications", method: "DELETE",
        query: f => `?id=${f.applicationId}`,
        expect: { kind: "refused", status: 404 },
    },
    {
        label: "DELETE /api/watchlists/[id]",
        route: "watchlists/[id]", method: "DELETE",
        id: f => f.watchlistId,
        expect: { kind: "refused", status: 404 },
    },
];

/**
 * Crew-allowed mutating routes deliberately NOT driven here, each with the
 * reason. Printed at the end so the omissions are visible in the run output
 * rather than buried in a comment — and so the next person adding one has to
 * make the same decision explicitly.
 */
const SKIPPED: Array<[string, string]> = [
    ["POST /api/resumes", "runs the full Gemini rewrite + tagline pipeline and renders a PDF to disk. Takes no foreign id: the canonId/applicationId it accepts are ownership-checked by the same getCanonRow / findApplicationByIdForUser helpers already exercised above."],
    ["POST /api/resumes/specialize", "Gemini. Its ids are z.string().cuid(), so the deterministic fixture ids here cannot even reach the ownership check (400 at the schema)."],
    ["POST /api/profile/import", "Gemini + file parsing. Writes only the caller's own profile — no id parameter to point at another user."],
    ["POST /api/profile/bullets/assist", "Gemini. Read-modify-return; persists nothing."],
    ["POST /api/profile/tagline/draft", "Gemini. Persists nothing."],
    ["POST /api/discovery/suggest", "Gemini. Persists nothing addressable by another user's id."],
    ["POST /api/applications/events/sync", "pulls Google Calendar over the network. No id parameter — scoped to the caller's own Gcal state."],
    ["POST /api/watchlists", "fires a background runWatchlist() crawl on success. Creates only; no foreign id to name. (The PATCH/DELETE/run surface of the same resource IS covered.)"],
    ["POST /api/settings, PATCH /api/profile", "no id parameter — both key on the caller's own userId. Covered instead by phase 7's cross-user clobber check, which is the actual risk (a write that lands on the legacy id='global' / another user's singleton row)."],
    ["POST /api/canons, /api/blacklist, /api/tasks, /api/goals, /api/applications, /api/profile/{work-roles,projects,education}, /api/profile/snapshots", "pure creates with no foreign id to name. Covered instead by phase 7's attribution check, which asserts the new row lands under the CALLER's userId rather than the owner's."],
];

function urlFor(c: WriteCase, f: Fixture, idOverride?: string): string {
    const id = idOverride ?? (c.id ? c.id(f) : undefined);
    const path = id === undefined ? c.route : c.route.replace("[id]", id);
    return `/api/${path}${c.query ? c.query(f) : ""}`;
}

/**
 * A fixture-shaped stand-in whose every id does not exist. Used for the
 * existence-oracle check: a real foreign id and an id that was never real must
 * be indistinguishable, or the difference enumerates the other user's rows.
 */
function phantomFixture(): Fixture {
    const g = (n: string) => `phantom-${n}-does-not-exist`;
    return {
        viewer: CREW_B, mark: "PHANTOMWMARK",
        applicationId: g("app"), contactId: g("contact"), eventId: g("event"),
        watchlistId: g("wl"), postingId: g("posting"), canonId: g("canon"),
        notificationId: g("notif"), taskId: g("task"), goalId: g("goal"),
        blacklistId: g("blacklist"), snapshotId: g("snap"),
        workRoleId: g("workrole"), projectId: g("project"), educationId: g("education"),
    };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * Verdicts, NOT reports.
 *
 * The runner returns its conclusions instead of calling pass()/fail() itself so
 * that phase 2 can run a deliberately-broken case through the identical code
 * path and assert the verdict came back FAILED — inverting the report rather
 * than reaching around the pipeline it is trying to test.
 */
interface PhaseResult { passed: string[]; failed: string[] }

function reportPhase(result: PhaseResult): void {
    for (const m of result.passed) pass(m);
    for (const m of result.failed) fail(m);
}

/**
 * Drive every case against ids the acting viewer does not own, asserting the
 * refusal AND a completely untouched database.
 *
 * The baseline snapshot is taken ONCE for the whole phase and every call is
 * compared against it, rather than re-baselining between calls: nothing here is
 * allowed to change anything, so cumulative drift is exactly as much a failure
 * as a single-call delta — and this way a case that quietly writes cannot hide
 * by becoming the new baseline for the next one.
 */
async function runForeignCases(
    prisma: Prisma,
    actor: Viewer,
    targets: Fixture[],
    cases: WriteCase[],
    opts: { checkOracle: boolean },
): Promise<PhaseResult> {
    __seedViewer(actor);
    const baseline = await snapshot(prisma);
    const phantom = phantomFixture();
    const out: PhaseResult = { passed: [], failed: [] };

    const call = (c: WriteCase, f: Fixture): Promise<Res> =>
        c.handler
            ? c.handler(f)
            : drive(c.route, c.method, urlFor(c, f), {
                body: c.body ? c.body(f) : undefined,
                id: c.id ? c.id(f) : undefined,
            });

    for (const c of cases) {
        const verdicts: string[] = [];
        const statuses: number[] = [];

        for (const target of targets) {
            let res: Res;
            try {
                res = await call(c, target);
            } catch (e) {
                verdicts.push(`[${target.mark}] handler THREW: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
                continue;
            }
            const changes = diffSnapshots(baseline, await snapshot(prisma));
            statuses.push(res.status);
            const violation = refusalViolation({ res, changes, expect: c.expect });
            if (violation) verdicts.push(`[${target.mark}] ${violation}`);
        }

        // Existence oracle: a real-but-foreign id and a never-existed id must be
        // answered identically. Run in the crew phase only — one direction is
        // enough to pin the property, and it doubles every case's cost.
        if (opts.checkOracle && verdicts.length === 0) {
            try {
                const res = await call(c, phantom);
                if (statuses.length > 0 && res.status !== statuses[0]) {
                    verdicts.push(
                        `a REAL foreign id answered ${statuses[0]} but a NONEXISTENT id answered ${res.status} — ` +
                        `the difference is an existence oracle over the other user's rows`,
                    );
                }
            } catch (e) {
                verdicts.push(`nonexistent-id probe THREW: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
            }
        }

        if (verdicts.length > 0) {
            out.failed.push(`${c.label} [as ${MARK[actor.id]}]: ${verdicts.join(" | ")}`);
        } else {
            const shown = c.expect.kind === "bulkNoop" ? "200 + count 0" : String(c.expect.status);
            const oracle = opts.checkOracle ? ", nonexistent id indistinguishable" : "";
            out.passed.push(
                `${c.label} [as ${MARK[actor.id]}] → ${shown} on ${targets.length} foreign id(s), ` +
                `DB byte-identical${oracle}`,
            );
        }
    }
    return out;
}

/** Drive every case against the actor's OWN ids, asserting success and own-only changes. */
async function ownPhase(prisma: Prisma, actor: Viewer, mine: Fixture, foreignMarks: string[]): Promise<void> {
    __seedViewer(actor);

    for (const c of CASES) {
        if (c.skipOwn) {
            pass(`${c.label} [as ${mine.mark}] own-direction SKIPPED — ${c.skipOwn.split(".")[0]}`);
            continue;
        }
        const before = await snapshot(prisma);
        let res: Res;
        try {
            res = await drive(c.route, c.method, urlFor(c, mine), {
                body: c.body ? c.body(mine) : undefined,
                id: c.id ? c.id(mine) : undefined,
            });
        } catch (e) {
            fail(`${c.label} [as ${mine.mark}, OWN row]: handler THREW: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
            continue;
        }
        const changes = diffSnapshots(before, await snapshot(prisma));
        const violation = ownWriteViolation(res, changes, {
            status: c.ownStatus ?? 200,
            mustChange: true,
            foreignMarks,
            countField: c.ownCountField,
        });
        if (violation) fail(`${c.label} [as ${mine.mark}, OWN row]: ${violation}`, res.text.slice(0, 300));
        else pass(`${c.label} [as ${mine.mark}, OWN row] → ${res.status}, ${changes.length} own row(s) changed, zero foreign`);
    }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // The LIVE schema pushed into a throwaway file — same technique and same
    // reasoning as crew-scoping-routes-smoke.ts: this suite touches nineteen
    // tables, and a hand-maintained DDL copy of nineteen tables rots into a
    // suite that tests last quarter's schema. Local-only, no network.
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
        env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
        stdio: "pipe",
    });

    // Dynamic import: DATABASE_URL must be pinned before lib/prisma loads.
    const { prisma } = await import("@/lib/prisma");

    try {
        const owner = await createFixture(prisma, OWNER);
        const crewA = await createFixture(prisma, CREW_A);
        const crewB = await createFixture(prisma, CREW_B);
        const canary = await createFixture(prisma, CANARY);

        // ── 1. Census — the foreign rows really exist ───────────────────────
        section("1. Fixture census — four users, one row each, so 'nothing changed' is not vacuous");
        const census: Array<[string, number]> = [
            ["User", await prisma.user.count()],
            ["Application", await prisma.application.count()],
            ["Contact", await prisma.contact.count()],
            ["ApplicationEvent", await prisma.applicationEvent.count()],
            ["Watchlist", await prisma.watchlist.count()],
            ["JobPosting", await prisma.jobPosting.count()],
            ["Canon", await prisma.canon.count()],
            ["Notification", await prisma.notification.count()],
            ["Task", await prisma.task.count()],
            ["LifeGoal", await prisma.lifeGoal.count()],
            ["BlacklistedCompany", await prisma.blacklistedCompany.count()],
            ["ProfileSnapshot", await prisma.profileSnapshot.count()],
            ["GlobalSetting", await prisma.globalSetting.count()],
            ["Profile", await prisma.profile.count()],
            ["WorkRole", await prisma.workRole.count()],
            ["Project", await prisma.project.count()],
            ["Education", await prisma.education.count()],
        ];
        const wrong = census.filter(([, n]) => n !== 4);
        if (wrong.length > 0) {
            fail(`fixture is incomplete: ${wrong.map(([t, n]) => `${t}=${n}`).join(", ")} (expected 4 each)`);
        } else {
            pass(`${census.length} tables hold 4 rows each — every case below has 3 foreign rows available to destroy`);
        }

        const baselineSnap = await snapshot(prisma);
        if (baselineSnap.size < 60) {
            fail(`snapshot only sees ${baselineSnap.size} rows — the whole-DB detector is not reading the fixture`);
        } else {
            pass(`snapshot covers ${baselineSnap.size} rows across ${SNAPSHOT_TABLES.length} tables`);
        }

        // ── 2. TEETH — prove the assertions can actually fail ───────────────
        // Every check below is run against a REAL unscoped statement and REAL
        // before/after snapshots. Nothing synthetic, and no production file is
        // modified: the statements are written here, in the test, exactly as a
        // buggy handler would have written them.
        section("2. Teeth — the scoping predicate is pointed at real unscoped writes and must reject them");

        // 2a. The signature bug: updateMany with the userId left out of the
        //     where-clause, behind a response that says 404.
        {
            const before = await snapshot(prisma);
            await prisma.watchlist.updateMany({
                where: { id: canary.watchlistId },          // ← no `userId`. THIS is the bug.
                data: { name: "PWNED BY AN UNSCOPED UPDATEMANY" },
            });
            const changes = diffSnapshots(before, await snapshot(prisma));
            const res: Res = { status: 404, text: '{"error":"Watchlist not found"}', body: { error: "Watchlist not found" } };
            const verdict = refusalViolation({ res, changes, expect: { kind: "refused", status: 404 } });
            if (verdict === null) {
                fail(
                    "the predicate ACCEPTED a 404 that had already rewritten another user's watchlist. " +
                    "This suite has no teeth — the status-code assertion alone is what it would be reduced to.",
                );
            } else if (!/DATABASE CHANGED/.test(verdict)) {
                fail(`the predicate rejected, but for the wrong reason: ${verdict}`);
            } else {
                pass(`teeth 2a: an unscoped updateMany behind a 404 is rejected — "${verdict.slice(0, 72)}…"`);
            }
        }

        // 2b. The destructive half: deleteMany with no userId, behind a 404.
        //     Asserted separately because a detector could plausibly notice a
        //     modified row and miss a vanished one.
        {
            const before = await snapshot(prisma);
            await prisma.task.deleteMany({ where: { id: canary.taskId } });   // ← no `userId`.
            const changes = diffSnapshots(before, await snapshot(prisma));
            const res: Res = { status: 404, text: '{"error":"Task not found"}', body: { error: "Task not found" } };
            const verdict = refusalViolation({ res, changes, expect: { kind: "refused", status: 404 } });
            if (verdict === null) {
                fail("the predicate ACCEPTED a 404 that had already DELETED another user's task — no teeth against deletes");
            } else if (!/DELETED/.test(verdict)) {
                fail(`the delete was rejected but not identified as a deletion: ${verdict}`);
            } else {
                pass(`teeth 2b: an unscoped deleteMany behind a 404 is rejected and named as a DELETE`);
            }
        }

        // 2c. A bulk route that reports having moved a foreign row, with the DB
        //     genuinely untouched. Proves the count assertion is live too.
        {
            const verdict = refusalViolation({
                res: { status: 200, text: '{"updated":1}', body: { updated: 1 } },
                changes: [],
                expect: { kind: "bulkNoop", countField: "updated" },
            });
            if (verdict === null) fail("the predicate ACCEPTED a bulk route reporting updated=1 for a foreign id");
            else pass("teeth 2c: a bulk route claiming it moved a foreign row is rejected even with an untouched DB");
        }

        // 2d. 403 instead of 404 — the existence oracle §2.3 forbids.
        {
            const verdict = refusalViolation({
                res: { status: 403, text: '{"error":"forbidden"}', body: { error: "forbidden" } },
                changes: [],
                expect: { kind: "refused", status: 404 },
            });
            if (verdict === null) fail("the predicate ACCEPTED a 403 on a foreign id — the existence-oracle check is dead");
            else pass("teeth 2d: a 403 on a foreign id is rejected (403 is §2.3's ROLE code, not 'not yours')");
        }

        // 2e. A plain success on a foreign id.
        {
            const verdict = refusalViolation({
                res: { status: 200, text: '{"success":true}', body: { success: true } },
                changes: [],
                expect: { kind: "refused", status: 404 },
            });
            if (verdict === null) fail("the predicate ACCEPTED a 200 on a foreign id");
            else pass("teeth 2e: a 200 on a foreign id is rejected");
        }

        // 2f. …and it ADMITS the correct outcome. Without this the five checks
        //     above are equally satisfied by a predicate that returns a string
        //     unconditionally, i.e. a suite that can only fail.
        {
            const verdict = refusalViolation({
                res: { status: 404, text: '{"error":"not found"}', body: { error: "not found" } },
                changes: [],
                expect: { kind: "refused", status: 404 },
            });
            if (verdict !== null) fail(`the predicate REJECTED a correct 404-with-no-DB-change: ${verdict}`);
            else pass("teeth 2f: a correct 404 with an untouched DB is admitted — the predicate is not always-fail");
        }

        // 2g. Same both-ways proof for the own-write predicate: it must reject a
        //     success that collaterally touched a foreign row, and admit a clean one.
        {
            const foreignChange: Change = { key: "Task#task-ownerwmark", before: '{"text":"OWNERWMARK task"}', after: '{"text":"clobbered"}' };
            const ownChange: Change = { key: "Task#task-crewbwmark", before: '{"text":"CREWBWMARK task"}', after: '{"text":"done"}' };
            const bad = ownWriteViolation({ status: 200, text: "{}", body: {} }, [ownChange, foreignChange], {
                status: 200, mustChange: true, foreignMarks: ["OWNERWMARK", "CREWAWMARK"],
            });
            const good = ownWriteViolation({ status: 200, text: "{}", body: {} }, [ownChange], {
                status: 200, mustChange: true, foreignMarks: ["OWNERWMARK", "CREWAWMARK"],
            });
            const vacuous = ownWriteViolation({ status: 200, text: "{}", body: {} }, [], {
                status: 200, mustChange: true, foreignMarks: ["OWNERWMARK", "CREWAWMARK"],
            });
            if (bad === null) fail("the own-write predicate ACCEPTED a success that also clobbered a foreign row");
            else if (good !== null) fail(`the own-write predicate REJECTED a clean own-only write: ${good}`);
            else if (vacuous === null) fail("the own-write predicate ACCEPTED a 200 that changed nothing — the anti-vacuity check is dead");
            else pass("teeth 2g: own-write predicate rejects collateral foreign changes AND no-op successes, admits clean own-only writes");
        }

        // 2h. THE WHOLE PIPELINE, not just the predicate. 2a–2g prove
        //     refusalViolation() rejects; they do NOT prove that the per-case
        //     runner wired around it — snapshot → call → snapshot → diff →
        //     predicate → verdict — actually carries that rejection out. A dead
        //     wire anywhere in that chain would leave every phase below printing
        //     PASS forever, which is the exact class of defect this repo has
        //     already produced twice.
        //
        //     So: build a synthetic case whose "handler" IS the bug (an unscoped
        //     deleteMany that then answers a blameless 404), push it through the
        //     SAME runForeignCases() phases 3 and 4 use, and require the verdict
        //     to come back FAILED. Nothing in app/ or lib/ is touched, and the
        //     target is the canary, so no real fixture is disturbed.
        {
            const sabotage: WriteCase = {
                label: "SYNTHETIC unscoped deleteMany behind a 404 (test-only, never a real route)",
                route: "<in-test>", method: "DELETE",
                expect: { kind: "refused", status: 404 },
                handler: async (target) => {
                    await prisma.blacklistedCompany.deleteMany({ where: { id: target.blacklistId } }); // ← no `userId`
                    return { status: 404, text: '{"error":"Not found"}', body: { error: "Not found" } };
                },
            };
            const sabotaged = await runForeignCases(prisma, CREW_B, [canary], [sabotage], { checkOracle: false });
            const clean = await runForeignCases(prisma, CREW_B, [canary], [{
                label: "SYNTHETIC correctly-scoped refusal (test-only)",
                route: "<in-test>", method: "DELETE",
                expect: { kind: "refused", status: 404 },
                handler: async () => ({ status: 404, text: '{"error":"Not found"}', body: { error: "Not found" } }),
            }], { checkOracle: false });

            if (sabotaged.failed.length !== 1) {
                fail(
                    `the case runner reported ${sabotaged.failed.length} failure(s) for a case that DELETED a foreign ` +
                    `row behind a 404 — expected exactly 1. The pipeline that phases 3–6 depend on cannot fail, so ` +
                    `every PASS below is worthless.`,
                );
            } else if (clean.failed.length !== 0) {
                fail(`the case runner reported a failure for a correctly-scoped refusal: ${clean.failed[0]}`);
            } else {
                pass(
                    `teeth 2h: the FULL per-case runner fails on an unscoped delete and passes a clean refusal — ` +
                    `"${sabotaged.failed[0].slice(0, 90)}…"`,
                );
            }
        }

        // The canary is deliberately left vandalised. It is never an actor or a
        // target below, and its rows never move again — so it contributes
        // nothing to any later delta, and restoring it would only reintroduce
        // the `updatedAt` churn the phases below are watching for.
        pass("canary fixture left vandalised on purpose — it is never driven again, so later deltas stay clean");

        // ── 3. As CREW B — foreign ids are refused and change nothing ───────
        section("3. As crew B — every crew-allowed WRITE against the owner's and crew A's ids");
        reportPhase(await runForeignCases(prisma, CREW_B, [owner, crewA], CASES, { checkOracle: true }));

        // ── 4. As the OWNER — crew ids are refused and change nothing ───────
        // Independent of phase 3: a handler that resolves its userId through
        // `resolveOwner()` rather than the session behaves perfectly when the
        // caller happens to BE the owner, and only misbehaves here.
        section("4. As the owner — the same writes against crew A's and crew B's ids");
        reportPhase(await runForeignCases(prisma, OWNER, [crewA, crewB], CASES, { checkOracle: false }));

        // ── 5 + 6. Own-id writes SUCCEED ───────────────────────────────────
        // Anti-vacuity for phases 3 and 4, and the reason those two run first.
        section("5. As the owner — the same writes against the OWNER's OWN ids must SUCCEED");
        await ownPhase(prisma, OWNER, owner, [CREW_A.id, CREW_B.id, CANARY.id].map(i => MARK[i]));

        section("6. As crew B — the same writes against CREW B's OWN ids must SUCCEED");
        await ownPhase(prisma, CREW_B, crewB, [OWNER.id, CREW_A.id, CANARY.id].map(i => MARK[i]));

        // ── 7. The id-less writers: creation attribution + clobber ──────────
        // The routes with no id parameter cannot be pointed at another user's
        // row, so the phases above skip them. They have their own failure mode:
        // a create that attributes the new row to `resolveOwner()` instead of
        // the session, or a per-user singleton write that lands on the legacy
        // id='global' row (which the schema comment records as the OWNER's).
        section("7. Id-less writers — new rows land under the CALLER, and singletons do not clobber");
        __seedViewer(CREW_B);
        // `owner`, not `OWNER` — the Fixture carries `.mark`, the Viewer does not.
        // Written the wrong way round first, and tsc caught it: `OWNER.mark` is
        // `undefined`, so the owner's marker would have been silently absent from
        // the clobber check while it still printed PASS.
        const foreignMarksForB = [owner.mark, crewA.mark, canary.mark];

        interface CreateCase { label: string; route: string; body: unknown; status: number; table: string }
        const CREATES: CreateCase[] = [
            { label: "POST /api/applications", route: "applications", status: 200, table: "Application",
              body: { company: "CREWBWMARK NewCo", role: "CREWBWMARK Analyst", track: "career" } },
            { label: "POST /api/canons", route: "canons", status: 201, table: "Canon",
              body: { name: "CREWBWMARK New Canon", track: "career" } },
            { label: "POST /api/blacklist", route: "blacklist", status: 200, table: "BlacklistedCompany",
              body: { name: "CREWBWMARK NewBadCo" } },
            { label: "POST /api/tasks", route: "tasks", status: 200, table: "Task",
              body: { text: "CREWBWMARK new task" } },
            { label: "POST /api/goals", route: "goals", status: 200, table: "LifeGoal",
              body: { text: "CREWBWMARK new goal" } },
            { label: "POST /api/profile/snapshots", route: "profile/snapshots", status: 200, table: "ProfileSnapshot",
              body: { label: "CREWBWMARK new snapshot" } },
        ];

        for (const c of CREATES) {
            const before = await snapshot(prisma);
            let res: Res;
            try {
                res = await drive(c.route, "POST", `/api/${c.route}`, { body: c.body });
            } catch (e) {
                fail(`${c.label}: handler THREW: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
                continue;
            }
            const changes = diffSnapshots(before, await snapshot(prisma));
            if (res.status !== c.status) {
                fail(`${c.label} [as crew B]: expected ${c.status}, got ${res.status}`, res.text.slice(0, 250));
                continue;
            }
            const created = changes.filter(ch => ch.before === null && ch.key.startsWith(`${c.table}#`));
            if (created.length === 0) {
                fail(`${c.label} [as crew B]: answered ${res.status} but created no ${c.table} row`);
                continue;
            }
            // Match the `"userId":"<id>"` PAIR, not the bare id: the id also
            // appears inside unrelated columns on some rows, and a check that
            // accepted any occurrence would pass on a row whose userId column
            // actually said somebody else.
            const attributed = `"userId":${JSON.stringify(CREW_B.id)}`;
            const misattributed = created.filter(ch => !(ch.after ?? "").includes(attributed));
            const collateral = changes.filter(ch => touchesMarks(ch, foreignMarksForB).length > 0);
            if (misattributed.length > 0) {
                fail(
                    `${c.label} [as crew B]: the new ${c.table} row does NOT carry crew B's userId — ` +
                    `it was attributed to somebody else (${misattributed[0].after?.slice(0, 200)})`,
                );
            } else if (collateral.length > 0) {
                fail(`${c.label} [as crew B]: also touched foreign row(s): ${collateral.map(describeChange).join(", ")}`);
            } else {
                pass(`${c.label} [as crew B] → ${res.status}, new ${c.table} row attributed to crew B, zero foreign rows touched`);
            }
        }

        // The two per-user singletons. GlobalSetting's legacy row kept the id
        // 'global' and was backfilled to the owner (see the schema comment), so
        // a write that keys on id rather than userId lands squarely on the
        // owner's row — which is exactly what this asserts it does not.
        for (const [label, route, method, body, headers] of [
            ["POST /api/settings", "settings", "POST", { isDarkMode: false }, { "if-match": "0" }],
            ["PATCH /api/profile", "profile", "PATCH", { headline: "CREWBWMARK Renamed Person" }, undefined],
        ] as Array<[string, string, Method, unknown, Record<string, string> | undefined]>) {
            const before = await snapshot(prisma);
            let status: number;
            let text: string;
            try {
                const mod = await import(`@/app/api/${route}/route`);
                const handler = mod[method] as (req: NextRequest) => Promise<Response>;
                const res = await handler(new NextRequest(`http://crew-writes-smoke.invalid/api/${route}`, {
                    method,
                    headers: { "content-type": "application/json", ...(headers ?? {}) },
                    body: JSON.stringify(body),
                }));
                status = res.status;
                text = await res.text();
            } catch (e) {
                fail(`${label}: handler THREW: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
                continue;
            }
            const changes = diffSnapshots(before, await snapshot(prisma));
            const collateral = changes.filter(ch => touchesMarks(ch, foreignMarksForB).length > 0);
            if (status !== 200) {
                fail(`${label} [as crew B]: expected 200, got ${status}`, text.slice(0, 250));
            } else if (collateral.length > 0) {
                fail(
                    `${label} [as crew B]: CLOBBERED another user's singleton row — ` +
                    `${collateral.map(ch => `${describeChange(ch)} [${touchesMarks(ch, foreignMarksForB).join("/")}]`).join(", ")}`,
                );
            } else if (changes.length === 0) {
                fail(`${label} [as crew B]: answered 200 but wrote nothing — the clobber check above is vacuous`);
            } else {
                pass(`${label} [as crew B] → 200, ${changes.length} own row(s) changed, no foreign singleton touched`);
            }
        }

        // ── 8. Crew A was never touched, start to finish ────────────────────
        // The strongest single statement this file can make. Crew A is never an
        // actor and never an own-write target, so their entire fixture must be
        // byte-identical to how phase 1 created it — after ~200 handler
        // invocations from two other identities.
        section("8. Crew A — never the actor, never the target: their fixture must be untouched end-to-end");
        const finalSnap = await snapshot(prisma);
        const crewADrift = diffSnapshots(baselineSnap, finalSnap).filter(c => touchesMarks(c, [crewA.mark]).length > 0);
        if (crewADrift.length > 0) {
            fail(
                `crew A's rows changed during the run: ${crewADrift.map(describeChange).join(", ")}. ` +
                `No phase ever acts as crew A or names crew A's ids for an own-write, so every one of these is a leak.`,
            );
        } else {
            const crewARows = [...baselineSnap.keys()].filter(k => (baselineSnap.get(k) ?? "").includes(crewA.mark)).length;
            pass(`all ${crewARows} of crew A's rows are byte-identical to the fixture after the full run`);
        }

        section("Deliberately not covered (crew-allowed mutating routes, with reasons)");
        for (const [route, why] of SKIPPED) console.log(`  · ${route}\n      ${why}`);
    } finally {
        // Clear the seam first: one left armed hands the next suite in the
        // pre-push gate this smoke's throwaway viewer.
        __resetViewer();
        try { await prisma.$disconnect(); } catch { /* best-effort */ }
    }
}

/**
 * Synchronous, and registered on `exit` rather than run in the `finally`:
 * importing route modules leaves a lazily-opened Prisma client behind that can
 * touch the file after the last await resolves, so a finally-block unlink races
 * it and loses (same reasoning as role-matrix-smoke.ts).
 */
function cleanScratchDb(): void {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        try { rmSync(`${SCRATCH_DB}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
}

/**
 * The exit path lives out here so no early return inside `main()` can skip it —
 * `resume-list-smoke.ts` once printed [FAIL] and still exited 0, and the
 * pre-push gate reads only the exit code.
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

process.on("exit", cleanScratchDb);
main().then(finish, (e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
