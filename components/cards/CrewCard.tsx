"use client";

/**
 * Owner-only crew roster (docs/multi-user-crew.html P7).
 *
 * Renders inside the `internal-systems` dash, which is already owner-only at
 * the route guard and already excluded from `CREW_DASH_IDS`. That placement is
 * the reason this component carries NO role check of its own: per CLAUDE.md,
 * hiding a surface is never the access control — `/api/crew` is guarded by
 * `requireOwner()` and the role-matrix smoke asserts a crew viewer gets 403.
 * A conditional render here would only add a second, weaker copy of a boundary
 * that is already enforced where it counts.
 */

import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Trash2, UserPlus, Users, X } from "lucide-react";

import { api, queryKeys } from "@/lib/api-client";
import type { CrewMember } from "@/lib/schemas/crew";

/** Shared cell chrome so the header and body columns cannot drift apart. */
const COLS = "grid grid-cols-[1fr_5rem_4rem_4rem_2rem] gap-2 items-center";

function UsagePill({ used, limit }: { used: number; limit: number }) {
    // Colour tracks proportion, not a magic threshold: amber from three
    // quarters, red at the cap — where the 429 actually starts firing.
    const ratio = limit > 0 ? used / limit : 0;
    const tone =
        ratio >= 1 ? "text-red-400" : ratio >= 0.75 ? "text-amber-400" : "text-slate-300";
    return (
        <span className={`text-xs tabular-nums ${tone}`} title={`${used} of ${limit} AI calls used today (UTC)`}>
            {used}/{limit}
        </span>
    );
}

