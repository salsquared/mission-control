/**
 * Hermetic smoke for the find-roles grouping helper.
 *
 *   npx tsx scripts/tests/hermetic/find-roles-grouping-smoke.ts
 *
 * Pure-function tests against a hand-built WatchlistWire[]. No DB, no network.
 */
import {
    groupWatchlists,
    groupTitle,
    findRolesGroupKey,
    isFindRolesKind,
    rowItemMatchesSearch,
    type FindRolesGroup,
    type WatchlistRowItem,
} from "@/lib/watchlists/find-roles-grouping";
import type { WatchlistWire } from "@/lib/schemas/watchlists";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

let nextId = 1;
function mkLinkedin(keywords: string, opts: { location?: string; track?: "career" | "side"; createdAt?: string } = {}): WatchlistWire {
    return {
        id: `w${nextId++}`,
        userId: "u1",
        name: `${keywords}${opts.location ? ` — ${opts.location}` : ""} (LinkedIn)`,
        kind: "linkedin",
        config: { kind: "linkedin", keywords, location: opts.location, companyName: "LinkedIn search" },
        directoryKey: null,
        negativeFilters: [],
        notificationMode: "each",
        lastDigestAt: null,
        scheduleMinutes: 240,
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        active: true,
        track: opts.track ?? "career",
        createdAt: opts.createdAt ?? new Date(2026, 0, 1).toISOString(),
        updatedAt: opts.createdAt ?? new Date(2026, 0, 1).toISOString(),
    };
}

function mkIndeed(keywords: string, opts: { location?: string; track?: "career" | "side"; createdAt?: string } = {}): WatchlistWire {
    return {
        id: `w${nextId++}`,
        userId: "u1",
        name: `${keywords}${opts.location ? ` — ${opts.location}` : ""} (Indeed)`,
        kind: "indeed",
        config: { kind: "indeed", keywords, location: opts.location, companyName: "Indeed search" },
        directoryKey: null,
        negativeFilters: [],
        notificationMode: "each",
        lastDigestAt: null,
        scheduleMinutes: 240,
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        active: true,
        track: opts.track ?? "career",
        createdAt: opts.createdAt ?? new Date(2026, 0, 1).toISOString(),
        updatedAt: opts.createdAt ?? new Date(2026, 0, 1).toISOString(),
    };
}

function mkGreenhouse(slug: string, opts: { createdAt?: string } = {}): WatchlistWire {
    return {
        id: `w${nextId++}`,
        userId: "u1",
        name: `${slug}`,
        kind: "greenhouse",
        config: { kind: "greenhouse", boardSlug: slug, companyName: slug },
        directoryKey: null,
        negativeFilters: [],
        notificationMode: "each",
        lastDigestAt: null,
        scheduleMinutes: 240,
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        active: true,
        track: "career",
        createdAt: opts.createdAt ?? new Date(2026, 0, 1).toISOString(),
        updatedAt: opts.createdAt ?? new Date(2026, 0, 1).toISOString(),
    };
}

function isGroup(item: WatchlistRowItem): item is FindRolesGroup {
    return item.kind === "group";
}

