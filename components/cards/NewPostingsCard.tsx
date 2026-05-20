"use client";
import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ChevronDown, ExternalLink, EyeOff, Loader2, MapPin, Newspaper, BriefcaseBusiness, Filter, X } from "lucide-react";
import { api, queryKeys, type PostingsListFilter } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";
import { useAppStore, type PostingEmploymentType } from "@/components/providers/state";
import { Card } from "../ui/Card";

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

const LIMIT = 200; // server caps at MAX_LIMIT=200 (app/api/postings/route.ts)
const PAGE_SIZE = 10;

const EMPLOYMENT_TYPE_CHIPS: ReadonlyArray<{ id: PostingEmploymentType; label: string }> = [
    { id: "full-time",   label: "Full-time" },
    { id: "internship",  label: "Internship" },
    { id: "contract",    label: "Contract" },
    { id: "part-time",   label: "Part-time" },
    { id: "temporary",   label: "Temporary" },
] as const;

export function NewPostingsCard() {
    const queryClient = useQueryClient();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [page, setPage] = useState(0);
    // The "Other matches" section (postings from LinkedIn keyword searches
    // whose employer isn't on the user's watchlist) defaults collapsed —
    // it's a long-tail discovery surface, not the main feed.
    const [offListOpen, setOffListOpen] = useState(false);
    const postingFilters = useAppStore(s => s.postingFilters);
    const setPostingFilters = useAppStore(s => s.setPostingFilters);

    // Build the server-side filter payload from the user's chip selections.
    // The query key includes this shape so React Query partitions the cache
    // per filter combination + refetches automatically on toggle.
    const listFilter: PostingsListFilter = useMemo(() => ({
        status: "new",
        limit: LIMIT,
        employmentType: postingFilters.employmentTypes,
        includeUnspecified: postingFilters.includeUnspecified,
        companies: postingFilters.companies,
        remoteOnly: postingFilters.remoteOnly,
        locations: postingFilters.locations,
    }), [postingFilters]);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.postings(listFilter),
        queryFn: () => api.postings.list(listFilter),
    });

    // Watchlists power the company-chip list — directory-bound, the user has
    // explicitly opted into watching these companies. LinkedIn watchlists are
    // generic keyword searches (often spanning many employers, e.g. "Intern")
    // so they're excluded; their resulting postings used to contribute extra
    // employer chips here, but with server-side filtering the postings array
    // reflects the current filter set, so deriving chips from it would shrink
    // the chip list as soon as you filtered. Trade-off accepted: LinkedIn
    // users filter by location / type, not employer.
    const { data: watchlistsData } = useQuery({
        queryKey: queryKeys.watchlists,
        queryFn: () => api.watchlists.list(),
    });

    useServerEvents("Posting", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
    });

    // Memoize so the partition useMemo below doesn't recompute on every
    // render — `data?.postings ?? []` returns a fresh `[]` ref each time
    // when data is undefined.
    const postings = useMemo(() => data?.postings ?? [], [data?.postings]);

    const companyOptions = useMemo(() => {
        const byKey = new Map<string, string>(); // lowercased → display
        for (const w of watchlistsData?.watchlists ?? []) {
            if (w.kind === "linkedin") continue;
            const clean = (w.config.companyName ?? "").trim();
            if (!clean) continue;
            const key = clean.toLowerCase();
            if (!byKey.has(key)) byKey.set(key, clean);
        }
        return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
    }, [watchlistsData]);

    // Auto-prune stale company selections (e.g. a watchlist was deleted while
    // its name was selected, or the suffix-cleanup migration retitled rows).
    // Render-time adjustment to match the page-reset pattern below. Only
    // fires when there's drift, and only once watchlists have loaded — an
    // empty companyOptions during initial load would wipe valid selections.
    if (postingFilters.companies.length > 0 && companyOptions.length > 0) {
        const validLower = new Set(companyOptions.map(c => c.toLowerCase()));
        const pruned = postingFilters.companies.filter(c => validLower.has(c.toLowerCase()));
        if (pruned.length !== postingFilters.companies.length) {
            setPostingFilters({ ...postingFilters, companies: pruned });
        }
    }

    const activeFilterCount =
        (postingFilters.employmentTypes.length > 0 ? 1 : 0) +
        (postingFilters.remoteOnly ? 1 : 0) +
        (postingFilters.locations.length > 0 ? 1 : 0) +
        (postingFilters.companies.length > 0 ? 1 : 0);

    // Partition into on-watchlist (matches a non-LinkedIn watchlist's
    // companyName) vs off-watchlist (everything else — typically employers
    // that surfaced from a LinkedIn keyword watchlist like "Intern" or
    // "software engineer"). Guarded by watchlists-loaded so we don't briefly
    // dump everything into "Other matches" on initial render before the
    // watchlists query resolves.
    const watchlistsLoaded = watchlistsData !== undefined;
    const watchlistCompaniesLower = useMemo(
        () => new Set(companyOptions.map(c => c.toLowerCase())),
        [companyOptions],
    );
    const { onList, offList } = useMemo(() => {
        if (!watchlistsLoaded) return { onList: postings, offList: [] as typeof postings };
        const on: typeof postings = [];
        const off: typeof postings = [];
        for (const p of postings) {
            if (watchlistCompaniesLower.has(p.company.toLowerCase())) on.push(p);
            else off.push(p);
        }
        return { onList: on, offList: off };
    }, [postings, watchlistCompaniesLower, watchlistsLoaded]);

    // Bounce back to page 1 when filters change — toggling a chip on page 3 of
    // unfiltered results shouldn't land on an empty page 3 of the filtered slice.
    // Render-time adjustment (vs useEffect) matches the FiltersEditor pattern in
    // WatchlistsCard.tsx; postingFilters is a stable zustand ref so the compare
    // only flips when the filter actually changes.
    const [lastFilters, setLastFilters] = useState(postingFilters);
    if (lastFilters !== postingFilters) {
        setLastFilters(postingFilters);
        setPage(0);
    }

    // Pagination operates on the main (on-watchlist) list. Off-watchlist
    // matches surface separately below and aren't paginated — they're
    // typically a long tail of <20 items.
    const pageCount = Math.max(1, Math.ceil(onList.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageStart = safePage * PAGE_SIZE;
    const pagePostings = onList.slice(pageStart, pageStart + PAGE_SIZE);

    function toggleType(t: PostingEmploymentType) {
        const next = postingFilters.employmentTypes.includes(t)
            ? postingFilters.employmentTypes.filter(x => x !== t)
            : [...postingFilters.employmentTypes, t];
        setPostingFilters({ ...postingFilters, employmentTypes: next });
    }
    function toggleCompany(c: string) {
        const next = postingFilters.companies.includes(c)
            ? postingFilters.companies.filter(x => x !== c)
            : [...postingFilters.companies, c];
        setPostingFilters({ ...postingFilters, companies: next });
    }
    function resetFilters() {
        setPostingFilters({ employmentTypes: [], remoteOnly: false, locations: [], includeUnspecified: false, companies: [] });
    }

    async function trackAsApplication(id: string, title: string) {
        setBusyId(id);
        try {
            const result = await api.postings.trackAsApplication(id);
            const msg = result.created
                ? `Tracked "${title}" as a new application`
                : `Already tracked — opened existing application`;
            toastStore.push({ message: msg, type: "info" });
            queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
            queryClient.invalidateQueries({ queryKey: queryKeys.applications });
        } catch (e) {
            toastStore.push({ message: `Track failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    async function hide(id: string) {
        setBusyId(id);
        try {
            await api.postings.update(id, { status: "hidden" });
            queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
        } catch (e) {
            toastStore.push({ message: `Hide failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    return (
        <Card
            title="New postings"
            icon={Newspaper}
            iconColorClass="text-cyan-300"
            action={
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setFiltersOpen(o => !o)}
                        title={filtersOpen ? "Hide filters" : "Show filters"}
                        className={[
                            "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors",
                            activeFilterCount > 0 || filtersOpen
                                ? "bg-cyan-500/20 text-cyan-100 border-cyan-400/40"
                                : "bg-black/30 text-white/50 border-white/10 hover:text-white/80",
                        ].join(" ")}
                    >
                        <Filter className="w-3 h-3" />
                        Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                    </button>
                    <span className="text-[11px] text-white/40 tabular-nums">
                        {onList.length}{postings.length === LIMIT ? "+" : ""} {activeFilterCount > 0 ? "matching" : "new"}
                        {offList.length > 0 && (
                            <span className="ml-1 text-white/30">· {offList.length} other</span>
                        )}
                    </span>
                </div>
            }
        >
            {filtersOpen && (
                <div className="mb-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2 flex flex-col gap-2 shrink-0">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-white/40">Employment type</span>
                        {activeFilterCount > 0 && (
                            <button
                                onClick={resetFilters}
                                className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80"
                            >
                                <X className="w-3 h-3" />
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {EMPLOYMENT_TYPE_CHIPS.map(({ id, label }) => {
                            const active = postingFilters.employmentTypes.includes(id);
                            return (
                                <button
                                    key={id}
                                    onClick={() => toggleType(id)}
                                    className={[
                                        "px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide font-semibold transition-colors",
                                        active
                                            ? "bg-cyan-500/30 text-cyan-100 border border-cyan-400/40"
                                            : "bg-black/40 text-white/40 border border-white/10 hover:text-white/70",
                                    ].join(" ")}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                    {companyOptions.length > 0 && (
                        <>
                            <div className="flex items-center justify-between pt-1">
                                <span className="text-[10px] uppercase tracking-wide text-white/40">Company</span>
                                {postingFilters.companies.length > 0 && (
                                    <button
                                        onClick={() => setPostingFilters({ ...postingFilters, companies: [] })}
                                        className="text-[10px] text-white/40 hover:text-white/80"
                                    >
                                        All
                                    </button>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {companyOptions.map(c => {
                                    const active = postingFilters.companies.includes(c);
                                    return (
                                        <button
                                            key={c}
                                            onClick={() => toggleCompany(c)}
                                            className={[
                                                "px-2 py-0.5 rounded-full text-[10px] font-semibold transition-colors",
                                                active
                                                    ? "bg-cyan-500/30 text-cyan-100 border border-cyan-400/40"
                                                    : "bg-black/40 text-white/40 border border-white/10 hover:text-white/70",
                                            ].join(" ")}
                                        >
                                            {c}
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                    <div className="flex items-center gap-3 flex-wrap pt-1">
                        <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={postingFilters.remoteOnly}
                                onChange={(e) => setPostingFilters({ ...postingFilters, remoteOnly: e.target.checked })}
                                className="accent-cyan-400"
                            />
                            Remote only
                        </label>
                        {postingFilters.employmentTypes.length > 0 && (
                            <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer" title="Postings where we couldn't classify the type are excluded.">
                                <input
                                    type="checkbox"
                                    checked={postingFilters.includeUnspecified}
                                    onChange={(e) => setPostingFilters({ ...postingFilters, includeUnspecified: e.target.checked })}
                                    className="accent-cyan-400"
                                />
                                Include unclassified
                            </label>
                        )}
                    </div>
                    <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] uppercase tracking-wide text-white/40">Location</span>
                        {postingFilters.locations.length > 0 && (
                            <button
                                onClick={() => setPostingFilters({ ...postingFilters, locations: [] })}
                                className="text-[10px] text-white/40 hover:text-white/80"
                            >
                                All
                            </button>
                        )}
                    </div>
                    <LocationChipEditor
                        values={postingFilters.locations}
                        onChange={(next) => setPostingFilters({ ...postingFilters, locations: next })}
                    />
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-6 text-white/40">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </div>
            ) : onList.length === 0 && offList.length === 0 ? (
                activeFilterCount > 0 ? (
                    <p className="text-xs text-white/40 italic">
                        No new postings match your filters.{" "}
                        <button onClick={resetFilters} className="underline text-cyan-300/80 hover:text-cyan-200">Clear filters</button>
                    </p>
                ) : (
                    <p className="text-xs text-white/40 italic">No new postings. Run a watchlist or wait for the scheduler tick.</p>
                )
            ) : onList.length === 0 ? (
                // All matches are off-watchlist — show a hint instead of an
                // empty main list so the user understands the "Other matches"
                // section below is where the action is.
                <p className="text-xs text-white/40 italic">
                    No matches from your watchlisted companies. See &quot;Other matches&quot; below.
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {pagePostings.map(p => (
                        <PostingRow
                            key={p.id}
                            p={p}
                            busy={busyId === p.id}
                            onTrack={trackAsApplication}
                            onHide={hide}
                        />
                    ))}
                </ul>
            )}

            {!isLoading && pageCount > 1 && onList.length > 0 && (
                <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between shrink-0">
                    <button
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={safePage === 0}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/60 hover:text-white/90 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        <ChevronLeft className="w-3.5 h-3.5" />
                        Prev
                    </button>
                    <span className="text-[11px] text-white/40 tabular-nums">
                        {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, onList.length)} of {onList.length} · page {safePage + 1}/{pageCount}
                    </span>
                    <button
                        onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                        disabled={safePage >= pageCount - 1}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/60 hover:text-white/90 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        Next
                        <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {!isLoading && offList.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/5">
                    <button
                        onClick={() => setOffListOpen(o => !o)}
                        aria-pressed={offListOpen}
                        className="flex items-center gap-1.5 text-[11px] text-white/60 hover:text-white/90"
                    >
                        {offListOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        <span className="font-semibold">Other matches</span>
                        <span className="text-white/40 tabular-nums">({offList.length})</span>
                    </button>
                    <p className="text-[10px] text-white/30 mt-1 leading-tight">
                        Companies not on your watchlist — surfaced by LinkedIn keyword searches.
                        Track interesting ones as applications or add them via &quot;Add watchlist&quot;.
                    </p>
                    {offListOpen && (
                        <ul className="space-y-1.5 mt-2">
                            {offList.map(p => (
                                <PostingRow
                                    key={p.id}
                                    p={p}
                                    busy={busyId === p.id}
                                    onTrack={trackAsApplication}
                                    onHide={hide}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </Card>
    );
}

type Posting = NonNullable<Awaited<ReturnType<typeof api.postings.list>>["postings"]>[number];

function PostingRow({
    p,
    busy,
    onTrack,
    onHide,
}: {
    p: Posting;
    busy: boolean;
    onTrack: (id: string, title: string) => void;
    onHide: (id: string) => void;
}) {
    return (
        <li className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 hover:border-white/20 transition-colors">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-[11px] uppercase tracking-wide text-cyan-300/80">{p.company}</span>
                        <a
                            href={p.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-white/40 hover:text-white/80"
                            title="Open source"
                        >
                            <ExternalLink className="w-3 h-3" />
                        </a>
                    </div>
                    <div className="text-sm text-white/90 truncate mt-0.5">{p.title}</div>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                        {p.location && (
                            <div className="text-[11px] text-white/40 flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {p.location}
                            </div>
                        )}
                        {p.employmentType && (
                            <span className="text-[10px] uppercase tracking-wide text-white/50 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded">
                                {p.employmentType.replace("-", " ")}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={() => onTrack(p.id, p.title)}
                        disabled={busy}
                        title="Create an application from this posting"
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 disabled:opacity-40"
                    >
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <BriefcaseBusiness className="w-3 h-3" />}
                        Track as App
                    </button>
                    <button
                        onClick={() => onHide(p.id)}
                        disabled={busy}
                        title="Hide this posting"
                        className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 disabled:opacity-40"
                    >
                        <EyeOff className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </li>
    );
}

const MAX_LOCATION_CHIPS = 20;
const MAX_LOCATION_LEN = 80;

/**
 * Chip-based location filter — mirrors the GlobalNegativeFiltersEditor UX in
 * WatchlistsCard.tsx, but inclusive (cyan theme, OR semantics: a posting
 * shows if ANY chip is a substring of its location). Comma or Enter commits;
 * Backspace on empty input pops the last chip; blur commits any unsubmitted
 * text. No regex validation — these are literal substrings.
 */
function LocationChipEditor({
    values,
    onChange,
}: {
    values: readonly string[];
    onChange: (next: string[]) => void;
}) {
    const [input, setInput] = useState("");

    function commit() {
        const trimmed = input.trim();
        if (!trimmed) return;
        const parts = trimmed.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 0) {
            setInput("");
            return;
        }
        const existingLower = new Set(values.map(v => v.toLowerCase()));
        const additions: string[] = [];
        for (const p of parts) {
            if (p.length > MAX_LOCATION_LEN) continue;
            const lower = p.toLowerCase();
            if (existingLower.has(lower)) continue;
            existingLower.add(lower);
            additions.push(p);
        }
        setInput("");
        if (additions.length === 0) return;
        const next = [...values, ...additions].slice(0, MAX_LOCATION_CHIPS);
        onChange(next);
    }

    function remove(chip: string) {
        onChange(values.filter(v => v !== chip));
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {values.map(v => (
                <span
                    key={v}
                    className="group inline-flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-cyan-500/20 text-cyan-100 border border-cyan-400/40"
                >
                    <span>{v}</span>
                    <button
                        onClick={() => remove(v)}
                        title={`Remove "${v}"`}
                        aria-label={`Remove ${v}`}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-cyan-100/70 hover:text-cyan-50 transition-opacity"
                    >
                        <X className="w-2.5 h-2.5" />
                    </button>
                </span>
            ))}
            <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                    if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        commit();
                    } else if (e.key === "Backspace" && input === "" && values.length > 0) {
                        e.preventDefault();
                        remove(values[values.length - 1]);
                    }
                }}
                onBlur={commit}
                placeholder={values.length === 0 ? "e.g. New York, Remote, United Kingdom" : "add another…"}
                disabled={values.length >= MAX_LOCATION_CHIPS}
                className="flex-1 min-w-[8rem] px-2 py-1 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40 disabled:opacity-50"
            />
        </div>
    );
}