export const CrewCard: React.FC = () => {
    const qc = useQueryClient();
    const [email, setEmail] = useState("");
    const [pendingRemove, setPendingRemove] = useState<CrewMember | null>(null);
    const [confirmText, setConfirmText] = useState("");
    const [error, setError] = useState<string | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.crew,
        queryFn: () => api.crew.list(),
    });

    const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.crew });

    const addMutation = useMutation({
        mutationFn: (addr: string) => api.crew.add(addr),
        onSuccess: () => { setEmail(""); setError(null); invalidate(); },
        onError: (e: Error) => setError(e.message),
    });

    const removeMutation = useMutation({
        mutationFn: ({ id, addr }: { id: string; addr: string }) => api.crew.remove(id, addr),
        onSuccess: (res) => {
            setPendingRemove(null);
            setConfirmText("");
            setError(
                res.orphanedFiles.length > 0
                    ? `Removed ${res.email}, but ${res.orphanedFiles.length} file(s) could not be deleted and remain on disk.`
                    : null,
            );
            invalidate();
        },
        onError: (e: Error) => setError(e.message),
    });

    const rows = data?.crew ?? [];
    const limit = data?.aiDailyLimit ?? 0;

    // The exactly-one-owner invariant (OQ4a) is surfaced, not hidden. Zero owners
    // 403s the owner out of their own app; two silently hands the scheduler a
    // non-owner. Either is an incident, and this page is where it would show.
    const ownerWarning = useMemo(() => {
        const n = data?.ownerCount;
        if (n === undefined || n === 1) return null;
        return n === 0
            ? "No owner row on this instance — resolveOwner() will fail."
            : `${n} owner rows — there must be exactly one.`;
    }, [data?.ownerCount]);

    // The confirmation must match, case-insensitively and trimmed, the same way
    // the server re-checks it. Gating the button on the client is convenience;
    // the server check is the actual safety property.
    const confirmMatches =
        pendingRemove !== null &&
        confirmText.trim().toLowerCase() === pendingRemove.email.trim().toLowerCase();

    return (
        <div className="flex flex-col h-[280px]">
            <div className="flex items-center justify-between gap-3 mb-2 shrink-0">
                <div className="flex items-center gap-2 text-cyan-400 shrink-0">
                    <Users className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm whitespace-nowrap">Crew</h3>
                </div>
                <span className="text-[0.65rem] uppercase tracking-wide text-slate-500 ml-auto">
                    {rows.length} account{rows.length === 1 ? "" : "s"}
                </span>
            </div>
            <div className="flex-1 flex flex-col min-h-0 min-w-0 gap-3">
            {ownerWarning && (
                <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>{ownerWarning}</span>
                </div>
            )}

            {/* Roster */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className={`${COLS} text-[0.65rem] uppercase tracking-wide text-slate-500 pb-1 border-b border-white/5`}>
                    <span>Account</span>
                    <span className="text-right">AI today</span>
                    <span className="text-right">Lists</span>
                    <span className="text-right">Apps</span>
                    <span />
                </div>

                {isLoading && (
                    <div className="flex items-center gap-2 text-xs text-slate-400 py-3">
                        <Loader2 className="w-3 h-3 animate-spin" /> Loading roster…
                    </div>
                )}

                {!isLoading && rows.length === 0 && (
                    <p className="text-xs text-slate-500 py-3">No accounts on this instance.</p>
                )}

                {rows.map((m) => {
                    const isOwner = m.role === "owner";
                    return (
                        <div key={m.id} className={`${COLS} py-2 border-b border-white/5 last:border-0`}>
                            <div className="min-w-0">
                                <div className="text-sm text-slate-200 truncate" title={m.email}>{m.email}</div>
                                <div className="text-[0.65rem] uppercase tracking-wide text-slate-500">
                                    {isOwner ? "owner" : "crew"}{m.name ? ` · ${m.name}` : ""}
                                </div>
                            </div>
                            {/* The owner is exempt from the AI cap and is never metered at
                                all, so a number here would be a fabrication. */}
                            <div className="text-right">
                                {isOwner ? <span className="text-xs text-slate-600">exempt</span>
                                    : <UsagePill used={m.aiUsedToday} limit={limit} />}
                            </div>
                            <div className="text-right text-xs text-slate-400 tabular-nums">{m.watchlistCount}</div>
                            <div className="text-right text-xs text-slate-400 tabular-nums">{m.applicationCount}</div>
                            <div className="flex justify-end">
                                {/* No remove affordance for the owner at all — the server
                                    refuses it, so offering a button that always fails
                                    would be a worse experience than its absence. */}
                                {!isOwner && (
                                    <button
                                        onClick={() => { setPendingRemove(m); setConfirmText(""); setError(null); }}
                                        className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                                        title={`Remove ${m.email}`}
                                        aria-label={`Remove ${m.email}`}
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Add */}
            <form
                onSubmit={(e) => { e.preventDefault(); if (email.trim()) addMutation.mutate(email.trim()); }}
                className="flex items-center gap-2 pt-1"
            >
                <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setError(null); }}
                    placeholder="crew@example.com"
                    className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50"
                />
                <button
                    type="submit"
                    disabled={!email.trim() || addMutation.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                >
                    {addMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                    Add
                </button>
            </form>

            <p className="text-[0.65rem] text-slate-600 leading-relaxed">
                Adding an account creates a <code className="text-slate-500">crew</code> row on <em>this tier only</em>.
                They still need to clear Cloudflare Access to reach the app.
            </p>

            {error && <p className="text-xs text-red-400">{error}</p>}

            {/* Removal confirmation — type-the-email, mirroring the CLI's
                --confirm-delete. The list of what is destroyed is spelled out
                because it is irreversible and cascades far beyond the row. */}
            {pendingRemove && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
                    <div className="w-full max-w-md bg-slate-900 border border-red-500/30 rounded-lg p-4 flex flex-col gap-3">
                        <div className="flex items-start justify-between gap-2">
                            <h3 className="text-sm font-semibold text-red-300">Remove {pendingRemove.email}?</h3>
                            <button
                                onClick={() => { setPendingRemove(null); setConfirmText(""); }}
                                className="text-slate-500 hover:text-slate-300"
                                aria-label="Cancel"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <p className="text-xs text-slate-400 leading-relaxed">
                            This permanently deletes their account and everything attached to it —
                            {" "}{pendingRemove.applicationCount} application(s), {pendingRemove.watchlistCount} watchlist(s),
                            plus their resumes, tasks and notifications — and removes their resume files from disk.
                            <strong className="text-red-300"> There is no undo.</strong>
                        </p>

                        <label className="text-xs text-slate-400">
                            Type <span className="text-slate-200 font-mono">{pendingRemove.email}</span> to confirm:
                            <input
                                autoFocus
                                value={confirmText}
                                onChange={(e) => setConfirmText(e.target.value)}
                                className="mt-1 w-full bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-red-500/50"
                            />
                        </label>

                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => { setPendingRemove(null); setConfirmText(""); }}
                                className="px-3 py-1.5 text-sm rounded-md border border-white/10 text-slate-300 hover:bg-white/5"
                            >
                                Cancel
                            </button>
                            <button
                                disabled={!confirmMatches || removeMutation.isPending}
                                onClick={() => removeMutation.mutate({ id: pendingRemove.id, addr: pendingRemove.email })}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 disabled:opacity-40 transition-colors"
                            >
                                {removeMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                Remove permanently
                            </button>
                        </div>
                    </div>
                </div>
            )}
            </div>
        </div>
    );
};
