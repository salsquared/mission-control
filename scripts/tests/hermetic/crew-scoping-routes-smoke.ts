/**
 * Route-layer per-user scoping — docs/multi-user-crew.html §2.4's second
 * invariant ("every crew-allowed handler MUST scope its queries by
 * session.user.id"), P5.1.5.
 *
 *   npx tsx scripts/tests/hermetic/crew-scoping-routes-smoke.ts
 *
 * WHY THIS FILE EXISTS — the gap between the two suites that already exist.
 *
 *   `user-scoping-smoke.ts` proves the REPOSITORY layer isolates users: call
 *   `findAllTasks(strangerId)` and you get an empty set. It proves nothing
 *   about which id a HANDLER passes down.
 *
 *   `role-matrix-smoke.ts` proves each route DECLARES the right guard, and it
 *   is careful to note why it cannot go further: admitting a crew viewer means
 *   the handler body executes, and those bodies reach SQLite. So the one thing
 *   neither file covers is the composition — a crew viewer ADMITTED to a
 *   crew-allowed route, body running, returning rows.
 *
 *   That composition is exactly where a scoping bug lives. `requireSession()`
 *   no longer implies "the owner" (§2.4), so a handler that resolves its userId
 *   from anywhere other than the guard's session — `resolveOwner()`, a
 *   sole-user query, a hardcoded id, or simply an unscoped `findMany()` — passes
 *   both existing suites and still serves one person's rows to another.
 *
 * WHAT IS ASSERTED, and why each direction is needed.
 *
 *   1. CENSUS (anti-vacuity). Three users — an owner and TWO crew — each own
 *      exactly one row in every table under test. "Zero foreign rows" is
 *      worthless if the tables are empty, so the foreign rows are counted first
 *      and every phase also asserts the caller's OWN row came back.
 *
 *   2. AS CREW B: every crew-allowed read route returns crew B's row and NOT
 *      ONE foreign row. This is the direction that catches the classic bug —
 *      a handler scoped to the owner instead of the session.
 *
 *   3. AS THE OWNER: the same routes return the owner's row and NOT ONE crew
 *      row. This direction matters independently: a handler that resolves the
 *      owner (rather than the session) is INVISIBLE to check 2 when the caller
 *      happens to be the owner, and a handler that forgot to scope at all
 *      returns everyone's rows to the owner while looking correct to nobody
 *      else. TWO crew fixtures exist so this direction has two distinct
 *      foreign markers to find rather than one.
 *
 *   4. CROSS-USER ID GUESSING IS 404, NEVER 403. A crew viewer naming another
 *      user's row id must get the SAME answer as for an id that does not exist
 *      at all. 403 would be an existence oracle: "this id is real, it just is
 *      not yours" is itself a leak (it enumerates the other user's corpus), and
 *      403 is reserved in §2.3 for the ROLE decision. The check asserts the two
 *      statuses are equal, not merely that each is 4xx.
 *
 * THE MARKER TRICK. Each user's fixture rows carry a unique token
 * (`OWNERMARK` / `CREWAMARK` / `CREWBMARK`) inside their text columns, so the
 * leak check is a substring scan of the raw response body rather than a
 * per-route shape walk. A row that leaks through ANY field — a nested include,
 * an unserialized relation, a debug echo — is caught, including through shapes
 * this file does not know about.
 *
 * Hermetic: no network, no PM2, no Gemini. The schema is pushed into a
 * THROWAWAY SQLite file in /tmp (`prisma db push`, same fixture technique as
 * crew-routes-smoke.ts) with DATABASE_URL pinned before any import; dev.db /
 * prod.db are never touched. Only READ handlers are driven, so nothing here
 * writes, sends, or fetches.
 */

