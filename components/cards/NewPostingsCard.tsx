"use client";
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, EyeOff, Loader2, MapPin, Newspaper, BriefcaseBusiness } from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

const LIMIT = 50;

export function NewPostingsCard() {
    const queryClient = useQueryClient();
    const [busyId, setBusyId] = useState<string | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.postings({ status: "new" }),
        queryFn: () => api.postings.list({ status: "new", limit: LIMIT }),
    });

    useServerEvents("Posting", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
    });

    const postings = data?.postings ?? [];

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
        <div>
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <Newspaper className="w-4 h-4 text-cyan-300" />
                    <h3 className="text-sm font-semibold text-cyan-200">New postings</h3>
                </div>
                <span className="text-[11px] text-white/40">
                    {postings.length}{postings.length === LIMIT ? "+" : ""} new
                </span>
            </div>

            {isLoading ? (
                <div className="flex items-center justify-center py-6 text-white/40">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </div>
            ) : postings.length === 0 ? (
                <p className="text-xs text-white/40 italic">No new postings. Run a watchlist or wait for the scheduler tick.</p>
            ) : (
                <ul className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
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
                                        {p.location && (
                                            <div className="text-[11px] text-white/40 mt-0.5 flex items-center gap-1">
                                                <MapPin className="w-3 h-3" />
                                                {p.location}
                                            </div>
                                        )}
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
        </div>
    );
}
