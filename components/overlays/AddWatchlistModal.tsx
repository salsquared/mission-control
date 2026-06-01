"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Loader2, Search, Building2, Settings2, Sparkles, Check, Minus, ArrowUpToLine, ChevronLeft, ChevronRight, Telescope, RefreshCw, Copy, AlertTriangle, Ban } from "lucide-react";
import { api } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";
import {
    DIRECTORY_TAGS,
    searchDirectory,
    watchlistConfigKey,
    type CompanyDirectoryEntry,
    type DirectoryTag,
} from "@/lib/company-directory";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";
import type { WatchlistWire } from "@/lib/schemas/watchlists";

interface BlacklistEntry {
    id: string;
    name: string;
    normalizedName: string;
    reason: string | null;
    createdAt: string;
}

interface AddWatchlistModalProps {
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
    /**
     * Existing watchlists, used to mark directory entries that are already on
     * the user's watchlist as "Added." Pass `[]` if you don't have them — the
     * picker still works, just without the dedup hint.
     */
    existingWatchlists?: readonly WatchlistWire[];
    /**
     * MB Phase 4. Stamps every watchlist created from this modal instance
     * with the given track. Defaults to "career" so existing call sites are
     * unaffected. The side-track WatchlistsCard mounts its own modal with
     * defaultTrack="side" so the "+ Add watchlist" button creates side rows.
     */
    defaultTrack?: "career" | "side";
}

// Three top-level modes. Default lands on "find" because the most common
// workflow is "I want a kind of job, find me matches" — not "I know Anthropic
// uses Greenhouse with slug `anthropic`, plug it in."
type Mode = "find" | "company" | "discover" | "advanced";

type DiscoverVerified = {
    name: string;
    blurb: string;
    kind: "greenhouse" | "lever" | "ashby";
    slug: string;
    companyName: string;
    jobCount: number;
};

type DiscoverUnverified = {
    name: string;
    blurb: string;
    careersUrl: string;
    atsGuess: string;
    reason: string;
};

type AdvancedKind =
    | "greenhouse"
    | "lever"
    | "ashby"
    | "workday"
    | "smartrecruiters"
    | "workable"
    | "recruitee"
    | "personio"
    | "clearcompany"
    | "linkedin"
    | "indeed"
    | "careers-page";

// Cross-company keyword-search sources surfaced in the "Find roles" tab.
// LinkedIn and Indeed are the only two aggregators we currently scrape — every
// other ATS is per-company (you need a slug to fetch its postings). Keep
// `id` in sync with the discriminated-union literals in lib/schemas/watchlists.ts.
const FIND_SOURCES = [
    {
        id: "linkedin" as const,
        label: "LinkedIn",
        hint: "Largest general index. Fragile — DOM shifts and bot detection.",
    },
    {
        id: "indeed" as const,
        label: "Indeed",
        hint: "Mass-market aggregator. Cloudflare-gated; intermittent challenges.",
    },
];
type FindSourceId = (typeof FIND_SOURCES)[number]["id"];

// Kinds that take a single boardSlug + companyName (the most common shape).
// Used to keep render conditions / submit dispatch concise.
const SLUG_KINDS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "recruitee", "personio", "clearcompany"] as const satisfies readonly AdvancedKind[];
type SlugKind = (typeof SLUG_KINDS)[number];
function isSlugKind(k: AdvancedKind): k is SlugKind {
    return (SLUG_KINDS as readonly AdvancedKind[]).includes(k);
}

const COMPANY_PAGE_SIZE = 10;

const ADVANCED_KIND_HELP: Record<AdvancedKind, string> = {
    "greenhouse": "Slug from boards.greenhouse.io/<slug> — e.g. anthropic, stripe, rocketlab, vercel.",
    "lever": "Slug from jobs.lever.co/<slug> — e.g. spotify, leverdemo.",
    "ashby": "Slug from jobs.ashbyhq.com/<slug> — e.g. notion, posthog.",
    "workday": "Two fields. Tenant host: <tenant>.wd<N>.myworkdayjobs.com (e.g. boeing.wd1.myworkdayjobs.com). Career site: the segment after the host on the public careers page (e.g. EXTERNAL_CAREERS, BlueOrigin).",
    "smartrecruiters": "Slug from jobs.smartrecruiters.com/<slug> — e.g. Visa, ServiceNow, Ubisoft. Case-sensitive: \"Visa\" ≠ \"visa\".",
    "workable": "Subdomain on apply.workable.com — e.g. \"careers\" → apply.workable.com/careers. Most ~50–500-person companies.",
    "recruitee": "Subdomain on recruitee.com — e.g. \"jet\" → jet.recruitee.com. Mostly EU companies.",
    "personio": "Subdomain on jobs.personio.com — e.g. \"personio\" → personio.jobs.personio.com. Lots of European companies.",
    "clearcompany": "siteId (UUID) from careers-api.clearcompany.com/v1/<siteId>. Find it in the careers page's <script src=\"careers-content.clearcompany.com/js/v1/career-site.js?siteId=...\"> tag. Firefly Aerospace and other mid-market companies.",
    "linkedin": "Free-text keyword search (matches what you'd type in LinkedIn's job search bar). Fragile by design — LinkedIn DOM-shifts often, expect occasional breakage.",
    "indeed": "Free-text keyword search across Indeed's mass-market index (the \"what\" + \"where\" inputs on indeed.com). Same fragility class as LinkedIn — Cloudflare-gated, expect occasional 0-result days.",
    "careers-page": "Use only for old-school static-HTML careers pages. Most modern pages are SPAs and won't work here — try one of the aggregator kinds first.",
};

const ADVANCED_SLUG_PLACEHOLDER: Record<SlugKind, string> = {
    "greenhouse": "anthropic",
    "lever": "spotify",
    "ashby": "notion",
    "smartrecruiters": "Visa",
    "workable": "careers",
    "recruitee": "jet",
    "personio": "personio",
    "clearcompany": "00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5",
};

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// Dedup discover suggestions by name (case-insensitive). Gemini occasionally
// returns the same company twice in one response — without this, the React
// list-key collision shows up as a "two children with the same key" warning
// and the second instance gets clobbered. First occurrence wins so the
// preserved entry is whichever the model ranked higher.
function uniqByName<T extends { name: string }>(items: readonly T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const it of items) {
        const k = it.name.trim().toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(it);
    }
    return out;
}