const SCRATCH_DB = `/tmp/crew-scoping-routes-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.EMAIL_ENABLED = "0";
// The phases below act through the `__seedViewer` seam and must not inherit a
// break-glass escape from the shell the pre-push hook happens to run in (P5.1.3).
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

const OWNER: Viewer = { id: "owner-crew-scoping-smoke", email: "owner@crew-scoping-smoke.invalid", role: "owner" };
const CREW_A: Viewer = { id: "crew-a-crew-scoping-smoke", email: "crew-a@crew-scoping-smoke.invalid", role: "crew" };
const CREW_B: Viewer = { id: "crew-b-crew-scoping-smoke", email: "crew-b@crew-scoping-smoke.invalid", role: "crew" };

/** The per-user token embedded in every text column of that user's rows. */
const MARK: Record<string, string> = {
    [OWNER.id]: "OWNERMARK",
    [CREW_A.id]: "CREWAMARK",
    [CREW_B.id]: "CREWBMARK",
};

interface Fixture {
    viewer: Viewer;
    mark: string;
    applicationId: string;
    contactId: string;
    eventId: string;
    watchlistId: string;
    postingId: string;
    resumeId: string;
    canonId: string;
    notificationId: string;
    taskId: string;
    savedPaperId: string;
    blacklistId: string;
}

/**
 * One row in every table under test, all tagged with the user's marker. Ids are
 * deterministic (`<table>-<mark>`) rather than cuids so a failure message names
 * the owner of the leaked row directly.
 */
async function createFixture(
    prisma: typeof import("@/lib/prisma").prisma,
    viewer: Viewer,
): Promise<Fixture> {
    const mark = MARK[viewer.id];
    const id = (table: string) => `${table}-${mark.toLowerCase()}`;

    await prisma.user.create({ data: { id: viewer.id, email: viewer.email, role: viewer.role } });

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
        },
    });
    const contact = await prisma.contact.create({
        data: { id: id("contact"), applicationId: application.id, name: `${mark} Recruiter` },
    });
    const event = await prisma.applicationEvent.create({
        data: {
            id: id("event"),
            applicationId: application.id,
            kind: "APPLIED",
            title: `${mark} applied`,
            occurredAt: new Date("2026-07-01T12:00:00Z"),
        },
    });
    const watchlist = await prisma.watchlist.create({
        data: {
            id: id("wl"),
            userId: viewer.id,
            name: `${mark} watchlist`,
            kind: "greenhouse",
            // Must satisfy lib/schemas/watchlists.ts's greenhouse variant — the
            // route DROPS rows whose stored config fails the schema, and a
            // dropped row would make the scoping assertion vacuous.
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
        },
    });
    const resume = await prisma.generatedResume.create({
        data: {
            id: id("resume"),
            userId: viewer.id,
            postingInput: JSON.stringify({ text: `${mark} posting text` }),
            postingTitle: `${mark} Engineer`,
            postingCompany: `${mark} Industries`,
            profileSnapshot: JSON.stringify({ name: `${mark} Person` }),
            selections: "[]",
            format: "pdf",
            status: "ready",
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
    const savedPaper = await prisma.savedPaper.create({
        data: {
            id: id("paper"),
            userId: viewer.id,
            paperId: `2406.${mark}`,
            title: `${mark} paper`,
            summary: `${mark} summary`,
            url: `https://arxiv.invalid/${mark}`,
            authors: `${mark} Author`,
            publishedAt: new Date("2026-06-01T00:00:00Z"),
            topic: "AI",
            status: "READ_LATER",
        },
    });
    const blacklist = await prisma.blacklistedCompany.create({
        data: {
            id: id("blacklist"),
            userId: viewer.id,
            name: `${mark} BadCo`,
            normalizedName: `${mark.toLowerCase()}badco`,
        },
    });

    return {
        viewer,
        mark,
        applicationId: application.id,
        contactId: contact.id,
        eventId: event.id,
        watchlistId: watchlist.id,
        postingId: posting.id,
        resumeId: resume.id,
        canonId: canon.id,
        notificationId: notification.id,
        taskId: task.id,
        savedPaperId: savedPaper.id,
        blacklistId: blacklist.id,
    };
}

