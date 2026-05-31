"use client";
import React, { useCallback, useState } from "react";
import {
    Layers,
    Loader2,
    Plus,
    RefreshCw,
    Download,
    Pencil,
    Trash2,
    Check,
    X,
    AlertTriangle,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toastStore } from "@/lib/toast-store";
import { api, queryKeys, type CanonWire } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { Card } from "../../ui/Card";

type Track = "career" | "side";

// Per-row track pill — same blue=career / amber=side convention as
// GenerateResumeCard's TRACK_PILL_CLASSES so the vocabulary reads across the app.
const TRACK_PILL_CLASSES: Record<string, string> = {
    career: "text-blue-300 bg-blue-500/10 border border-blue-500/30",
    side: "text-amber-300 bg-amber-500/10 border border-amber-500/30",
};
const TRACK_PILL_FALLBACK = "text-white/40 bg-white/[0.04] border border-white/10";

// Order the two track groups predictably (career first, then side).
const TRACK_ORDER: Track[] = ["career", "side"];
const TRACK_LABELS: Record<Track, string> = { career: "Career", side: "Side" };

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function CanonsCard() {
    const queryClient = useQueryClient();

    const { data, isLoading, error } = useQuery({
        queryKey: queryKeys.canons(),
        queryFn: () => api.canons.list(),
    });
    const canons = data?.canons ?? [];

    const invalidate = useCallback(
        () => queryClient.invalidateQueries({ queryKey: ["canons"] }),
        [queryClient],
    );
    // Live-refresh on canon mutations from any tab / the scheduler.
    useServerEvents("Canon", invalidate);

    // Which canon row is currently mid-regenerate (so we only spin that one).
    const [regenId, setRegenId] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);

    async function handleRegenerate(canon: CanonWire) {
        if (regenId) return;
        setRegenId(canon.id);
        try {
            const res = await fetch("/api/resumes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    posting: { canonId: canon.id },
                    options: { format: "pdf", onePage: canon.onePage },
                }),
            });
            if (!res.ok) {
                let detail = "";
                try {
                    const j = await res.json();
                    detail = j.error
                        ? (typeof j.error === "string" ? j.error : JSON.stringify(j.error))
                        : "";
                } catch {
                    /* non-JSON body */
                }
                throw new Error(detail || `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            window.open(objectUrl, "_blank");
            // Clear the stale badge + pick up the new version count.
            invalidate();
            toastStore.push({ message: `“${canon.name}” resume regenerated`, type: "info" });
        } catch (e) {
            toastStore.push({ message: `Regenerate failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setRegenId(null);
        }
    }

    function handleDownload(canon: CanonWire) {
        if (!canon.currentResumeId) return;
        window.open(
            `/api/resumes/${encodeURIComponent(canon.currentResumeId)}/download`,
            "_blank",
        );
    }

    async function handleDelete(canon: CanonWire) {
        if (!window.confirm(`Delete the “${canon.name}” canon? Its resume versions are removed too.`)) {
            return;
        }
        try {
            await api.canons.delete(canon.id);
            invalidate();
            toastStore.push({ message: `Deleted “${canon.name}”`, type: "info" });
        } catch (e) {
            toastStore.push({ message: `Delete failed: ${errMessage(e)}`, type: "error" });
        }
    }

    // Group canons by track for tidy section headers.
    const grouped = TRACK_ORDER.map((track) => ({
        track,
        rows: canons
            .filter((c) => c.track === track)
            .sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((g) => g.rows.length > 0);

    return (
        <Card title="Canons" icon={Layers} iconColorClass="text-purple-300" loading={isLoading}>
            <p className="text-xs text-white/50 mb-3">
                One reusable resume per role-type (&ldquo;Security Officer&rdquo;, &ldquo;Math Tutor&rdquo;,
                &ldquo;Avionics Engineer&rdquo;). Edit a canon&apos;s keywords, regenerate its resume once,
                and reuse it across every job of that type.
            </p>

            {error ? (
                <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-400/30 text-[11px] text-rose-200">
                    Failed to load canons: {errMessage(error)}
                </div>
            ) : canons.length === 0 && !isLoading ? (
                <div className="px-3 py-4 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/40">
                    No canons yet. Create one below — name it after a role-type and give it the
                    keywords postings of that type ask for.
                </div>
            ) : (
                <div className="space-y-4">
                    {grouped.map((group) => (
                        <div key={group.track}>
                            <div className="flex items-center gap-2 mb-1.5">
                                <span
                                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${TRACK_PILL_CLASSES[group.track] ?? TRACK_PILL_FALLBACK}`}
                                >
                                    {TRACK_LABELS[group.track]}
                                </span>
                                <span className="text-[10px] text-white/30">{group.rows.length}</span>
                            </div>
                            <div className="rounded-lg bg-black/40 border border-white/10 divide-y divide-white/5">
                                {group.rows.map((canon) => (
                                    <CanonRow
                                        key={canon.id}
                                        canon={canon}
                                        regenerating={regenId === canon.id}
                                        anyRegenerating={regenId !== null}
                                        onRegenerate={() => handleRegenerate(canon)}
                                        onDownload={() => handleDownload(canon)}
                                        onDelete={() => handleDelete(canon)}
                                        onSaved={invalidate}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="mt-3">
                {showCreate ? (
                    <CreateCanonForm
                        onClose={() => setShowCreate(false)}
                        onCreated={invalidate}
                    />
                ) : (
                    <button
                        type="button"
                        onClick={() => setShowCreate(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-xs font-semibold text-purple-100 transition-colors"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        New canon
                    </button>
                )}
            </div>
        </Card>
    );
}

// ─── A single canon row ─────────────────────────────────────────────────────

const CanonRow: React.FC<{
    canon: CanonWire;
    regenerating: boolean;
    anyRegenerating: boolean;
    onRegenerate: () => void;
    onDownload: () => void;
    onDelete: () => void;
    onSaved: () => void;
}> = ({ canon, regenerating, anyRegenerating, onRegenerate, onDownload, onDelete, onSaved }) => {
    const [editing, setEditing] = useState(false);

    if (editing) {
        return (
            <EditCanonForm
                canon={canon}
                onClose={() => setEditing(false)}
                onSaved={onSaved}
            />
        );
    }

    return (
        <div className="px-3 py-2.5">
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-white/90 truncate">{canon.name}</span>
                        <span
                            className={`text-[9px] uppercase tracking-wide px-1 rounded ${TRACK_PILL_CLASSES[canon.track] ?? TRACK_PILL_FALLBACK}`}
                        >
                            {canon.track}
                        </span>
                        {canon.resumeStale && (
                            <span
                                className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wide text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded"
                                title="The current resume is out of date — regenerate to refresh it."
                            >
                                <AlertTriangle className="w-2.5 h-2.5" />
                                stale
                            </span>
                        )}
                        <span className="text-[10px] text-white/30">
                            {canon.versionCount} version{canon.versionCount === 1 ? "" : "s"}
                        </span>
                    </div>
                    {canon.keywords.trim() ? (
                        <div className="text-[11px] text-white/50 mt-0.5 break-words leading-snug">
                            {canon.keywords}
                        </div>
                    ) : (
                        <div className="text-[11px] text-white/30 italic mt-0.5">No keywords yet</div>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <button
                    type="button"
                    onClick={onRegenerate}
                    disabled={anyRegenerating}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-[11px] font-semibold text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {regenerating ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                        <RefreshCw className="w-3 h-3" />
                    )}
                    {regenerating ? "Generating…" : "Regenerate"}
                </button>
                <button
                    type="button"
                    onClick={onDownload}
                    disabled={!canon.currentResumeId}
                    title={canon.currentResumeId ? "Download the current resume" : "Regenerate first — no resume yet"}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.04] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    <Download className="w-3 h-3" />
                    Download
                </button>
                <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.04] transition-colors"
                >
                    <Pencil className="w-3 h-3" />
                    Edit
                </button>
                <button
                    type="button"
                    onClick={onDelete}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-rose-300/70 hover:text-rose-200 hover:bg-rose-500/10 transition-colors"
                >
                    <Trash2 className="w-3 h-3" />
                    Delete
                </button>
            </div>
        </div>
    );
};

// ─── Edit form (name + keywords) ────────────────────────────────────────────

const EditCanonForm: React.FC<{
    canon: CanonWire;
    onClose: () => void;
    onSaved: () => void;
}> = ({ canon, onClose, onSaved }) => {
    const [name, setName] = useState(canon.name);
    const [keywords, setKeywords] = useState(canon.keywords);
    const [busy, setBusy] = useState(false);

    const dirty = name.trim() !== canon.name || keywords !== canon.keywords;
    const canSave = !busy && name.trim().length > 0 && dirty;

    async function handleSave() {
        if (!canSave) return;
        setBusy(true);
        try {
            await api.canons.update(canon.id, { name: name.trim(), keywords });
            onSaved();
            toastStore.push({ message: `Updated “${name.trim()}”`, type: "info" });
            onClose();
        } catch (e) {
            toastStore.push({ message: `Update failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="px-3 py-2.5 bg-purple-500/[0.04]">
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Name</label>
            <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                className="w-full px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40"
            />
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mt-2 mb-1">
                Keywords <span className="text-white/25 normal-case">(editing marks the resume stale)</span>
            </label>
            <textarea
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                disabled={busy}
                rows={2}
                placeholder="security officer OR mall patrol OR access control"
                className="w-full px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40 resize-y"
            />
            <div className="flex items-center gap-1.5 mt-2">
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canSave}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-[11px] font-semibold text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Save
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border border-white/10 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.04] transition-colors"
                >
                    <X className="w-3 h-3" />
                    Cancel
                </button>
            </div>
        </div>
    );
};

// ─── Create form (name + track + keywords) ──────────────────────────────────

const CreateCanonForm: React.FC<{
    onClose: () => void;
    onCreated: () => void;
}> = ({ onClose, onCreated }) => {
    const [name, setName] = useState("");
    const [track, setTrack] = useState<Track>("career");
    const [keywords, setKeywords] = useState("");
    const [busy, setBusy] = useState(false);

    const canSubmit = !busy && name.trim().length > 0;

    async function handleCreate() {
        if (!canSubmit) return;
        setBusy(true);
        try {
            await api.canons.create({
                name: name.trim(),
                track,
                keywords: keywords.trim() || undefined,
            });
            onCreated();
            toastStore.push({ message: `Created “${name.trim()}”`, type: "info" });
            onClose();
        } catch (e) {
            toastStore.push({ message: `Create failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="rounded-lg bg-black/40 border border-white/10 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                    <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy}
                        placeholder="Security Officer"
                        autoFocus
                        className="w-full px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40"
                    />
                </div>
                <div>
                    <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Track</label>
                    <div
                        className="inline-flex rounded-lg overflow-hidden border border-white/10 bg-black/40"
                        role="group"
                        aria-label="Track"
                    >
                        {(["career", "side"] as const).map((t) => {
                            const active = track === t;
                            return (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => setTrack(t)}
                                    disabled={busy}
                                    aria-pressed={active}
                                    className={[
                                        "px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                                        active
                                            ? t === "career"
                                                ? "bg-blue-500/20 text-blue-200"
                                                : "bg-amber-500/20 text-amber-200"
                                            : "text-white/50 hover:text-white/80",
                                        busy ? "opacity-40 cursor-not-allowed" : "",
                                    ].join(" ")}
                                >
                                    {t}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mt-2 mb-1">
                Keywords <span className="text-white/25 normal-case">(optional — the terms postings of this type ask for)</span>
            </label>
            <textarea
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                disabled={busy}
                rows={2}
                placeholder="security officer OR mall patrol OR access control"
                className="w-full px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40 resize-y"
            />
            <div className="flex items-center gap-1.5 mt-2">
                <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!canSubmit}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-[11px] font-semibold text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                    Create
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border border-white/10 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.04] transition-colors"
                >
                    <X className="w-3 h-3" />
                    Cancel
                </button>
            </div>
        </div>
    );
};
