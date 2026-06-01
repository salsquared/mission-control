"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, Loader2, Save, Minus, Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";
import type { WatchlistWire } from "@/lib/schemas/watchlists";
import { type FindRolesGroup } from "@/lib/watchlists/find-roles-grouping";

// Same source list AddWatchlistModal exposes — kept in sync intentionally. If
// you add a third aggregator (Adzuna, RemoteOK, …), update both.
const FIND_SOURCES = [
    { id: "linkedin" as const, label: "LinkedIn", hint: "LinkedIn guest job search. Fragile — DOM shifts and bot detection." },
    { id: "indeed" as const, label: "Indeed", hint: "Indeed mass-market index. Cloudflare-gated; expect intermittent challenges." },
];
type FindSourceId = (typeof FIND_SOURCES)[number]["id"];

const MIN_HOURS = 1;
const MAX_HOURS = 24;

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// Canonical row name for a given (keywords, location, sourceCount, label).
// Single-source = bare title; multi-source = title + " (Label)" suffix. Same
// rule AddWatchlistModal applies on create, so editing keeps names consistent.
function rowName(keywords: string, location: string, sourceCount: number, label: string): string {
    const base = location ? `${keywords} — ${location}` : keywords;
    return sourceCount > 1 ? `${base} (${label})` : base;
}

const SOURCE_COMPANY_NAME: Record<FindSourceId, string> = {
    linkedin: "LinkedIn search",
    indeed: "Indeed search",
};

interface EditFindRolesModalProps {
    open: boolean;
    group: FindRolesGroup | null;
    onClose: () => void;
    onSaved: () => void;
}

