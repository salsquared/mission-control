"use client";
import React, { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2, Loader2, History } from "lucide-react";
import { Card } from "../ui/Card";
import { api, queryKeys } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";
import { useServerEvents } from "@/hooks/useServerEvents";
import type { ProfileSnapshotSummaryWire } from "@/lib/schemas/profile";

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function formatTakenAt(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

export function ProfileSnapshotsCard() {
    const queryClient = useQueryClient();
    const [label, setLabel] = useState("");

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.profileSnapshots,
        queryFn: () => api.profile.snapshots.list(),
    });
    const snapshots: ProfileSnapshotSummaryWire[] = data?.snapshots ?? [];

    const invalidate = useCallback(
        () => queryClient.invalidateQueries({ queryKey: queryKeys.profileSnapshots }),
        [queryClient],
    );
    useServerEvents("ProfileSnapshot", invalidate);

    const createMutation = useMutation({
        mutationFn: (labelInput: string | null) => api.profile.snapshots.create({ label: labelInput }),
        onSuccess: () => {
            setLabel("");
            queryClient.invalidateQueries({ queryKey: queryKeys.profileSnapshots });
            toastStore.push({ message: "Snapshot saved", type: "info" });
        },
        onError: (e) => {
            toastStore.push({ message: `Snapshot failed: ${errMessage(e)}`, type: "error" });
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.profile.snapshots.delete(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.profileSnapshots });
        },
        onError: (e) => {
            toastStore.push({ message: `Delete failed: ${errMessage(e)}`, type: "error" });
        },
    });

    const handleSnapshot = () => {
        const trimmed = label.trim();
        createMutation.mutate(trimmed.length > 0 ? trimmed : null);
    };

    const handleDelete = (id: string) => {
        if (!window.confirm("Delete this snapshot?")) return;
        deleteMutation.mutate(id);
    };

    return (
        <Card
            title="Profile snapshots"
            icon={History}
            iconColorClass="text-purple-300"
        >
            <p className="text-xs text-white/50 mb-3">
                Save a point-in-time copy of your profile (work roles, projects, education, bullets, tags). Button-press only — no automatic snapshots.
            </p>

            <div className="flex gap-2 mb-3">
                <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Optional label (e.g. 'pre-internship rewrite')"
                    maxLength={120}
                    disabled={createMutation.isPending}
                    className="flex-1 px-3 py-1.5 rounded-md bg-black/30 border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-purple-400/50"
                />
                <button
                    onClick={handleSnapshot}
                    disabled={createMutation.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-purple-600 hover:bg-purple-500 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-all"
                >
                    {createMutation.isPending
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Camera className="w-3.5 h-3.5" />
                    }
                    Snapshot now
                </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
                {isLoading
                    ? (
                        <div className="flex items-center justify-center py-6 text-white/40 text-xs">
                            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading snapshots…
                        </div>
                    )
                    : snapshots.length === 0
                        ? (
                            <div className="text-xs text-white/40 italic py-2">
                                No snapshots yet. Save one before a big edit.
                            </div>
                        )
                        : (
                            <ul className="space-y-1">
                                {snapshots.map((s) => (
                                    <li
                                        key={s.id}
                                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-black/20 border border-white/5 hover:border-purple-400/30 transition-colors text-xs"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="text-white/80 truncate">
                                                {s.label || <span className="italic text-white/40">Unlabeled</span>}
                                            </div>
                                            <div className="text-[10px] text-white/40">
                                                {formatTakenAt(s.takenAt)}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleDelete(s.id)}
                                            disabled={deleteMutation.isPending}
                                            className="text-white/30 hover:text-rose-400 transition-colors p-1 rounded disabled:opacity-50"
                                            aria-label="Delete snapshot"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
            </div>
        </Card>
    );
}
