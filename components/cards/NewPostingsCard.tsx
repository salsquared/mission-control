"use client";
import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, EyeOff, Loader2, MapPin, Newspaper, BriefcaseBusiness, Filter, X } from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";
import { useAppStore, type PostingEmploymentType } from "@/components/providers/state";
import { Card } from "../ui/Card";

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

const LIMIT = 50;

const EMPLOYMENT_TYPE_CHIPS: ReadonlyArray<{ id: PostingEmploymentType; label: string }> = [
    { id: "full-time",   label: "Full-time" },
    { id: "internship",  label: "Internship" },
    { id: "contract",    label: "Contract" },
    { id: "part-time",   label: "Part-time" },
    { id: "temporary",   label: "Temporary" },
] as const;

const REMOTE_REGEX = /\b(remote|anywhere|work\s*from\s*home|wfh)\b/i;

export function NewPostingsCard() {
    const queryClient = useQueryClient();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const postingFilters = useAppStore(s => s.postingFilters);
    const setPostingFilters = useAppStore(s => s.setPostingFilters);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.postings({ status: "new" }),
        queryFn: () => api.postings.list({ status: "new", limit: LIMIT }),
    });

    useServerEvents("Posting", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
    });

    const allPostings = data?.postings ?? [];

    // Client-side filter pass. Kept here (not server-side) because the page
    // already over-fetches up to LIMIT and the filter is interactive — round-
    // tripping for every chip toggle would feel laggy.
    const postings = useMemo(() => {
        const { employmentTypes, remoteOnly, locationContains, includeUnspecified } = postingFilters;
        const locNeedle = locationContains.trim().toLowerCase();
        const hasTypeFilter = employmentTypes.length > 0;
        return allPostings.filter(p => {
            if (hasTypeFilter) {
                if (p.employmentType === null) {
                    if (!includeUnspecified) return false;
                } else if (!employmentTypes.includes(p.employmentType as PostingEmploymentType)) {
                    return false;
                }
            }
            if (remoteOnly && !REMOTE_REGEX.test(p.location ?? "")) return false;
            if (locNeedle && !((p.location ?? "").toLowerCase().includes(locNeedle))) return false;
            return true;
        });
    }, [allPostings, postingFilters]);

    const activeFilterCount =
        (postingFilters.employmentTypes.length > 0 ? 1 : 0) +
        (postingFilters.remoteOnly ? 1 : 0) +
        (postingFilters.locationContains.trim().length > 0 ? 1 : 0);

    function toggleType(t: PostingEmploymentType) {
        const next = postingFilters.employmentTypes.includes(t)
            ? postingFilters.employmentTypes.filter(x => x !== t)
            : [...postingFilters.employmentTypes, t];
        setPostingFilters({ ...postingFilters, employmentTypes: next });
    }
    function resetFilters() {
        setPostingFilters({ employmentTypes: [], remoteOnly: false, locationContains: "", includeUnspecified: false });
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
                        {activeFilterCount > 0
                            ? `${postings.length} of ${allPostings.length}${allPostings.length === LIMIT ? "+" : ""}`
                            : `${postings.length}${allPostings.length === LIMIT ? "+" : ""} new`}
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
                        <input
                            type="text"
                            placeholder="Location contains…"
                            value={postingFilters.locationContains}
                            onChange={(e) => setPostingFilters({ ...postingFilters, locationContains: e.target.value })}
                            className="flex-1 min-w-[8rem] px-2 py-1 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                        />
                    </div>
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-6 text-white/40">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </div>
            ) : postings.length === 0 ? (
                activeFilterCount > 0 ? (
                    <p className="text-xs text-white/40 italic">
                        {allPostings.length} posting{allPostings.length === 1 ? "" : "s"} hidden by your filters.{" "}
                        <button onClick={resetFilters} className="underline text-cyan-300/80 hover:text-cyan-200">Clear filters</button>
                    </p>
                ) : (
                    <p className="text-xs text-white/40 italic">No new postings. Run a watchlist or wait for the scheduler tick.</p>
                )
            ) : (
                <ul className="flex-1 min-h-0 space-y-1.5 overflow-y-auto pr-1">
                    {postings.map(p => {
                        const busy = busyId === p.id;
                        return (
                            <li key={p.id} className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 hover:border-white/20 transition-colors">
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
                                            onClick={() => trackAsApplication(p.id, p.title)}
                                            disabled={busy}
                                            title="Create an application from this posting"
                                            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 disabled:opacity-40"
                                        >
                                            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <BriefcaseBusiness className="w-3 h-3" />}
                                            Track as App
                                        </button>
                                        <button
                                            onClick={() => hide(p.id)}
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
                    })}
                </ul>
            )}
        </Card>
    );
}