export const AddWatchlistModal: React.FC<AddWatchlistModalProps> = ({ open, onClose, onCreated, existingWatchlists = [], defaultTrack = "career" }) => {
    // SSR gate: createPortal needs document.body, which only exists on the
    // client. Without this, the modal would crash during server render.
    const [mounted, setMounted] = useState(false);
    useEffect(() => { setMounted(true); }, []);

    const [mode, setMode] = useState<Mode>("find");
    const [submitting, setSubmitting] = useState(false);

    // ─── "find" mode (cross-company keyword search) ──────────────────────────
    const [findKeywords, setFindKeywords] = useState("");
    const [findLocation, setFindLocation] = useState("");
    // Multi-select: which aggregator(s) to crawl. Defaults to all (both checked)
    // so the simplest user flow ("type a role, hit search") fans out to maximum
    // coverage; the user can uncheck any source they don't want.
    const [findSources, setFindSources] = useState<Set<FindSourceId>>(
        () => new Set(FIND_SOURCES.map(s => s.id)),
    );

    // ─── "company" mode (directory picker) ───────────────────────────────────
    const [companyQuery, setCompanyQuery] = useState("");
    const [companyTagFilter, setCompanyTagFilter] = useState<Set<DirectoryTag>>(new Set());
    // Multi-select: holds the `.name` of each chosen directory entry. Submit
    // fires N create requests in parallel.
    const [selectedDirKeys, setSelectedDirKeys] = useState<Set<string>>(new Set());
    // Already-added entries are hidden by default to keep the picker focused
    // on what's actually addable. Flip this on to reveal them — they'll float
    // to the top so it's easy to audit what's already on the watchlist.
    const [showAdded, setShowAdded] = useState(false);
    const [companyPage, setCompanyPage] = useState(0);

    // ─── "discover" mode (Gemini-suggested + slug-probe) ────────────────────
    const [discoverTopic, setDiscoverTopic] = useState("");
    const [discoverLoading, setDiscoverLoading] = useState(false);
    const [discoverError, setDiscoverError] = useState<string | null>(null);
    const [discoverVerified, setDiscoverVerified] = useState<DiscoverVerified[]>([]);
    const [discoverUnverified, setDiscoverUnverified] = useState<DiscoverUnverified[]>([]);
    // Names the user has seen across "Refresh suggestions" clicks this session,
    // fed back to the server so Gemini keeps digging instead of looping the
    // same canonical answers (see memory[feedback-llm-anti-repetition]).
    const [discoverSeen, setDiscoverSeen] = useState<string[]>([]);
    const [discoverSelected, setDiscoverSelected] = useState<Set<string>>(new Set());

    // ─── "advanced" mode (the legacy 6-way picker, unchanged behavior) ──────
    const [advKind, setAdvKind] = useState<AdvancedKind>("greenhouse");
    const [advName, setAdvName] = useState("");
    const [advCompanyName, setAdvCompanyName] = useState("");
    const [advBoardSlug, setAdvBoardSlug] = useState("");
    const [advRootUrl, setAdvRootUrl] = useState("");
    const [advLinkPattern, setAdvLinkPattern] = useState("/careers/(positions|jobs)/");
    const [advTenantHost, setAdvTenantHost] = useState("");
    const [advCareerSite, setAdvCareerSite] = useState("");
    const [advKeywords, setAdvKeywords] = useState("");
    const [advLocation, setAdvLocation] = useState("");

    // Shared cadence — applies to whichever mode the user submits in. Stored
    // in hours (the user-facing unit); converted to scheduleMinutes when we
    // POST. 4h default — see WatchlistPostSchema for the rationale.
    const [scheduleHours, setScheduleHours] = useState(4);

    // ─── Blacklist (user-curated "never recommend") ─────────────────────────
    // Lives in the Advanced tab as an editor, but the filter applies to ALL
    // recommendation surfaces (directory results, auto-discover panel,
    // Discover tab). Loaded once per modal-open so adds/removes inside the
    // session are reflected immediately, and the next open re-syncs.
    const [blacklistEntries, setBlacklistEntries] = useState<BlacklistEntry[]>([]);
    const [blacklistAddName, setBlacklistAddName] = useState("");
    const [blacklistBusy, setBlacklistBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        (async () => {
            try {
                const result = await api.blacklist.list();
                if (!cancelled) setBlacklistEntries(result.entries);
            } catch (err) {
                if (!cancelled) {
                    toastStore.push({ message: `Blacklist load failed: ${errMessage(err)}`, type: "error" });
                }
            }
        })();
        return () => { cancelled = true; };
    }, [open]);

    const blacklistedNormalized = useMemo(
        () => new Set(blacklistEntries.map(b => b.normalizedName)),
        [blacklistEntries],
    );
    const isBlacklisted = useCallback(
        (name: string) => blacklistedNormalized.has(normalizeCompanyName(name).toLowerCase()),
        [blacklistedNormalized],
    );

    // Build the set of identity keys for watchlists the user already has.
    // Directory entries whose key is in this set render disabled with an
    // "Added" chip — protects against accidental duplicate crawls.
    const existingKeys = useMemo(() => {
        const s = new Set<string>();
        for (const w of existingWatchlists) {
            const key = watchlistConfigKey(w.config);
            if (key) s.add(key);
        }
        return s;
    }, [existingWatchlists]);

    const directoryResults = useMemo(() => {
        // Blacklist filter happens FIRST — blacklisted companies should be
        // indistinguishable from "not in the directory at all," not surface
        // under any toggle. (showAdded reveals existing-watchlist entries,
        // not blacklisted ones — different semantics.)
        const base = searchDirectory(companyQuery, companyTagFilter.size > 0 ? companyTagFilter : null)
            .filter(e => !isBlacklisted(e.name));
        // Stable partition: split into already-added vs. addable, preserving
        // relative order within each side. Default behavior hides the added
        // bucket; toggling `showAdded` reveals it AND pins it to the top.
        const added: CompanyDirectoryEntry[] = [];
        const rest: CompanyDirectoryEntry[] = [];
        for (const e of base) {
            const key = watchlistConfigKey(e.config);
            if (key && existingKeys.has(key)) added.push(e);
            else rest.push(e);
        }
        return showAdded ? [...added, ...rest] : rest;
    }, [companyQuery, companyTagFilter, showAdded, existingKeys, isBlacklisted]);

    // Blacklist-filtered display lists for the Discover panel + auto-discover
    // sparse-fallback. Apply at render-time (not at the setter) so adding to
    // the blacklist mid-session re-filters in place without a refetch.
    const visibleDiscoverVerified = useMemo(
        () => discoverVerified.filter(v => !isBlacklisted(v.name)),
        [discoverVerified, isBlacklisted],
    );
    const visibleDiscoverUnverified = useMemo(
        () => discoverUnverified.filter(u => !isBlacklisted(u.name)),
        [discoverUnverified, isBlacklisted],
    );

    // Bounce to page 1 when the filter inputs change — page-3-of-unfiltered
    // shouldn't carry over to page-3-of-filtered (likely empty). Render-time
    // adjustment to avoid useEffect+setState (lint-flagged elsewhere in this
    // repo). Selections (`selectedDirKeys`) intentionally NOT in the key so
    // checking a box doesn't bounce you back to page 1 mid-selection.
    const companyFilterKey = `${companyQuery}|${Array.from(companyTagFilter).sort().join(",")}|${showAdded}`;
    const [lastCompanyFilterKey, setLastCompanyFilterKey] = useState(companyFilterKey);
    if (lastCompanyFilterKey !== companyFilterKey) {
        setLastCompanyFilterKey(companyFilterKey);
        setCompanyPage(0);
    }

    const companyPageCount = Math.max(1, Math.ceil(directoryResults.length / COMPANY_PAGE_SIZE));
    const safeCompanyPage = Math.min(companyPage, companyPageCount - 1);
    const companyPageStart = safeCompanyPage * COMPANY_PAGE_SIZE;
    const pagedDirectoryResults = directoryResults.slice(companyPageStart, companyPageStart + COMPANY_PAGE_SIZE);

    // Auto-discover: when the user narrows the Watch-company picker to a
    // tag (or text query) but the directory has < 3 matches, kick off the
    // same Gemini-suggest path that the Discover tab uses, and surface the
    // verified hits inline so the user can add them in the same flow.
    //
    // Topic string is "<tag1> <tag2> … <query>". Tags are the dominant signal;
    // the search text just refines it. The discovery API treats it as a
    // free-text natural-language topic.
    const SPARSE_THRESHOLD = 3;
    const autoDiscoverTopic = useMemo(() => {
        const tagsStr = Array.from(companyTagFilter).join(" ");
        const queryStr = companyQuery.trim();
        return [tagsStr, queryStr].filter(Boolean).join(" ").trim();
    }, [companyTagFilter, companyQuery]);
    const directoryIsSparse = directoryResults.length < SPARSE_THRESHOLD;
    const shouldAutoDiscover = mode === "company" && autoDiscoverTopic.length > 0 && directoryIsSparse;

    // Fire once per (topic, sparse-state) transition. Guarded by a ref so
    // toggling unrelated state (selecting an entry, switching tabs) doesn't
    // re-fire the API call for the same topic. A ref (vs useState) sidesteps
    // the `react-hooks/set-state-in-effect` lint rule — this is pure
    // bookkeeping that doesn't drive render.
    const lastAutoFiredTopicRef = useRef<string | null>(null);
    useEffect(() => {
        if (shouldAutoDiscover && lastAutoFiredTopicRef.current !== autoDiscoverTopic) {
            lastAutoFiredTopicRef.current = autoDiscoverTopic;
            // Mirror the topic into the Discover tab's input so switching tabs
            // shows context; pass [] for exclude because this is a fresh topic
            // and we don't want excludes from a prior topic to leak in.
            setDiscoverTopic(autoDiscoverTopic);
            setDiscoverSeen([]);
            void runDiscoverFor(autoDiscoverTopic, []);
        } else if (!shouldAutoDiscover && lastAutoFiredTopicRef.current !== null) {
            lastAutoFiredTopicRef.current = null;
        }
    // runDiscoverFor closes over `discoverLoading`, but firing while loading is
    // already guarded inside the function. Excluding it (and other state-setter
    // closures) from the dep list is intentional — they'd otherwise re-fire
    // the useEffect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shouldAutoDiscover, autoDiscoverTopic]);

    if (!open || !mounted) return null;

    function reset() {
        setMode("find");
        setFindKeywords("");
        setFindLocation("");
        setFindSources(new Set(FIND_SOURCES.map(s => s.id)));
        setCompanyQuery("");
        setCompanyTagFilter(new Set());
        setSelectedDirKeys(new Set());
        setShowAdded(false);
        setCompanyPage(0);
        setDiscoverTopic("");
        setDiscoverError(null);
        setDiscoverVerified([]);
        setDiscoverUnverified([]);
        setDiscoverSeen([]);
        setDiscoverSelected(new Set());
        setAdvKind("greenhouse");
        setAdvName("");
        setAdvCompanyName("");
        setAdvBoardSlug("");
        setAdvRootUrl("");
        setAdvLinkPattern("/careers/(positions|jobs)/");
        setAdvTenantHost("");
        setAdvCareerSite("");
        setAdvKeywords("");
        setAdvLocation("");
        setScheduleHours(4);
        setBlacklistAddName("");
        // NB: blacklistEntries is server state — we don't clear it on close;
        // the open-effect refetches on next open.
        lastAutoFiredTopicRef.current = null;
    }

    async function handleAddToBlacklist(rawName: string) {
        const name = rawName.trim();
        if (!name || blacklistBusy) return;
        const norm = normalizeCompanyName(name).toLowerCase();
        if (!norm) {
            toastStore.push({ message: "Company name normalized to empty — try a longer name", type: "error" });
            return;
        }
        setBlacklistBusy(true);
        try {
            const result = await api.blacklist.add({ name });
            // Server is the source of truth — the response carries the canonical
            // row (with normalizedName), which we slot in (replacing any earlier
            // dupe by id) and re-sort by createdAt descending to match the GET.
            setBlacklistEntries(prev => {
                const next = prev.filter(e => e.id !== result.entry.id);
                next.unshift(result.entry);
                return next;
            });
            setBlacklistAddName("");
            // Drop any selection that just became blacklisted so submit can't
            // create a watchlist for a company the user just opted out of.
            const drop = (n: string) => normalizeCompanyName(n).toLowerCase() === result.entry.normalizedName;
            setSelectedDirKeys(prev => {
                const next = new Set(prev);
                for (const n of prev) if (drop(n)) next.delete(n);
                return next;
            });
            setDiscoverSelected(prev => {
                const next = new Set(prev);
                for (const n of prev) if (drop(n)) next.delete(n);
                return next;
            });
        } catch (err) {
            toastStore.push({ message: `Blacklist add failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setBlacklistBusy(false);
        }
    }

    async function handleRemoveFromBlacklist(id: string) {
        if (blacklistBusy) return;
        setBlacklistBusy(true);
        try {
            await api.blacklist.remove(id);
            setBlacklistEntries(prev => prev.filter(e => e.id !== id));
        } catch (err) {
            toastStore.push({ message: `Blacklist remove failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setBlacklistBusy(false);
        }
    }

    function handleClose() {
        if (submitting) return;
        reset();
        onClose();
    }

    function toggleCompanyTag(tag: DirectoryTag) {
        setCompanyTagFilter(prev => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    }

    function toggleFindSource(id: FindSourceId) {
        setFindSources(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    async function submitFind(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        const kw = findKeywords.trim();
        if (!kw) return;
        const selected = FIND_SOURCES.filter(s => findSources.has(s.id));
        if (selected.length === 0) return;
        const loc = findLocation.trim();
        const baseName = loc ? `${kw} — ${loc}` : kw;
        // companyName on a keyword search is semantically "the source," not
        // a specific employer — each fetcher fills the actual employer onto
        // every posting. We just stamp the source name so admin surfaces have
        // something readable.
        const sourceCompanyName: Record<FindSourceId, string> = {
            linkedin: "LinkedIn search",
            indeed: "Indeed search",
        };
        // Disambiguate row names only when we're creating >1 — single-source
        // (the legacy shape) keeps the bare title.
        const labelFor = (label: string) =>
            selected.length > 1 ? `${baseName} (${label})` : baseName;
        setSubmitting(true);
        try {
            const results = await Promise.allSettled(selected.map(src =>
                api.watchlists.create({
                    name: labelFor(src.label),
                    config: {
                        kind: src.id,
                        keywords: kw,
                        location: loc || undefined,
                        companyName: sourceCompanyName[src.id],
                    },
                    scheduleMinutes: scheduleHours * 60,
                    track: defaultTrack,
                })
            ));
            const okIdx = results
                .map((r, i) => r.status === "fulfilled" ? i : -1)
                .filter(i => i >= 0);
            const failedIdx = results
                .map((r, i) => r.status === "rejected" ? i : -1)
                .filter(i => i >= 0);
            if (okIdx.length > 0) {
                const names = okIdx.map(i => labelFor(selected[i].label));
                toastStore.push({
                    message: names.length === 1
                        ? `Watching for: ${names[0]}`
                        : `Watching ${names.length} sources for "${baseName}"`,
                    type: "info",
                });
            }
            if (failedIdx.length > 0) {
                const failedLabels = failedIdx.map(i => selected[i].label);
                toastStore.push({
                    message: `Failed: ${failedLabels.join(", ")}`,
                    type: "error",
                });
            }
            onCreated();
            if (failedIdx.length === 0) {
                reset();
                onClose();
            }
        } catch (err) {
            // Promise.allSettled doesn't throw — this catches only unexpected
            // programmer errors (e.g. a sync throw inside the map callback).
            toastStore.push({ message: `Create failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setSubmitting(false);
        }
    }

    async function submitCompany(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        if (selectedDirKeys.size === 0 && discoverSelected.size === 0) return;
        // Resolve every selected key against the current directory results.
        // (We carry only the name in selectedDirKeys; rehydrate to entries
        // here so the create payload has fresh config — protects against
        // selection going stale if the directory shifts mid-flow.)
        const allEntries = searchDirectory("", null);
        const byName = new Map(allEntries.map(e => [e.name, e] as const));
        const dirEntries = Array.from(selectedDirKeys)
            .map(name => byName.get(name))
            .filter((e): e is CompanyDirectoryEntry => Boolean(e))
            // Defense in depth — handleAddToBlacklist already drops blacklisted
            // names from selectedDirKeys, but a stale selection from a race
            // shouldn't be allowed to resurrect a blacklisted entry.
            .filter(e => !isBlacklisted(e.name));
        // Auto-discover suggestions selected from the sparse-fallback panel.
        // Only verified hits are wireable; unverified entries don't have a
        // slug/kind to build a config from.
        const discoverEntries = visibleDiscoverVerified.filter(v => discoverSelected.has(v.name));
        if (dirEntries.length === 0 && discoverEntries.length === 0) return;
        setSubmitting(true);
        try {
            const dirPromises = dirEntries.map(entry =>
                api.watchlists.create({
                    name: entry.name,
                    config: entry.config,
                    scheduleMinutes: scheduleHours * 60,
                    // PB-14: bind to the directory entry so future slug/ATS
                    // corrections in lib/company-directory.ts apply automatically.
                    directoryKey: entry.name,
                    track: defaultTrack,
                })
            );
            const discoverPromises = discoverEntries.map(entry =>
                api.watchlists.create({
                    name: entry.name,
                    config: { kind: entry.kind, boardSlug: entry.slug, companyName: entry.companyName },
                    scheduleMinutes: scheduleHours * 60,
                    track: defaultTrack,
                })
            );
            const allEntriesOrdered = [...dirEntries, ...discoverEntries];
            const results = await Promise.allSettled([...dirPromises, ...discoverPromises]);
            const okCount = results.filter(r => r.status === "fulfilled").length;
            const failed = results
                .map((r, i) => r.status === "rejected" ? allEntriesOrdered[i].name : null)
                .filter((n): n is string => Boolean(n));
            if (okCount > 0) {
                toastStore.push({
                    message: okCount === 1
                        ? `Watching ${allEntriesOrdered.find((_, i) => results[i].status === "fulfilled")?.name}`
                        : `Watching ${okCount} companies`,
                    type: "info",
                });
            }
            if (failed.length > 0) {
                toastStore.push({
                    message: `Failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`,
                    type: "error",
                });
            }
            onCreated();
            if (failed.length === 0) {
                reset();
                onClose();
            }
        } catch (err) {
            // Promise.allSettled doesn't throw, so this catches only programmer
            // errors (unexpected throws inside the map callback).
            toastStore.push({ message: `Create failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setSubmitting(false);
        }
    }

    // Pure-topic variant — pulled out so the Watch-company tab's auto-discover
    // (when the directory is sparse for a tag/query) can call it directly
    // without faking a form event. `exclude` is parameterized for the same
    // reason: auto-discover fires with [] (fresh) on every topic change, while
    // the manual "More" button passes the cumulative `discoverSeen` to keep
    // digging.
    async function runDiscoverFor(rawTopic: string, exclude: string[]) {
        const topic = rawTopic.trim();
        if (!topic || discoverLoading) return;
        setDiscoverLoading(true);
        setDiscoverError(null);
        try {
            const result = await api.discovery.suggest({
                topic,
                additionalExclude: exclude,
            });
            setDiscoverVerified(uniqByName(result.verified));
            setDiscoverUnverified(uniqByName(result.unverified));
            setDiscoverSelected(new Set());
            // Accumulate seen names for the next refresh click.
            setDiscoverSeen(prev => Array.from(new Set([
                ...prev,
                ...result.verified.map(v => v.name),
                ...result.unverified.map(u => u.name),
            ])));
            if (result.verified.length === 0 && result.unverified.length === 0) {
                setDiscoverError("Gemini didn't return any candidates. Try a more specific topic, or click Refresh.");
            }
        } catch (err) {
            setDiscoverError(errMessage(err));
        } finally {
            setDiscoverLoading(false);
        }
    }

    async function runDiscover(e?: React.FormEvent) {
        e?.preventDefault();
        await runDiscoverFor(discoverTopic, discoverSeen);
    }

    // Resets the cumulative "seen" memory when the user changes topic — so
    // moving from "space" → "biotech" doesn't carry the space companies into
    // the biotech exclude list.
    function setDiscoverTopicFresh(t: string) {
        if (t.trim().toLowerCase() !== discoverTopic.trim().toLowerCase()) {
            setDiscoverSeen([]);
            setDiscoverVerified([]);
            setDiscoverUnverified([]);
            setDiscoverSelected(new Set());
            setDiscoverError(null);
        }
        setDiscoverTopic(t);
    }

    function toggleDiscoverSelected(name: string) {
        setDiscoverSelected(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    }

    async function submitDiscover(e: React.FormEvent) {
        e.preventDefault();
        if (submitting || discoverSelected.size === 0) return;
        const entries = visibleDiscoverVerified.filter(v => discoverSelected.has(v.name));
        if (entries.length === 0) return;
        setSubmitting(true);
        try {
            const results = await Promise.allSettled(entries.map(entry =>
                api.watchlists.create({
                    name: entry.name,
                    config: { kind: entry.kind, boardSlug: entry.slug, companyName: entry.companyName },
                    scheduleMinutes: scheduleHours * 60,
                    track: defaultTrack,
                })
            ));
            const okCount = results.filter(r => r.status === "fulfilled").length;
            const failed = results
                .map((r, i) => r.status === "rejected" ? entries[i].name : null)
                .filter((n): n is string => Boolean(n));
            if (okCount > 0) {
                toastStore.push({
                    message: okCount === 1
                        ? `Watching ${entries[0].name}`
                        : `Watching ${okCount} companies`,
                    type: "info",
                });
            }
            if (failed.length > 0) {
                toastStore.push({
                    message: `Failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`,
                    type: "error",
                });
            }
            onCreated();
            if (failed.length === 0) {
                reset();
                onClose();
            }
        } catch (err) {
            toastStore.push({ message: `Create failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setSubmitting(false);
        }
    }

    async function copyToClipboard(text: string, label: string) {
        try {
            await navigator.clipboard.writeText(text);
            toastStore.push({ message: `Copied ${label}`, type: "info" });
        } catch {
            toastStore.push({ message: "Copy failed — your browser blocked clipboard access", type: "error" });
        }
    }

    function toggleDirEntry(name: string) {
        setSelectedDirKeys(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    }

    async function submitAdvanced(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        if (!advName.trim() || !advCompanyName.trim()) return;
        if (isSlugKind(advKind) && !advBoardSlug.trim()) return;
        if (advKind === "careers-page" && (!advRootUrl.trim() || !advLinkPattern.trim())) return;
        if (advKind === "workday" && (!advTenantHost.trim() || !advCareerSite.trim())) return;
        if ((advKind === "linkedin" || advKind === "indeed") && !advKeywords.trim()) return;

        setSubmitting(true);
        try {
            const config = (() => {
                // SmartRecruiters slugs are case-sensitive on the server side
                // (Visa works, visa doesn't). Don't lowercase the trim.
                if (advKind === "smartrecruiters") return { kind: "smartrecruiters" as const, boardSlug: advBoardSlug.trim(), companyName: advCompanyName.trim() };
                if (isSlugKind(advKind)) return { kind: advKind, boardSlug: advBoardSlug.trim(), companyName: advCompanyName.trim() };
                if (advKind === "workday") return {
                    kind: "workday" as const,
                    tenantHost: advTenantHost.trim().toLowerCase(),
                    careerSite: advCareerSite.trim(),
                    companyName: advCompanyName.trim(),
                };
                if (advKind === "linkedin") return {
                    kind: "linkedin" as const,
                    keywords: advKeywords.trim(),
                    location: advLocation.trim() || undefined,
                    companyName: advCompanyName.trim(),
                };
                if (advKind === "indeed") return {
                    kind: "indeed" as const,
                    keywords: advKeywords.trim(),
                    location: advLocation.trim() || undefined,
                    companyName: advCompanyName.trim(),
                };
                return { kind: "careers-page" as const, rootUrl: advRootUrl.trim(), linkPattern: advLinkPattern.trim(), companyName: advCompanyName.trim() };
            })();
            await api.watchlists.create({
                name: advName.trim(),
                config,
                scheduleMinutes: scheduleHours * 60,
                track: defaultTrack,
            });
            toastStore.push({ message: `Watchlist created: ${advName.trim()}`, type: "info" });
            onCreated();
            reset();
            onClose();
        } catch (err) {
            toastStore.push({ message: `Create failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setSubmitting(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={handleClose}>
            <div
                className="w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl flex flex-col max-h-[60vh]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
                    <h2 className="text-sm font-semibold text-white">Add to watchlist</h2>
                    <button onClick={handleClose} className="text-white/40 hover:text-white/80" aria-label="Close">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Mode tabs. MB Phase 4: the side track hides "Watch company"
                  * and "Discover" because both feed off COMPANY_DIRECTORY +
                  * Gemini career suggestions (Anthropic, Rocket Lab, …) and
                  * surfacing those inside the side modal would muddle the
                  * pipelines the user explicitly wants kept separate (story S13.1).
                  * Side stays keyword-first per story S13.2 — "Find roles" is the
                  * primary path, "Advanced" remains for the rare case the user
                  * wants to point at a specific big-box ATS slug. */}
                <div className="flex border-b border-white/10 shrink-0">
                    {[
                        { id: "find" as const, label: "Find roles", Icon: Sparkles, hint: "Search by what you want to do" },
                        ...(defaultTrack === "side" ? [] : [
                            { id: "company" as const, label: "Watch company", Icon: Building2, hint: "Pick a known company" },
                            { id: "discover" as const, label: "Discover", Icon: Telescope, hint: "Find more companies in a topic via Gemini" },
                        ]),
                        { id: "advanced" as const, label: "Advanced", Icon: Settings2, hint: "Hand-config a custom source" },
                    ].map(({ id, label, Icon, hint }) => {
                        const active = mode === id;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setMode(id)}
                                disabled={submitting}
                                title={hint}
                                className={[
                                    "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold transition-colors",
                                    active
                                        ? "bg-cyan-500/20 text-cyan-100 border-b-2 border-cyan-400"
                                        : "text-white/50 hover:text-white/80 border-b-2 border-transparent",
                                ].join(" ")}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {label}
                            </button>
                        );
                    })}
                </div>

                {/* Mode bodies — scrollable so tall forms (esp. Advanced) don't push action buttons offscreen */}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                {mode === "find" && (
                    <form onSubmit={submitFind} className="p-4 flex flex-col gap-3">
                        <p className="text-[11px] text-white/50">
                            Describe the role you want. We&apos;ll search the selected job boards and surface matches in your feed.
                        </p>

                        <label className="text-[11px] uppercase tracking-wide text-white/40">What kind of role?</label>
                        <input
                            type="text"
                            placeholder="e.g. software engineer, mechanical engineer, rocket propulsion"
                            value={findKeywords}
                            onChange={(e) => setFindKeywords(e.target.value)}
                            disabled={submitting}
                            autoFocus
                            className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                        />

                        <label className="text-[11px] uppercase tracking-wide text-white/40">Sources</label>
                        <div className="flex flex-wrap gap-1.5">
                            {FIND_SOURCES.map(src => {
                                const active = findSources.has(src.id);
                                return (
                                    <button
                                        key={src.id}
                                        type="button"
                                        onClick={() => toggleFindSource(src.id)}
                                        disabled={submitting}
                                        aria-pressed={active}
                                        title={src.hint}
                                        className={[
                                            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors",
                                            active
                                                ? "bg-cyan-500/25 text-cyan-100 border border-cyan-400/40"
                                                : "bg-black/40 text-white/50 border border-white/10 hover:text-white/80",
                                        ].join(" ")}
                                    >
                                        <span
                                            aria-hidden
                                            className={[
                                                "w-3 h-3 rounded border flex items-center justify-center",
                                                active ? "bg-cyan-500/50 border-cyan-300" : "bg-black/40 border-white/20",
                                            ].join(" ")}
                                        >
                                            {active && <Check className="w-2 h-2 text-cyan-50" />}
                                        </span>
                                        {src.label}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-white/30 -mt-1 leading-tight">
                            One watchlist per source — each runs on its own cadence. Cross-company search only works for these aggregators; other ATSes need a specific company slug (see &quot;Watch company&quot; or &quot;Advanced&quot;).
                        </p>

                        <label className="text-[11px] uppercase tracking-wide text-white/40">Where? (optional)</label>
                        <input
                            type="text"
                            placeholder="Remote, United States, New York, …"
                            value={findLocation}
                            onChange={(e) => setFindLocation(e.target.value)}
                            disabled={submitting}
                            className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                        />

                        <ScheduleField value={scheduleHours} onChange={setScheduleHours} disabled={submitting} />

                        <p className="text-[10px] text-white/30 leading-tight">
                            Heads-up: both LinkedIn and Indeed bot-detect aggressively, so expect occasional 0-result days when their markup shifts. For a specific company, use the &quot;Watch company&quot; tab.
                        </p>

                        <div className="flex items-center justify-end gap-2 pt-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                disabled={submitting}
                                className="px-4 py-2 text-xs text-white/60 hover:text-white/90 disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={submitting || !findKeywords.trim() || findSources.size === 0}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                                {(() => {
                                    if (submitting) return "Adding…";
                                    if (findSources.size === 0) return "Pick a source";
                                    if (findSources.size === 1) return "Start watching";
                                    return `Start watching (${findSources.size} sources)`;
                                })()}
                            </button>
                        </div>
                    </form>
                )}

                {mode === "company" && (
                    <form onSubmit={submitCompany} className="p-4 flex flex-col gap-3">
                        <p className="text-[11px] text-white/50">
                            Pick one or more companies from our verified list. We&apos;ll wire up the right job board source for each.
                        </p>

                        <input
                            type="text"
                            placeholder="Search by name…"
                            value={companyQuery}
                            onChange={(e) => setCompanyQuery(e.target.value)}
                            disabled={submitting}
                            autoFocus
                            className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                        />

                        {/* Tag filter chips + pin-added-to-top toggle */}
                        <div className="flex flex-wrap items-center gap-1">
                            {DIRECTORY_TAGS.map(tag => {
                                const active = companyTagFilter.has(tag);
                                return (
                                    <button
                                        key={tag}
                                        type="button"
                                        onClick={() => toggleCompanyTag(tag)}
                                        disabled={submitting}
                                        className={[
                                            "px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide font-semibold transition-colors",
                                            active
                                                ? "bg-cyan-500/30 text-cyan-100 border border-cyan-400/40"
                                                : "bg-black/40 text-white/40 border border-white/10 hover:text-white/70",
                                        ].join(" ")}
                                    >
                                        {tag}
                                    </button>
                                );
                            })}
                            <button
                                type="button"
                                onClick={() => setShowAdded(v => !v)}
                                disabled={submitting}
                                aria-pressed={showAdded}
                                title="Reveal companies already on your watchlist (pinned to the top of the list)"
                                className={[
                                    "ml-1 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide font-semibold transition-colors",
                                    showAdded
                                        ? "bg-emerald-500/25 text-emerald-100 border border-emerald-400/40"
                                        : "bg-black/40 text-white/40 border border-white/10 hover:text-white/70",
                                ].join(" ")}
                            >
                                <ArrowUpToLine className="w-2.5 h-2.5" />
                                Show watching
                            </button>
                        </div>

                        <div className="flex flex-col gap-1.5 pr-1">
                            {directoryResults.length === 0 ? (
                                <p className="text-xs text-white/40 italic py-4 text-center">
                                    Nothing matches. Try the &quot;Advanced&quot; tab to add a custom company.
                                </p>
                            ) : (
                                pagedDirectoryResults.map(entry => {
                                    const entryKey = watchlistConfigKey(entry.config);
                                    const alreadyAdded = entryKey !== null && existingKeys.has(entryKey);
                                    const selected = !alreadyAdded && selectedDirKeys.has(entry.name);
                                    const rowDisabled = submitting || alreadyAdded;
                                    const onActivate = () => { if (!rowDisabled) toggleDirEntry(entry.name); };
                                    return (
                                        // div+role="button" instead of <button> so the inner Blacklist
                                        // <button> can legally nest. Keyboard semantics preserved via
                                        // onKeyDown (Enter / Space).
                                        <div
                                            key={entry.name}
                                            role="button"
                                            tabIndex={rowDisabled ? -1 : 0}
                                            onClick={onActivate}
                                            onKeyDown={(e) => {
                                                if (rowDisabled) return;
                                                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
                                            }}
                                            aria-disabled={rowDisabled}
                                            aria-pressed={selected}
                                            title={alreadyAdded ? "Already on your watchlist" : undefined}
                                            className={[
                                                "flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors",
                                                alreadyAdded
                                                    ? "bg-black/20 border-white/5 opacity-60 cursor-not-allowed"
                                                    : selected
                                                        ? "bg-cyan-500/15 border-cyan-400/50 cursor-pointer"
                                                        : "bg-black/30 border-white/10 hover:border-white/30 cursor-pointer",
                                            ].join(" ")}
                                        >
                                            {/* Multi-select checkbox affordance (hidden for already-added entries). */}
                                            {!alreadyAdded && (
                                                <span
                                                    aria-hidden
                                                    className={[
                                                        "shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors",
                                                        selected
                                                            ? "bg-cyan-500/40 border-cyan-300"
                                                            : "bg-black/40 border-white/20",
                                                    ].join(" ")}
                                                >
                                                    {selected && <Check className="w-3 h-3 text-cyan-50" />}
                                                </span>
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-sm font-semibold text-white truncate">{entry.name}</span>
                                                    <span className="text-[10px] uppercase tracking-wide text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                                                        {entry.config.kind}
                                                    </span>
                                                    {alreadyAdded && (
                                                        <span className="text-[10px] uppercase tracking-wide text-emerald-300/80 bg-emerald-500/10 border border-emerald-400/30 px-1.5 py-0.5 rounded flex items-center gap-1">
                                                            <Check className="w-3 h-3" />
                                                            Added
                                                        </span>
                                                    )}
                                                </div>
                                                {entry.blurb && (
                                                    <div className="text-[11px] text-white/40 mt-0.5">{entry.blurb}</div>
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); void handleAddToBlacklist(entry.name); }}
                                                disabled={submitting || blacklistBusy}
                                                title="Never recommend this company"
                                                aria-label={`Blacklist ${entry.name}`}
                                                className="shrink-0 p-1.5 rounded text-rose-300/40 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                                            >
                                                <Ban className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    );
                                })
                            )}
                        </div>

                        {companyPageCount > 1 && (
                            <div className="flex items-center justify-between pt-1">
                                <button
                                    type="button"
                                    onClick={() => setCompanyPage(p => Math.max(0, p - 1))}
                                    disabled={submitting || safeCompanyPage === 0}
                                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/60 hover:text-white/90 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    <ChevronLeft className="w-3.5 h-3.5" />
                                    Prev
                                </button>
                                <span className="text-[11px] text-white/40 tabular-nums">
                                    {companyPageStart + 1}–{Math.min(companyPageStart + COMPANY_PAGE_SIZE, directoryResults.length)} of {directoryResults.length} · page {safeCompanyPage + 1}/{companyPageCount}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setCompanyPage(p => Math.min(companyPageCount - 1, p + 1))}
                                    disabled={submitting || safeCompanyPage >= companyPageCount - 1}
                                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/60 hover:text-white/90 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    Next
                                    <ChevronRight className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        )}

                        {/* Auto-discover fallback: directory is sparse (< 3 matches)
                            for the current tag/query, so pull Gemini suggestions for
                            the same topic and let the user add them right here. */}
                        {shouldAutoDiscover && (
                            <div className="mt-2 pt-2 border-t border-white/5 space-y-2">
                                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-cyan-300/80">
                                    <Telescope className="w-3 h-3" />
                                    <span>
                                        {directoryResults.length === 0
                                            ? `No directory match for "${autoDiscoverTopic}" — Gemini suggestions:`
                                            : `Only ${directoryResults.length} known — more via Gemini:`}
                                    </span>
                                    {discoverLoading && <Loader2 className="w-3 h-3 animate-spin text-white/40 ml-1" />}
                                </div>
                                {discoverError && (
                                    <p className="text-[10px] text-red-300/80">{discoverError}</p>
                                )}
                                {visibleDiscoverVerified.length > 0 && (
                                    <div className="flex flex-col gap-1.5">
                                        {visibleDiscoverVerified.map(v => {
                                            const selected = discoverSelected.has(v.name);
                                            const rowDisabled = submitting;
                                            const onActivate = () => { if (!rowDisabled) toggleDiscoverSelected(v.name); };
                                            return (
                                                <div
                                                    key={`${v.name}|${v.kind}|${v.slug}`}
                                                    role="button"
                                                    tabIndex={rowDisabled ? -1 : 0}
                                                    onClick={onActivate}
                                                    onKeyDown={(e) => {
                                                        if (rowDisabled) return;
                                                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
                                                    }}
                                                    aria-disabled={rowDisabled}
                                                    aria-pressed={selected}
                                                    className={[
                                                        "flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors cursor-pointer",
                                                        selected
                                                            ? "bg-cyan-500/15 border-cyan-400/50"
                                                            : "bg-black/30 border-white/10 hover:border-white/30",
                                                    ].join(" ")}
                                                >
                                                    <span
                                                        aria-hidden
                                                        className={[
                                                            "shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors",
                                                            selected ? "bg-cyan-500/40 border-cyan-300" : "bg-black/40 border-white/20",
                                                        ].join(" ")}
                                                    >
                                                        {selected && <Check className="w-3 h-3 text-cyan-50" />}
                                                    </span>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="text-sm font-semibold text-white truncate">{v.name}</span>
                                                            <span className="text-[10px] uppercase tracking-wide text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">{v.kind}</span>
                                                            <span className="text-[10px] text-white/40 tabular-nums">{v.jobCount} jobs</span>
                                                        </div>
                                                        {v.blurb && <div className="text-[11px] text-white/40 mt-0.5">{v.blurb}</div>}
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => { e.stopPropagation(); void handleAddToBlacklist(v.name); }}
                                                        disabled={submitting || blacklistBusy}
                                                        title="Never recommend this company"
                                                        aria-label={`Blacklist ${v.name}`}
                                                        className="shrink-0 p-1.5 rounded text-rose-300/40 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    >
                                                        <Ban className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {visibleDiscoverUnverified.length > 0 && (
                                    <details className="text-[10px] text-white/40">
                                        <summary className="cursor-pointer hover:text-white/60 select-none">
                                            + {visibleDiscoverUnverified.length} that need custom integration (Workday tenants, self-hosted, …)
                                        </summary>
                                        <ul className="mt-1 pl-3 space-y-0.5">
                                            {visibleDiscoverUnverified.map(u => (
                                                <li key={`${u.name}|${u.atsGuess}|${u.careersUrl}`}>• {u.name} <span className="text-white/30">({u.atsGuess})</span></li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                                {!discoverLoading && visibleDiscoverVerified.length === 0 && visibleDiscoverUnverified.length === 0 && !discoverError && (
                                    <p className="text-[10px] text-white/40 italic">No Gemini suggestions for &quot;{autoDiscoverTopic}&quot;.</p>
                                )}
                            </div>
                        )}

                        <ScheduleField value={scheduleHours} onChange={setScheduleHours} disabled={submitting} />

                        <div className="flex items-center justify-end gap-2 pt-2">
                            {(selectedDirKeys.size + discoverSelected.size) > 0 && (
                                <button
                                    type="button"
                                    onClick={() => { setSelectedDirKeys(new Set()); setDiscoverSelected(new Set()); }}
                                    disabled={submitting}
                                    className="px-3 py-2 text-xs text-white/50 hover:text-white/80 disabled:opacity-40"
                                >
                                    Clear ({selectedDirKeys.size + discoverSelected.size})
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleClose}
                                disabled={submitting}
                                className="px-4 py-2 text-xs text-white/60 hover:text-white/90 disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={submitting || (selectedDirKeys.size + discoverSelected.size) === 0}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                {(() => {
                                    if (submitting) return "Adding…";
                                    const total = selectedDirKeys.size + discoverSelected.size;
                                    if (total === 0) return "Pick a company";
                                    if (total === 1) {
                                        const name = selectedDirKeys.size === 1
                                            ? Array.from(selectedDirKeys)[0]
                                            : Array.from(discoverSelected)[0];
                                        return `Watch ${name}`;
                                    }
                                    return `Watch ${total} companies`;
                                })()}
                            </button>
                        </div>
                    </form>
                )}

                {mode === "discover" && (
                    <form onSubmit={submitDiscover} className="p-4 flex flex-col gap-3">
                        <p className="text-[11px] text-white/50">
                            Type a topic — we&apos;ll ask Gemini for companies in that space and live-probe each against Greenhouse / Lever / Ashby. Excludes anything already in your directory + watchlists; click Refresh to keep digging.
                        </p>

                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                placeholder="e.g. space, climate tech, defense, biotech, fintech"
                                value={discoverTopic}
                                onChange={(e) => setDiscoverTopicFresh(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runDiscover(); } }}
                                disabled={submitting || discoverLoading}
                                autoFocus
                                className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                            />
                            <button
                                type="button"
                                onClick={() => runDiscover()}
                                disabled={submitting || discoverLoading || !discoverTopic.trim()}
                                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {discoverLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (visibleDiscoverVerified.length + visibleDiscoverUnverified.length > 0 ? <RefreshCw className="w-3.5 h-3.5" /> : <Search className="w-3.5 h-3.5" />)}
                                {discoverLoading ? "Searching…" : visibleDiscoverVerified.length + visibleDiscoverUnverified.length > 0 ? "More" : "Search"}
                            </button>
                        </div>

                        {discoverError && (
                            <p className="text-[11px] text-red-300/80 px-1">{discoverError}</p>
                        )}

                        {visibleDiscoverVerified.length > 0 && (
                            <>
                                <div className="text-[10px] uppercase tracking-wide text-emerald-300/80 mt-1 flex items-center gap-1.5">
                                    <Check className="w-3 h-3" />
                                    Add to watchlist ({visibleDiscoverVerified.length})
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    {visibleDiscoverVerified.map(v => {
                                        const selected = discoverSelected.has(v.name);
                                        return (
                                            <button
                                                key={v.name}
                                                type="button"
                                                onClick={() => toggleDiscoverSelected(v.name)}
                                                disabled={submitting}
                                                aria-pressed={selected}
                                                className={[
                                                    "flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors",
                                                    selected
                                                        ? "bg-cyan-500/15 border-cyan-400/50"
                                                        : "bg-black/30 border-white/10 hover:border-white/30",
                                                ].join(" ")}
                                            >
                                                <span
                                                    aria-hidden
                                                    className={[
                                                        "shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors",
                                                        selected ? "bg-cyan-500/40 border-cyan-300" : "bg-black/40 border-white/20",
                                                    ].join(" ")}
                                                >
                                                    {selected && <Check className="w-3 h-3 text-cyan-50" />}
                                                </span>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-sm font-semibold text-white truncate">{v.name}</span>
                                                        <span className="text-[10px] uppercase tracking-wide text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">{v.kind}</span>
                                                        <span className="text-[10px] text-white/40 tabular-nums">{v.jobCount} jobs</span>
                                                    </div>
                                                    {v.blurb && <div className="text-[11px] text-white/40 mt-0.5">{v.blurb}</div>}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        )}

                        {visibleDiscoverUnverified.length > 0 && (
                            <>
                                <div className="text-[10px] uppercase tracking-wide text-amber-300/80 mt-2 flex items-center gap-1.5">
                                    <AlertTriangle className="w-3 h-3" />
                                    Needs custom integration ({visibleDiscoverUnverified.length})
                                </div>
                                <p className="text-[10px] text-white/40 -mt-1 leading-tight">
                                    Workday tenants, self-hosted careers pages, or unknown ATSes. Copy the name + URL and bring them to a future Claude session to wire up support.
                                </p>
                                <div className="flex flex-col gap-1.5">
                                    {visibleDiscoverUnverified.map(u => (
                                        <div
                                            key={`${u.name}|${u.atsGuess}|${u.careersUrl}`}
                                            className="flex items-start gap-3 px-3 py-2 rounded-lg border bg-black/30 border-white/10"
                                        >
                                            <AlertTriangle className="w-3.5 h-3.5 text-amber-300/70 mt-0.5 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-sm font-semibold text-white truncate">{u.name}</span>
                                                    <span className="text-[10px] uppercase tracking-wide text-amber-300/70 bg-amber-500/10 px-1.5 py-0.5 rounded">{u.atsGuess}</span>
                                                </div>
                                                {u.blurb && <div className="text-[11px] text-white/40 mt-0.5">{u.blurb}</div>}
                                                {u.careersUrl && (
                                                    <a
                                                        href={u.careersUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-[11px] text-cyan-300/70 hover:text-cyan-200 underline break-all"
                                                    >
                                                        {u.careersUrl}
                                                    </a>
                                                )}
                                                <div className="text-[10px] text-white/40 mt-0.5">{u.reason}</div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => copyToClipboard(`${u.name}${u.careersUrl ? ` — ${u.careersUrl}` : ""}`, u.name)}
                                                title="Copy name + URL to clipboard"
                                                className="shrink-0 p-1.5 rounded text-white/50 hover:text-white/90 hover:bg-white/5"
                                            >
                                                <Copy className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {(visibleDiscoverVerified.length > 0 || visibleDiscoverUnverified.length > 0) && (
                            <ScheduleField value={scheduleHours} onChange={setScheduleHours} disabled={submitting} />
                        )}

                        <div className="flex items-center justify-end gap-2 pt-2">
                            {discoverSelected.size > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setDiscoverSelected(new Set())}
                                    disabled={submitting}
                                    className="px-3 py-2 text-xs text-white/50 hover:text-white/80 disabled:opacity-40"
                                >
                                    Clear ({discoverSelected.size})
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleClose}
                                disabled={submitting}
                                className="px-4 py-2 text-xs text-white/60 hover:text-white/90 disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={submitting || discoverSelected.size === 0}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                {submitting
                                    ? "Adding…"
                                    : discoverSelected.size === 0
                                        ? "Pick a verified company"
                                        : discoverSelected.size === 1
                                            ? `Watch ${Array.from(discoverSelected)[0]}`
                                            : `Watch ${discoverSelected.size} companies`}
                            </button>
                        </div>
                    </form>
                )}

                {mode === "advanced" && (
                    <form onSubmit={submitAdvanced} className="p-4 flex flex-col gap-3">
                        <p className="text-[11px] text-white/50">
                            Hand-config a custom source. Use this for companies not in the directory.
                        </p>

                        <label className="text-[11px] uppercase tracking-wide text-white/40">Source</label>
                        <div className="flex rounded-lg overflow-hidden border border-white/10 bg-black/40 flex-wrap" role="group">
                            {(["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "workable", "recruitee", "personio", "clearcompany", "linkedin", "indeed", "careers-page"] as const).map(k => (
                                <button
                                    key={k}
                                    type="button"
                                    onClick={() => setAdvKind(k)}
                                    disabled={submitting}
                                    aria-pressed={advKind === k}
                                    className={[
                                        "px-3 py-1.5 text-[11px] font-semibold transition-colors",
                                        advKind === k ? "bg-cyan-500/30 text-cyan-100" : "text-white/50 hover:text-white/80",
                                    ].join(" ")}
                                >
                                    {k}
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-white/40 -mt-2">{ADVANCED_KIND_HELP[advKind]}</p>

                        <label className="text-[11px] uppercase tracking-wide text-white/40">Name</label>
                        <input
                            type="text"
                            placeholder="e.g. Anthropic — Engineering roles"
                            value={advName}
                            onChange={(e) => setAdvName(e.target.value)}
                            disabled={submitting}
                            className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                        />

                        <label className="text-[11px] uppercase tracking-wide text-white/40">Company name</label>
                        <input
                            type="text"
                            placeholder="Anthropic"
                            value={advCompanyName}
                            onChange={(e) => setAdvCompanyName(e.target.value)}
                            disabled={submitting}
                            className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                        />

                        {advKind === "careers-page" && (
                            <>
                                <label className="text-[11px] uppercase tracking-wide text-white/40">Careers page URL</label>
                                <input
                                    type="url"
                                    placeholder="https://example.com/careers"
                                    value={advRootUrl}
                                    onChange={(e) => setAdvRootUrl(e.target.value)}
                                    disabled={submitting}
                                    className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                                />
                                <label className="text-[11px] uppercase tracking-wide text-white/40">Link pattern (regex)</label>
                                <input
                                    type="text"
                                    placeholder="/careers/(positions|jobs)/"
                                    value={advLinkPattern}
                                    onChange={(e) => setAdvLinkPattern(e.target.value)}
                                    disabled={submitting}
                                    className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40 font-mono"
                                />
                            </>
                        )}
                        {isSlugKind(advKind) && (
                            <>
                                <label className="text-[11px] uppercase tracking-wide text-white/40">{advKind} board slug</label>
                                <input
                                    type="text"
                                    placeholder={ADVANCED_SLUG_PLACEHOLDER[advKind]}
                                    value={advBoardSlug}
                                    onChange={(e) => setAdvBoardSlug(e.target.value)}
                                    disabled={submitting}
                                    className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                                />
                            </>
                        )}
                        {advKind === "workday" && (
                            <>
                                <label className="text-[11px] uppercase tracking-wide text-white/40">Tenant host</label>
                                <input
                                    type="text"
                                    placeholder="boeing.wd1.myworkdayjobs.com"
                                    value={advTenantHost}
                                    onChange={(e) => setAdvTenantHost(e.target.value)}
                                    disabled={submitting}
                                    className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40 font-mono"
                                />
                                <label className="text-[11px] uppercase tracking-wide text-white/40">Career site</label>
                                <input
                                    type="text"
                                    placeholder="EXTERNAL_CAREERS"
                                    value={advCareerSite}
                                    onChange={(e) => setAdvCareerSite(e.target.value)}
                                    disabled={submitting}
                                    className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40 font-mono"
                                />
                            </>
                        )}
                        {(advKind === "linkedin" || advKind === "indeed") && (
                            <>
                                <label className="text-[11px] uppercase tracking-wide text-white/40">Keywords</label>
                                <input
                                    type="text"
                                    placeholder="software engineer, mechanical engineer, propulsion"
                                    value={advKeywords}
                                    onChange={(e) => setAdvKeywords(e.target.value)}
                                    disabled={submitting}
                                    className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                                />
                                <label className="text-[11px] uppercase tracking-wide text-white/40">Location (optional)</label>
                                <input
                                    type="text"
                                    placeholder="Remote, United States, …"
                                    value={advLocation}
                                    onChange={(e) => setAdvLocation(e.target.value)}
                                    disabled={submitting}
                                    className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                                />
                            </>
                        )}

                        <ScheduleField value={scheduleHours} onChange={setScheduleHours} disabled={submitting} />

                        {/* Blacklist editor — companies here are filtered out of EVERY
                            recommendation surface (directory results, Discover Gemini
                            suggestions, auto-discover panel) and added to the Gemini
                            exclude list server-side so they can never be re-suggested. */}
                        <div className="mt-2 pt-3 border-t border-white/10 flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-rose-300/80">
                                <Ban className="w-3 h-3" />
                                <span>Blacklist ({blacklistEntries.length})</span>
                            </div>
                            <p className="text-[10px] text-white/40 -mt-1 leading-tight">
                                Companies the system should never recommend, no matter who suggests them. Names are matched by normalized form, so &quot;Acme&quot; and &quot;Acme, Inc.&quot; collapse to one entry.
                            </p>
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    placeholder="Company to blacklist…"
                                    value={blacklistAddName}
                                    onChange={(e) => setBlacklistAddName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            void handleAddToBlacklist(blacklistAddName);
                                        }
                                    }}
                                    disabled={submitting || blacklistBusy}
                                    className="flex-1 px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-rose-400/40"
                                />
                                <button
                                    type="button"
                                    onClick={() => void handleAddToBlacklist(blacklistAddName)}
                                    disabled={submitting || blacklistBusy || !blacklistAddName.trim()}
                                    title="Add to blacklist"
                                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/30 text-xs font-semibold text-rose-100 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {blacklistBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                                    Block
                                </button>
                            </div>
                            {blacklistEntries.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    {blacklistEntries.map(b => (
                                        <span
                                            key={b.id}
                                            title={b.reason ?? `Blacklisted ${new Date(b.createdAt).toLocaleDateString()}`}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-rose-500/10 border border-rose-400/30 text-rose-100"
                                        >
                                            {b.name}
                                            <button
                                                type="button"
                                                onClick={() => void handleRemoveFromBlacklist(b.id)}
                                                disabled={submitting || blacklistBusy}
                                                title="Remove from blacklist"
                                                className="ml-0.5 text-rose-200/70 hover:text-white disabled:opacity-40"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                disabled={submitting}
                                className="px-4 py-2 text-xs text-white/60 hover:text-white/90 disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={submitting || !advName.trim() || !advCompanyName.trim()}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                {submitting ? "Creating…" : "Create"}
                            </button>
                        </div>
                    </form>
                )}
                </div>
            </div>
        </div>,
        document.body,
    );
};

const MIN_HOURS = 1;
const MAX_HOURS = 24;

function ScheduleField({
    value,
    onChange,
    disabled,
}: {
    value: number;
    onChange: (n: number) => void;
    disabled: boolean;
}) {
    const clamp = (n: number) => Math.max(MIN_HOURS, Math.min(MAX_HOURS, Math.round(n)));
    return (
        <div className="flex items-center gap-3 pt-1">
            <label className="text-[11px] uppercase tracking-wide text-white/40">Crawl every</label>
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/40">
                <button
                    type="button"
                    onClick={() => onChange(clamp(value - 1))}
                    disabled={disabled || value <= MIN_HOURS}
                    className="p-1.5 text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed rounded-l-lg"
                    aria-label="Decrease cadence"
                >
                    <Minus className="w-3.5 h-3.5" />
                </button>
                <div className="px-3 py-1 text-sm text-white tabular-nums min-w-[3.5rem] text-center">
                    {value}<span className="text-[11px] text-white/40 ml-0.5">h</span>
                </div>
                <button
                    type="button"
                    onClick={() => onChange(clamp(value + 1))}
                    disabled={disabled || value >= MAX_HOURS}
                    className="p-1.5 text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed rounded-r-lg"
                    aria-label="Increase cadence"
                >
                    <Plus className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}