// ---------------------------------------------------------------------------
// Driving real route handlers in-process
// ---------------------------------------------------------------------------

interface Res {
    status: number;
    /** Raw body text — what the marker scan reads. */
    text: string;
    /** Parsed body, `null` when the response was not JSON. */
    body: unknown;
}

/** One field off a parsed JSON body, without asserting the whole shape. */
function field(body: unknown, key: string): unknown {
    return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Call a real exported handler. `route` is the path under app/api; `ctx` carries
 * the dynamic-segment params a `[id]` route awaits.
 *
 * The request is a real `NextRequest`, not a bare `Request`: several of these
 * handlers read `req.nextUrl.searchParams` (e.g. /api/applications' ?track=),
 * which only exists on the Next wrapper.
 *
 * A throw is NOT swallowed into a status: these handlers run with a viewer
 * seeded, so the body really executes, and an exception here is a genuine
 * failure worth reporting verbatim rather than a rejection to classify.
 */
async function drive(
    route: string,
    method: "GET",
    url: string,
    ctx?: unknown,
): Promise<Res> {
    const mod = await import(`@/app/api/${route}/route`);
    const handler = mod[method] as ((req: NextRequest, ctx?: unknown) => Promise<Response | undefined>) | undefined;
    if (typeof handler !== "function") throw new Error(`/api/${route} exports no ${method}`);
    const res = await handler(new NextRequest(`http://crew-scoping-smoke.invalid${url}`, { method }), ctx);
    if (!res) throw new Error(`/api/${route} ${method} returned undefined`);
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* non-JSON body — the scan still applies */ }
    return { status: res.status, text, body };
}

interface ScopeExpectation { mine: Fixture; others: Fixture[]; key?: string; expect: number }

/**
 * The rule, as a pure predicate so it can be pointed at a synthetic response
 * and PROVED to reject one (see the teeth check in main()). Returns null when
 * the response is correctly scoped, else how it is not:
 *   - answered 200,
 *   - contains NO other user's marker,
 *   - contains the CALLER's marker (the query is not simply broken),
 *   - and the collection is exactly the caller's own row count.
 */
function scopeViolation(res: Res, opts: ScopeExpectation): string | null {
    if (res.status !== 200) return `expected 200, got ${res.status}`;

    const leaked = opts.others.filter(o => res.text.includes(o.mark));
    if (leaked.length > 0) {
        return (
            `LEAKED another user's rows (found ${leaked.map(l => l.mark).join(", ")}). ` +
            `The handler is not scoping by session.user.id — §2.4's second invariant.`
        );
    }
    if (opts.expect > 0 && !res.text.includes(opts.mine.mark)) {
        return (
            `the caller's OWN row is missing (no ${opts.mine.mark} in the body). ` +
            `Without it "no foreign rows" is vacuous — the query may simply be returning nothing.`
        );
    }
    if (opts.key) {
        const arr = field(res.body, opts.key);
        if (!Array.isArray(arr)) return `expected an array at .${opts.key}`;
        if (arr.length !== opts.expect) return `expected exactly ${opts.expect} row(s), got ${arr.length}`;
    }
    return null;
}

function assertScoped(label: string, res: Res, opts: ScopeExpectation): void {
    const violation = scopeViolation(res, opts);
    if (violation) fail(`${label}: ${violation}`, res.text.slice(0, 400));
    else pass(`${label} → own row only (${opts.expect}), zero foreign rows`);
}

// ---------------------------------------------------------------------------

/** Every crew-allowed READ route driven in both phases, as (label, route, url). */
type ReadCase = { label: string; route: string; url: (f: Fixture) => string; key: string; expect: number };

const READ_CASES: ReadCase[] = [
    { label: "GET /api/applications", route: "applications", url: () => "/api/applications", key: "applications", expect: 1 },
    { label: "GET /api/applications/events", route: "applications/events", url: () => "/api/applications/events", key: "events", expect: 1 },
    { label: "GET /api/applications/contacts", route: "applications/contacts", url: f => `/api/applications/contacts?applicationId=${f.applicationId}`, key: "contacts", expect: 1 },
    { label: "GET /api/postings", route: "postings", url: () => "/api/postings", key: "postings", expect: 1 },
    { label: "GET /api/watchlists", route: "watchlists", url: () => "/api/watchlists", key: "watchlists", expect: 1 },
    { label: "GET /api/resumes", route: "resumes", url: () => "/api/resumes", key: "resumes", expect: 1 },
    { label: "GET /api/canons", route: "canons", url: () => "/api/canons", key: "canons", expect: 1 },
    { label: "GET /api/notifications", route: "notifications", url: () => "/api/notifications", key: "notifications", expect: 1 },
    { label: "GET /api/tasks", route: "tasks", url: () => "/api/tasks", key: "tasks", expect: 1 },
    { label: "GET /api/blacklist", route: "blacklist", url: () => "/api/blacklist", key: "entries", expect: 1 },
];

/** The `[id]` READ routes, for the 404-not-403 phase. */
type IdCase = { label: string; route: string; idOf: (f: Fixture) => string };

const ID_CASES: IdCase[] = [
    { label: "GET /api/postings/[id]", route: "postings/[id]", idOf: f => f.postingId },
    { label: "GET /api/resumes/[id]", route: "resumes/[id]", idOf: f => f.resumeId },
    { label: "GET /api/canons/[id]", route: "canons/[id]", idOf: f => f.canonId },
    { label: "GET /api/canons/[id]/selection", route: "canons/[id]/selection", idOf: f => f.canonId },
];

function idUrl(route: string, id: string): string {
    return `/api/${route.replace("[id]", id)}`;
}

async function main(): Promise<void> {
    // Fixture DB: the LIVE schema pushed into a throwaway file. Hand-written DDL
    // was rejected here — this smoke touches eleven tables, and a hand-maintained
    // copy of eleven tables silently rots into a suite that tests last quarter's
    // schema. `prisma db push` is local-only (no network) and takes ~40ms.
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

        // ── 1. Census — the foreign rows really exist ────────────────────────
        section("1. Fixture census — three users, one row each, so 'zero foreign rows' is not vacuous");
        const census: Array<[string, number]> = [
            ["User", await prisma.user.count()],
            ["Application", await prisma.application.count()],
            ["ApplicationEvent", await prisma.applicationEvent.count()],
            ["Contact", await prisma.contact.count()],
            ["Watchlist", await prisma.watchlist.count()],
            ["JobPosting", await prisma.jobPosting.count()],
            ["GeneratedResume", await prisma.generatedResume.count()],
            ["Canon", await prisma.canon.count()],
            ["Notification", await prisma.notification.count()],
            ["Task", await prisma.task.count()],
            ["SavedPaper", await prisma.savedPaper.count()],
            ["BlacklistedCompany", await prisma.blacklistedCompany.count()],
        ];
        const wrong = census.filter(([, n]) => n !== 3);
        if (wrong.length > 0) {
            fail(`fixture is incomplete: ${wrong.map(([t, n]) => `${t}=${n}`).join(", ")} (expected 3 each)`);
        } else {
            pass(`${census.length} tables hold 3 rows each — every route below has 2 foreign rows available to leak`);
        }

        // ── 1b. …and the detector really rejects the bug it is looking for ──
        // A "zero foreign rows" check that has never been shown to fail is a
        // check nobody has proved CAN fail. So build the exact response an
        // unscoped handler would return — `findMany()` with the `where` omitted,
        // which is the one-word mistake this suite exists to catch — and assert
        // the predicate rejects it. No production file is modified to do this.
        const unscopedRows = await prisma.application.findMany();
        const unscopedBody = { applications: unscopedRows };
        const unscopedRes: Res = { status: 200, text: JSON.stringify(unscopedBody), body: unscopedBody };
        const verdict = scopeViolation(unscopedRes, { mine: crewB, others: [owner, crewA], key: "applications", expect: 1 });
        if (verdict === null) {
            fail("the scoping predicate ACCEPTED an unscoped findMany() response — this suite has no teeth");
        } else {
            pass(`scoping predicate has teeth: an unscoped findMany() response is rejected — ${verdict.split(".")[0]}`);
        }

        // ── 2. As CREW B — zero foreign rows on every crew-allowed read ─────
        section("2. As crew B — every crew-allowed read route returns their row and no one else's");
        __seedViewer(CREW_B);
        for (const c of READ_CASES) {
            const res = await drive(c.route, "GET", c.url(crewB));
            assertScoped(`${c.label} [as crew B]`, res, { mine: crewB, others: [owner, crewA], key: c.key, expect: c.expect });
        }

        // The unread badge is its own query (a separate `count`), so it gets its
        // own assertion — a count that forgot `userId` would show crew B a
        // three-notification badge behind a one-notification list.
        const notifRes = await drive("notifications", "GET", "/api/notifications");
        const unreadCount = field(notifRes.body, "unreadCount");
        if (unreadCount !== 1) {
            fail(`GET /api/notifications unreadCount should count ONLY crew B's unread row, got ${String(unreadCount)}`);
        } else pass("GET /api/notifications [as crew B] → unreadCount is per-user (1, not 3)");

        // A foreign applicationId on a query-param-scoped route must answer with
        // an EMPTY set, never the other user's contacts. This is the id-guessing
        // case for a route whose id arrives as a query param rather than a path
        // segment, so the 404 phase below cannot cover it.
        const foreignContacts = await drive(
            "applications/contacts", "GET", `/api/applications/contacts?applicationId=${owner.applicationId}`,
        );
        const foreignContactRows = field(foreignContacts.body, "contacts");
        if (foreignContacts.status !== 200) {
            fail(`contacts with a foreign applicationId: expected 200 + empty, got ${foreignContacts.status}`);
        } else if (foreignContacts.text.includes(owner.mark)) {
            fail("contacts with a foreign applicationId LEAKED the owner's contact", foreignContacts.text.slice(0, 300));
        } else if (!Array.isArray(foreignContactRows) || foreignContactRows.length !== 0) {
            fail("contacts with a foreign applicationId should be an EMPTY array", foreignContacts.text.slice(0, 300));
        } else pass("GET /api/applications/contacts?applicationId=<owner's> [as crew B] → empty, no leak");

        // ── 3. As the OWNER — zero crew rows ────────────────────────────────
        // Independent of check 2: a handler that resolves the OWNER rather than
        // the session looks perfect from check 2's seat when the caller is the
        // owner, and a handler that never scoped at all hands the owner
        // everybody's rows while looking correct to no one else.
        section("3. As the owner — the same routes return the owner's row and no crew rows");
        __seedViewer(OWNER);
        for (const c of READ_CASES) {
            const res = await drive(c.route, "GET", c.url(owner));
            assertScoped(`${c.label} [as owner]`, res, { mine: owner, others: [crewA, crewB], key: c.key, expect: c.expect });
        }

        // SavedPaper's only route is owner-only (research/saved), so it has no
        // crew-phase counterpart — but the owner direction still catches an
        // unscoped read of a table that now holds three users' libraries.
        const saved = await drive("research/saved", "GET", "/api/research/saved");
        if (saved.status !== 200) {
            fail(`GET /api/research/saved [as owner]: expected 200, got ${saved.status}`, saved.text.slice(0, 200));
        } else if (saved.text.includes(crewA.mark) || saved.text.includes(crewB.mark)) {
            fail("GET /api/research/saved LEAKED crew saved papers to the owner", saved.text.slice(0, 300));
        } else if (!Array.isArray(saved.body) || saved.body.length !== 1 || !saved.text.includes(owner.mark)) {
            fail("GET /api/research/saved should return exactly the owner's one paper", saved.text.slice(0, 300));
        } else pass("GET /api/research/saved [as owner] → own paper only, zero crew rows");

        // ── 4. Cross-user id guessing is 404, never 403 ─────────────────────
        section("4. As crew B — another user's row id answers 404, identical to an id that does not exist");
        __seedViewer(CREW_B);
        const MISSING = "id-that-does-not-exist-anywhere";
        for (const c of ID_CASES) {
            const mineRes = await drive(c.route, "GET", idUrl(c.route, c.idOf(crewB)), { params: Promise.resolve({ id: c.idOf(crewB) }) });
            const ownerRes = await drive(c.route, "GET", idUrl(c.route, c.idOf(owner)), { params: Promise.resolve({ id: c.idOf(owner) }) });
            const crewARes = await drive(c.route, "GET", idUrl(c.route, c.idOf(crewA)), { params: Promise.resolve({ id: c.idOf(crewA) }) });
            const missingRes = await drive(c.route, "GET", idUrl(c.route, MISSING), { params: Promise.resolve({ id: MISSING }) });

            if (mineRes.status !== 200) {
                fail(`${c.label}: crew B's OWN id should 200 (else the 404s below prove nothing), got ${mineRes.status}`, mineRes.text.slice(0, 200));
                continue;
            }
            const leak = [owner, crewA].filter(f => (f === owner ? ownerRes : crewARes).text.includes(f.mark));
            if (leak.length > 0) {
                fail(`${c.label}: naming another user's id RETURNED THEIR ROW (${leak.map(l => l.mark).join(", ")})`);
                continue;
            }
            if (ownerRes.status === 403 || crewARes.status === 403) {
                fail(
                    `${c.label}: a foreign id answered 403, not 404. 403 is §2.3's ROLE rejection; using it here ` +
                    `also turns the route into an existence oracle ("this id is real, just not yours").`,
                );
                continue;
            }
            if (ownerRes.status !== 404 || crewARes.status !== 404) {
                fail(`${c.label}: foreign ids should 404, got owner→${ownerRes.status}, crewA→${crewARes.status}`);
                continue;
            }
            if (missingRes.status !== ownerRes.status) {
                fail(
                    `${c.label}: a REAL foreign id (${ownerRes.status}) and a nonexistent id (${missingRes.status}) ` +
                    `answer differently — the difference enumerates the other user's rows.`,
                );
                continue;
            }
            pass(`${c.label}: own→200, foreign→404, nonexistent→404 (indistinguishable, no existence oracle)`);
        }

        // ── 5. Nothing the READ phases did wrote anything ───────────────────
        // Cheap paranoia with a real payoff: if a "read" route mutated (or a
        // handler auto-created a row for the caller), the census below drifts
        // and every count assertion above becomes suspect in hindsight.
        section("5. The read phases mutated nothing");
        const after: Array<[string, number]> = [
            ["Application", await prisma.application.count()],
            ["JobPosting", await prisma.jobPosting.count()],
            ["GeneratedResume", await prisma.generatedResume.count()],
            ["Canon", await prisma.canon.count()],
            ["Notification", await prisma.notification.count()],
            ["Task", await prisma.task.count()],
            ["SavedPaper", await prisma.savedPaper.count()],
        ];
        const drifted = after.filter(([, n]) => n !== 3);
        if (drifted.length > 0) fail(`a READ route wrote rows: ${drifted.map(([t, n]) => `${t}=${n}`).join(", ")}`);
        else pass("row counts unchanged after both phases — the read routes are side-effect free");
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