function main() {
    // ─── helpers ───
    if (!isFindRolesKind("linkedin")) fail("linkedin should be a find-roles kind");
    else pass("linkedin recognized as find-roles kind");
    if (!isFindRolesKind("indeed")) fail("indeed should be a find-roles kind");
    else pass("indeed recognized as find-roles kind");
    if (isFindRolesKind("greenhouse")) fail("greenhouse should NOT be a find-roles kind");
    else pass("greenhouse not a find-roles kind");

    // ─── group key ───
    const li = mkLinkedin("Engineer", { location: "Remote, US" });
    const ind = mkIndeed("engineer", { location: "remote, us" });
    if (findRolesGroupKey(li) !== findRolesGroupKey(ind)) {
        fail(`group key should be case/trim-insensitive (li=${findRolesGroupKey(li)} vs ind=${findRolesGroupKey(ind)})`);
    } else pass("group key normalizes case + trim for keywords + location");

    const noLoc = mkLinkedin("Engineer");
    if (findRolesGroupKey(noLoc) === findRolesGroupKey(li)) fail("group key with no location should differ from one with location");
    else pass("group key: empty location ≠ explicit location");

    const sideTrack = mkLinkedin("Engineer", { location: "Remote, US", track: "side" });
    if (findRolesGroupKey(sideTrack) === findRolesGroupKey(li)) fail("group key should differ across tracks");
    else pass("group key: different track → different group");

    if (findRolesGroupKey(mkGreenhouse("acme")) !== null) fail("greenhouse should yield null key");
    else pass("non-find-roles kind → null group key");

    // ─── empty input ───
    nextId = 1;
    const empty = groupWatchlists([]);
    if (empty.length !== 0) fail("empty input should yield empty output");
    else pass("empty input → empty output");

    // ─── one watchlist, find-roles kind → still produces a group of size 1 ───
    nextId = 1;
    const oneLi = groupWatchlists([mkLinkedin("Engineer", { location: "Remote" })]);
    if (oneLi.length !== 1) fail(`expected 1 item, got ${oneLi.length}`);
    else if (!isGroup(oneLi[0])) fail("single linkedin watchlist should produce a group (so the user can later 'add a source')");
    else if (oneLi[0].members.length !== 1) fail("group should have 1 member");
    else pass("single linkedin watchlist → group of size 1");

    // ─── two same-search linkedin + indeed → one group of 2 ───
    nextId = 1;
    const pair = groupWatchlists([
        mkLinkedin("Mechanical engineer", { location: "Remote, US" }),
        mkIndeed("Mechanical engineer", { location: "Remote, US" }),
    ]);
    if (pair.length !== 1) fail(`expected 1 group, got ${pair.length}`);
    else if (!isGroup(pair[0])) fail("expected a group");
    else if (pair[0].members.length !== 2) fail(`expected 2 members, got ${pair[0].members.length}`);
    else pass("linkedin + indeed with same keywords/location → one group of 2");

    // ─── group title ───
    if (isGroup(pair[0])) {
        if (groupTitle(pair[0]) !== "Mechanical engineer — Remote, US") fail(`groupTitle wrong (${groupTitle(pair[0])})`);
        else pass("groupTitle = keywords — location");

        const noLocGroup: FindRolesGroup = {
            kind: "group",
            groupKey: "x|",
            keywords: "Bare keyword",
            location: null,
            track: "career",
            members: [],
        };
        if (groupTitle(noLocGroup) !== "Bare keyword") fail(`groupTitle should drop em-dash when location is null (${groupTitle(noLocGroup)})`);
        else pass("groupTitle drops em-dash when no location");
    }

    // ─── different searches don't collapse ───
    nextId = 1;
    const distinct = groupWatchlists([
        mkLinkedin("Engineer A", { location: "Remote" }),
        mkLinkedin("Engineer B", { location: "Remote" }),
    ]);
    if (distinct.length !== 2) fail(`distinct keywords should produce 2 groups (got ${distinct.length})`);
    else pass("distinct keywords → distinct groups");

    // ─── different tracks DON'T collapse even with same keywords/location ───
    nextId = 1;
    const trackSplit = groupWatchlists([
        mkLinkedin("Driver", { location: "LA", track: "career" }),
        mkLinkedin("Driver", { location: "LA", track: "side" }),
    ]);
    if (trackSplit.length !== 2) fail(`career + side same search should be 2 groups (got ${trackSplit.length})`);
    else pass("career vs side → distinct groups (track is part of identity)");

    // ─── non-find-roles kinds always single ───
    nextId = 1;
    const mixed = groupWatchlists([
        mkGreenhouse("anthropic"),
        mkGreenhouse("stripe"),
        mkLinkedin("Engineer", { location: "Remote" }),
        mkIndeed("Engineer", { location: "Remote" }),
    ]);
    const groups = mixed.filter(isGroup);
    const singlesCount = mixed.length - groups.length;
    if (groups.length !== 1) fail(`expected 1 group, got ${groups.length}`);
    else pass("mixed list: linkedin + indeed group, greenhouses kept single");
    if (singlesCount !== 2) fail(`expected 2 singles for greenhouses, got ${singlesCount}`);
    else pass("mixed list: greenhouses each render as their own single");

    // ─── ordering: groups + singles interleaved by createdAt desc ───
    nextId = 1;
    const ordered = groupWatchlists([
        mkLinkedin("Old search", { location: "X", createdAt: "2026-01-01T00:00:00.000Z" }),
        mkIndeed("Old search", { location: "X", createdAt: "2026-01-02T00:00:00.000Z" }), // anchor is older LI
        mkGreenhouse("middle-co", { createdAt: "2026-02-15T00:00:00.000Z" }),
        mkLinkedin("Newest search", { location: "Y", createdAt: "2026-03-10T00:00:00.000Z" }),
    ]);
    if (ordered.length !== 3) fail(`expected 3 row items, got ${ordered.length}`);
    else {
        // Newest first
        if (!isGroup(ordered[0]) || ordered[0].keywords !== "Newest search") fail("newest search should sort first");
        else pass("newest find-roles group sorts first (desc by anchor createdAt)");
        if (isGroup(ordered[1]) || ordered[1].watchlist.kind !== "greenhouse") fail("greenhouse should sort middle");
        else pass("greenhouse single interleaves between groups by its own createdAt");
        if (!isGroup(ordered[2]) || ordered[2].keywords !== "Old search") fail("old search should sort last");
        else pass("oldest find-roles group sorts last");
        // Anchor is the older member (LinkedIn 2026-01-01), not the newer (Indeed 2026-01-02)
        if (isGroup(ordered[2]) && ordered[2].members[0].kind !== "linkedin") fail("anchor (members[0]) should be the OLDER member");
        else pass("group anchor is the oldest member (members[0])");
    }

    // ─── search-match across group title + single name ───
    nextId = 1;
    const items = groupWatchlists([
        mkLinkedin("Rocket Propulsion", { location: "Texas" }),
        mkGreenhouse("anthropic"),
    ]);
    const lower = "rocket";
    if (!items.some(i => rowItemMatchesSearch(i, lower))) fail("search needle 'rocket' should match the group");
    else pass("rowItemMatchesSearch matches group title");
    if (rowItemMatchesSearch(items[0], "")) pass("rowItemMatchesSearch: empty needle matches everything");
    else fail("empty needle should match everything");

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
}

main();