export const EditFindRolesModal: React.FC<EditFindRolesModalProps> = ({ open, group, onClose, onSaved }) => {
    // SSR gate: createPortal needs document.body.
    const [mounted, setMounted] = useState(false);
    useEffect(() => { setMounted(true); }, []);

    const [keywords, setKeywords] = useState("");
    const [location, setLocation] = useState("");
    const [sources, setSources] = useState<Set<FindSourceId>>(() => new Set());
    const [scheduleHours, setScheduleHours] = useState(4);
    const [submitting, setSubmitting] = useState(false);

    // Pre-fill from the group every time the modal opens with a new group. Use
    // a key-style guard (memoized group identity) so re-renders during edit
    // don't trample the user's in-progress changes.
    const groupKey = group?.groupKey ?? null;
    const initial = useMemo(() => {
        if (!group) return null;
        // Source set: union of member kinds.
        const srcSet = new Set<FindSourceId>();
        for (const m of group.members) {
            if (m.kind === "linkedin" || m.kind === "indeed") srcSet.add(m.kind);
        }
        // Schedule: pick the anchor member's value. If members disagree, the
        // anchor still wins — the modal surfaces a hint below the field so the
        // user knows what they'd be flattening.
        const anchorMinutes = group.members[0]?.scheduleMinutes ?? 240;
        const mixedSchedules = group.members.some(m => m.scheduleMinutes !== anchorMinutes);
        return {
            keywords: group.keywords,
            location: group.location ?? "",
            sources: srcSet,
            scheduleHours: Math.max(MIN_HOURS, Math.min(MAX_HOURS, Math.round(anchorMinutes / 60))),
            mixedSchedules,
            track: group.track,
        };
    }, [group, groupKey]); // eslint-disable-line react-hooks/exhaustive-deps -- groupKey forces reset on group identity change

    // When the group identity changes (different row opened), reseed local
    // state. Editing the same group across re-renders doesn't reseed.
    const [lastSeenKey, setLastSeenKey] = useState<string | null>(null);
    if (open && initial && lastSeenKey !== groupKey) {
        setLastSeenKey(groupKey);
        setKeywords(initial.keywords);
        setLocation(initial.location);
        setSources(new Set(initial.sources));
        setScheduleHours(initial.scheduleHours);
    }
    // Reset the seen-key when the modal closes so reopening with the same
    // group still re-seeds (user may have made local changes they discarded).
    if (!open && lastSeenKey !== null) {
        setLastSeenKey(null);
    }

    const toggleSource = useCallback((id: FindSourceId) => {
        setSources(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const handleClose = useCallback(() => {
        if (submitting) return;
        onClose();
    }, [submitting, onClose]);

    if (!open || !mounted || !group || !initial) return null;

    const trimmedKw = keywords.trim();
    const trimmedLoc = location.trim();
    const sourcesList = FIND_SOURCES.filter(s => sources.has(s.id));
    const valid = trimmedKw.length > 0 && sourcesList.length > 0;

    // Dirty check: any field changed?
    const dirty = (
        trimmedKw !== initial.keywords.trim() ||
        trimmedLoc !== (initial.location ?? "").trim() ||
        scheduleHours * 60 !== group.members[0]?.scheduleMinutes ||
        sources.size !== initial.sources.size ||
        Array.from(sources).some(s => !initial.sources.has(s))
    );

    async function handleSave() {
        if (!group || !initial || submitting || !valid || !dirty) return;
        setSubmitting(true);
        try {
            const finalCount = sourcesList.length;
            // Partition: keep (PATCH), add (POST), remove (DELETE).
            const kept: { src: typeof sourcesList[number]; member: WatchlistWire }[] = [];
            const removed: WatchlistWire[] = [];
            for (const m of group.members) {
                if (m.kind !== "linkedin" && m.kind !== "indeed") continue;
                const stillIn = sources.has(m.kind);
                if (stillIn) {
                    const src = FIND_SOURCES.find(s => s.id === m.kind)!;
                    kept.push({ src, member: m });
                } else {
                    removed.push(m);
                }
            }
            const addedSrcs = sourcesList.filter(s =>
                !group.members.some(m => m.kind === s.id),
            );

            const ops: Promise<unknown>[] = [];
            // PATCH every kept row with the new config + canonical name. Even
            // when only the source count changed (1 → 2), names need updating
            // so the suffix appears/disappears.
            for (const { src, member } of kept) {
                ops.push(api.watchlists.update(member.id, {
                    name: rowName(trimmedKw, trimmedLoc, finalCount, src.label),
                    config: {
                        kind: src.id,
                        keywords: trimmedKw,
                        location: trimmedLoc || undefined,
                        companyName: SOURCE_COMPANY_NAME[src.id],
                    },
                    scheduleMinutes: scheduleHours * 60,
                }));
            }
            // POST new rows for added sources.
            for (const src of addedSrcs) {
                ops.push(api.watchlists.create({
                    name: rowName(trimmedKw, trimmedLoc, finalCount, src.label),
                    config: {
                        kind: src.id,
                        keywords: trimmedKw,
                        location: trimmedLoc || undefined,
                        companyName: SOURCE_COMPANY_NAME[src.id],
                    },
                    scheduleMinutes: scheduleHours * 60,
                    track: initial.track,
                }));
            }
            // DELETE removed rows.
            for (const m of removed) {
                ops.push(api.watchlists.delete(m.id));
            }

            const results = await Promise.allSettled(ops);
            const failures = results.filter(r => r.status === "rejected");
            if (failures.length === 0) {
                toastStore.push({ message: "Find Roles search updated", type: "info" });
                onSaved();
                onClose();
            } else {
                const reasons = failures.map(r => r.status === "rejected" ? errMessage(r.reason) : "").filter(Boolean);
                toastStore.push({
                    message: `Partial save: ${failures.length}/${results.length} ops failed. ${reasons.slice(0, 1).join("; ")}`,
                    type: "error",
                });
                onSaved(); // still refresh — the succeeded ops landed
            }
        } catch (err) {
            // Promise.allSettled doesn't throw — this is for unexpected sync throws.
            toastStore.push({ message: `Save failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setSubmitting(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={handleClose}>
            <div
                className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl flex flex-col max-h-[60vh]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
                    <h2 className="text-sm font-semibold text-white">Edit Find Roles search</h2>
                    <button onClick={handleClose} className="text-white/40 hover:text-white/80" aria-label="Close">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 flex flex-col gap-3">
                    <p className="text-[11px] text-white/50">
                        Update the role, location, sources, or cadence for this search. Adding a source creates a new watchlist; removing one deletes it (with its postings).
                    </p>

                    <label className="text-[11px] uppercase tracking-wide text-white/40">What kind of role?</label>
                    <input
                        type="text"
                        value={keywords}
                        onChange={(e) => setKeywords(e.target.value)}
                        disabled={submitting}
                        placeholder="e.g. software engineer, mechanical engineer, propulsion"
                        autoFocus
                        className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                    />

                    <label className="text-[11px] uppercase tracking-wide text-white/40">Sources</label>
                    <div className="flex flex-wrap gap-1.5">
                        {FIND_SOURCES.map(src => {
                            const active = sources.has(src.id);
                            return (
                                <button
                                    key={src.id}
                                    type="button"
                                    onClick={() => toggleSource(src.id)}
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
                    {sources.size === 0 && (
                        <p className="text-[10px] text-red-300/80 -mt-1">
                            Pick at least one source — unchecking all is the same as deleting the search.
                        </p>
                    )}

                    <label className="text-[11px] uppercase tracking-wide text-white/40">Where? (optional)</label>
                    <input
                        type="text"
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        disabled={submitting}
                        placeholder="Remote, United States, New York, …"
                        className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                    />

                    <div className="flex items-center gap-3 pt-1">
                        <label className="text-[11px] uppercase tracking-wide text-white/40">Crawl every</label>
                        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/40">
                            <button
                                type="button"
                                onClick={() => setScheduleHours(h => Math.max(MIN_HOURS, h - 1))}
                                disabled={submitting || scheduleHours <= MIN_HOURS}
                                className="p-1.5 text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed rounded-l-lg"
                                aria-label="Decrease cadence"
                            >
                                <Minus className="w-3.5 h-3.5" />
                            </button>
                            <div className="px-3 py-1 text-sm text-white tabular-nums min-w-[3.5rem] text-center">
                                {scheduleHours}<span className="text-[11px] text-white/40 ml-0.5">h</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setScheduleHours(h => Math.min(MAX_HOURS, h + 1))}
                                disabled={submitting || scheduleHours >= MAX_HOURS}
                                className="p-1.5 text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed rounded-r-lg"
                                aria-label="Increase cadence"
                            >
                                <Plus className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                    {initial.mixedSchedules && (
                        <p className="text-[10px] text-amber-300/80 leading-tight">
                            Members of this search currently have different cadences. Saving will flatten them all to {scheduleHours}h.
                        </p>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/10 shrink-0">
                    <button
                        type="button"
                        onClick={handleClose}
                        disabled={submitting}
                        className="px-4 py-2 text-xs text-white/60 hover:text-white/90 disabled:opacity-40"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={submitting || !valid || !dirty}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        {submitting ? "Saving…" : !dirty ? "No changes" : "Save"}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
