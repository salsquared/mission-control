"use client";
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Loader2, Search, Building2, Settings2, Sparkles, Check, Minus, ArrowUpToLine } from "lucide-react";
import { api } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";
import {
    DIRECTORY_TAGS,
    searchDirectory,
    watchlistConfigKey,
    type CompanyDirectoryEntry,
    type DirectoryTag,
} from "@/lib/company-directory";
import type { WatchlistWire } from "@/lib/schemas/watchlists";

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
}

// Three top-level modes. Default lands on "find" because the most common
// workflow is "I want a kind of job, find me matches" — not "I know Anthropic
// uses Greenhouse with slug `anthropic`, plug it in."
type Mode = "find" | "company" | "advanced";

type AdvancedKind = "greenhouse" | "lever" | "ashby" | "workday" | "linkedin" | "careers-page";

const ADVANCED_KIND_HELP: Record<AdvancedKind, string> = {
    "greenhouse": "Slug from boards.greenhouse.io/<slug> — e.g. anthropic, stripe, rocketlab, vercel.",
    "lever": "Slug from jobs.lever.co/<slug> — e.g. spotify, leverdemo.",
    "ashby": "Slug from jobs.ashbyhq.com/<slug> — e.g. notion, posthog.",
    "workday": "Two fields. Tenant host: <tenant>.wd<N>.myworkdayjobs.com (e.g. boeing.wd1.myworkdayjobs.com). Career site: the segment after the host on the public careers page (e.g. EXTERNAL_CAREERS, BlueOrigin).",
    "linkedin": "Free-text keyword search (matches what you'd type in LinkedIn's job search bar). Fragile by design — LinkedIn DOM-shifts often, expect occasional breakage.",
    "careers-page": "Use only for old-school static-HTML careers pages. Most modern pages are SPAs and won't work here — try one of the aggregator kinds first.",
};

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export const AddWatchlistModal: React.FC<AddWatchlistModalProps> = ({ open, onClose, onCreated, existingWatchlists = [] }) => {
    // SSR gate: createPortal needs document.body, which only exists on the
    // client. Without this, the modal would crash during server render.
    const [mounted, setMounted] = useState(false);
    useEffect(() => { setMounted(true); }, []);

    const [mode, setMode] = useState<Mode>("find");
    const [submitting, setSubmitting] = useState(false);

    // ─── "find" mode (LinkedIn keyword search) ───────────────────────────────
    const [findKeywords, setFindKeywords] = useState("");
    const [findLocation, setFindLocation] = useState("");

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
        const base = searchDirectory(companyQuery, companyTagFilter.size > 0 ? companyTagFilter : null);
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
    }, [companyQuery, companyTagFilter, showAdded, existingKeys]);

    if (!open || !mounted) return null;

    function reset() {
        setMode("find");
        setFindKeywords("");
        setFindLocation("");
        setCompanyQuery("");
        setCompanyTagFilter(new Set());
        setSelectedDirKeys(new Set());
        setShowAdded(false);
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

    async function submitFind(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        const kw = findKeywords.trim();
        if (!kw) return;
        const loc = findLocation.trim();
        const name = loc ? `${kw} — ${loc}` : kw;
        setSubmitting(true);
        try {
            await api.watchlists.create({
                name,
                config: {
                    kind: "linkedin",
                    keywords: kw,
                    location: loc || undefined,
                    // companyName on a keyword search is semantically "the
                    // source," not a specific employer — LinkedIn fills the
                    // actual employer onto each posting.
                    companyName: "LinkedIn search",
                },
                scheduleMinutes: scheduleHours * 60,
            });
            toastStore.push({ message: `Watching for: ${name}`, type: "info" });
            onCreated();
            reset();
            onClose();
        } catch (err) {
            toastStore.push({ message: `Create failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setSubmitting(false);
        }
    }

    async function submitCompany(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        if (selectedDirKeys.size === 0) return;
        // Resolve every selected key against the current directory results.
        // (We carry only the name in selectedDirKeys; rehydrate to entries
        // here so the create payload has fresh config — protects against
        // selection going stale if the directory shifts mid-flow.)
        const allEntries = searchDirectory("", null);
        const byName = new Map(allEntries.map(e => [e.name, e] as const));
        const entries = Array.from(selectedDirKeys)
            .map(name => byName.get(name))
            .filter((e): e is CompanyDirectoryEntry => Boolean(e));
        if (entries.length === 0) return;
        setSubmitting(true);
        try {
            const results = await Promise.allSettled(entries.map(entry =>
                api.watchlists.create({
                    name: `${entry.name} — jobs`,
                    config: entry.config,
                    scheduleMinutes: scheduleHours * 60,
                    // PB-14: bind to the directory entry so future slug/ATS
                    // corrections in lib/company-directory.ts apply automatically.
                    directoryKey: entry.name,
                })
            ));
            const okCount = results.filter(r => r.status === "fulfilled").length;
            const failed = results
                .map((r, i) => r.status === "rejected" ? entries[i].name : null)
                .filter((n): n is string => Boolean(n));
            if (okCount > 0) {
                toastStore.push({
                    message: okCount === 1
                        ? `Watching ${entries.find((_, i) => results[i].status === "fulfilled")?.name}`
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
        if ((advKind === "greenhouse" || advKind === "lever" || advKind === "ashby") && !advBoardSlug.trim()) return;
        if (advKind === "careers-page" && (!advRootUrl.trim() || !advLinkPattern.trim())) return;
        if (advKind === "workday" && (!advTenantHost.trim() || !advCareerSite.trim())) return;
        if (advKind === "linkedin" && !advKeywords.trim()) return;

        setSubmitting(true);
        try {
            const config = (() => {
                if (advKind === "greenhouse") return { kind: "greenhouse" as const, boardSlug: advBoardSlug.trim(), companyName: advCompanyName.trim() };
                if (advKind === "lever") return { kind: "lever" as const, boardSlug: advBoardSlug.trim(), companyName: advCompanyName.trim() };
                if (advKind === "ashby") return { kind: "ashby" as const, boardSlug: advBoardSlug.trim(), companyName: advCompanyName.trim() };
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
                return { kind: "careers-page" as const, rootUrl: advRootUrl.trim(), linkPattern: advLinkPattern.trim(), companyName: advCompanyName.trim() };
            })();
            await api.watchlists.create({
                name: advName.trim(),
                config,
                scheduleMinutes: scheduleHours * 60,
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
                className="w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl flex flex-col max-h-[calc(100vh_-_2rem)]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
                    <h2 className="text-sm font-semibold text-white">Add to watchlist</h2>
                    <button onClick={handleClose} className="text-white/40 hover:text-white/80" aria-label="Close">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Mode tabs */}
                <div className="flex border-b border-white/10 shrink-0">
                    {[
                        { id: "find" as const, label: "Find roles", Icon: Sparkles, hint: "Search by what you want to do" },
                        { id: "company" as const, label: "Watch company", Icon: Building2, hint: "Pick a known company" },
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
                <div className="flex-1 min-h-0 overflow-y-auto">
                {mode === "find" && (
                    <form onSubmit={submitFind} className="p-4 flex flex-col gap-3">
                        <p className="text-[11px] text-white/50">
                            Describe the role you want. We&apos;ll scan LinkedIn for matches and surface them in your feed.
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
                            Heads-up: LinkedIn aggressively bot-detects, so expect occasional 0-result days when their markup shifts.
                            For a specific company, use the &quot;Watch company&quot; tab.
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
                                disabled={submitting || !findKeywords.trim()}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                                {submitting ? "Adding…" : "Start watching"}
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
                                directoryResults.map(entry => {
                                    const entryKey = watchlistConfigKey(entry.config);
                                    const alreadyAdded = entryKey !== null && existingKeys.has(entryKey);
                                    const selected = !alreadyAdded && selectedDirKeys.has(entry.name);
                                    return (
                                        <button
                                            key={entry.name}
                                            type="button"
                                            onClick={() => !alreadyAdded && toggleDirEntry(entry.name)}
                                            disabled={submitting || alreadyAdded}
                                            aria-disabled={alreadyAdded}
                                            aria-pressed={selected}
                                            title={alreadyAdded ? "Already on your watchlist" : undefined}
                                            className={[
                                                "flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors",
                                                alreadyAdded
                                                    ? "bg-black/20 border-white/5 opacity-60 cursor-not-allowed"
                                                    : selected
                                                        ? "bg-cyan-500/15 border-cyan-400/50"
                                                        : "bg-black/30 border-white/10 hover:border-white/30",
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
                                        </button>
                                    );
                                })
                            )}
                        </div>

                        <ScheduleField value={scheduleHours} onChange={setScheduleHours} disabled={submitting} />

                        <div className="flex items-center justify-end gap-2 pt-2">
                            {selectedDirKeys.size > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setSelectedDirKeys(new Set())}
                                    disabled={submitting}
                                    className="px-3 py-2 text-xs text-white/50 hover:text-white/80 disabled:opacity-40"
                                >
                                    Clear ({selectedDirKeys.size})
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
                                disabled={submitting || selectedDirKeys.size === 0}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                {submitting
                                    ? "Adding…"
                                    : selectedDirKeys.size === 0
                                        ? "Pick a company"
                                        : selectedDirKeys.size === 1
                                            ? `Watch ${Array.from(selectedDirKeys)[0]}`
                                            : `Watch ${selectedDirKeys.size} companies`}
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
                        <div className="inline-flex rounded-lg overflow-hidden border border-white/10 bg-black/40 w-fit flex-wrap" role="group">
                            {(["greenhouse", "lever", "ashby", "workday", "linkedin", "careers-page"] as const).map(k => (
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
                        {(advKind === "greenhouse" || advKind === "lever" || advKind === "ashby") && (
                            <>
                                <label className="text-[11px] uppercase tracking-wide text-white/40">{advKind} board slug</label>
                                <input
                                    type="text"
                                    placeholder={advKind === "greenhouse" ? "anthropic" : advKind === "lever" ? "spotify" : "notion"}
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
                        {advKind === "linkedin" && (
                            <>
                                <label className="text-[11px] uppercase tracking-wide text-white/40">Keywords</label>
                                <input
                                    type="text"
                                    placeholder="software engineer"
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
