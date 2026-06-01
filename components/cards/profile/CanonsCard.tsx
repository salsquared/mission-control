"use client";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
    Sparkles,
    Search,
    History,
    ChevronDown,
    SlidersHorizontal,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toastStore } from "@/lib/toast-store";
import { api, queryKeys, type CanonWire } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { Card } from "../../ui/Card";
import { ResumeBuilderOverlay } from "@/components/overlays/ResumeBuilderOverlay";

// Relative-time helper — mirrors GenerateResumeCard's formatRelative so the
// version-history dropdown reads timestamps the same way the resume archive does.
function formatRelative(iso: string): string {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const delta = Math.max(0, now - then);
    const m = Math.round(delta / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
}

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

    // Which canon row is currently mid-specialize (single-flight).
    const [specializeId, setSpecializeId] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    // Which canon's manual resume builder overlay is open (P3.2).
    const [builderCanon, setBuilderCanon] = useState<CanonWire | null>(null);

    // "Re-render" opens the HTML preview of the canon's saved selection in a new
    // tab — links open in their own tab and never close the resume (Chrome's
    // PDF viewer can't do that), and the preview computes its own page-fit
    // banner. It deliberately does NOT generate a new resume version: versions
    // come only from the Generate buttons (the builder overlay + the one-off
    // GenerateResumeCard). So this is a pure GET — no POST, no persistence.
    function handleRegenerate(canon: CanonWire) {
        if (!canon.hasSelection) return;
        window.open(`/api/canons/${canon.id}/preview`, "_blank");
    }

    function handleDownload(canon: CanonWire) {
        if (!canon.currentResumeId) return;
        window.open(
            `/api/resumes/${encodeURIComponent(canon.currentResumeId)}/download`,
            "_blank",
        );
    }

    // Specialize the canon's base resume for a specific Interested job — same
    // bullets, re-worded by the backend, returns a PDF blob we open in a tab.
    // Single-flight via specializeId, mirroring the Regenerate flow.
    async function handleSpecialize(canon: CanonWire, applicationId: string) {
        if (specializeId) return;
        setSpecializeId(canon.id);
        try {
            const res = await fetch("/api/resumes/specialize", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ canonId: canon.id, applicationId }),
            });
            if (!res.ok) {
                let detail = "";
                try {
                    const j = await res.json();
                    const msg = j.error
                        ? (typeof j.error === "string" ? j.error : JSON.stringify(j.error))
                        : "";
                    detail = j.stage ? `${msg} (${j.stage})` : msg;
                } catch {
                    /* non-JSON body */
                }
                throw new Error(detail || `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            window.open(objectUrl, "_blank");
            // Pick up the new per-job child resume in the version count, and
            // refresh this canon's version-history dropdown.
            invalidate();
            queryClient.invalidateQueries({ queryKey: queryKeys.canonVersions(canon.id) });
            toastStore.push({ message: `“${canon.name}” specialized for this job`, type: "info" });
        } catch (e) {
            toastStore.push({ message: `Specialize failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setSpecializeId(null);
        }
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
                                        specializing={specializeId === canon.id}
                                        anySpecializing={specializeId !== null}
                                        onRegenerate={() => handleRegenerate(canon)}
                                        onDownload={() => handleDownload(canon)}
                                        onSpecialize={(applicationId) => handleSpecialize(canon, applicationId)}
                                        onDelete={() => handleDelete(canon)}
                                        onEdit={() => setBuilderCanon(canon)}
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

            {builderCanon && (
                <ResumeBuilderOverlay
                    canon={{
                        id: builderCanon.id,
                        name: builderCanon.name,
                        currentResumeId: builderCanon.currentResumeId,
                    }}
                    onClose={() => setBuilderCanon(null)}
                />
            )}
        </Card>
    );
}

// ─── A single canon row ─────────────────────────────────────────────────────

const CanonRow: React.FC<{
    canon: CanonWire;
    specializing: boolean;
    anySpecializing: boolean;
    onRegenerate: () => void;
    onDownload: () => void;
    onSpecialize: (applicationId: string) => void;
    onDelete: () => void;
    onEdit: () => void;
    onSaved: () => void;
}> = ({
    canon,
    specializing,
    anySpecializing,
    onRegenerate,
    onDownload,
    onSpecialize,
    onDelete,
    onEdit,
    onSaved,
}) => {
    const [editing, setEditing] = useState(false);
    const [pickingJob, setPickingJob] = useState(false);
    const [showVersions, setShowVersions] = useState(false);

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
            <div className="flex items-start gap-3">
                {/* LEFT — title + track, keywords */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-white/90 truncate">{canon.name}</span>
                        <span
                            className={`text-[9px] uppercase tracking-wide px-1 rounded ${TRACK_PILL_CLASSES[canon.track] ?? TRACK_PILL_FALLBACK}`}
                        >
                            {canon.track}
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

                {/* RIGHT — stale, versions, regenerate, download, specialize, edit, delete */}
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        {canon.resumeStale && (
                            <span
                                className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wide text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded"
                                title="The current resume is out of date — regenerate to refresh it."
                            >
                                <AlertTriangle className="w-2.5 h-2.5" />
                                stale
                            </span>
                        )}
                        {canon.versionCount > 0 ? (
                            <CanonVersionsDropdown
                                canonId={canon.id}
                                versionCount={canon.versionCount}
                                open={showVersions}
                                onToggle={() => setShowVersions((v) => !v)}
                                onClose={() => setShowVersions(false)}
                            />
                        ) : (
                            <span className="text-[10px] text-white/30">
                                {canon.versionCount} version{canon.versionCount === 1 ? "" : "s"}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        <button
                            type="button"
                            onClick={onEdit}
                            title="Open the builder — hand-pick what goes on this canon's resume, then generate"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-[11px] font-semibold text-purple-100 transition-colors"
                        >
                            <SlidersHorizontal className="w-3 h-3" />
                            Edit &amp; generate
                        </button>
                        <button
                            type="button"
                            onClick={onRegenerate}
                            disabled={!canon.hasSelection}
                            title={
                                canon.hasSelection
                                    ? "Open the HTML preview of the saved selection (verbatim, no AI) — does NOT create a new version"
                                    : "No saved selection yet — use Edit & generate to curate this canon's resume first"
                            }
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.04] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            <RefreshCw className="w-3 h-3" />
                            Re-render
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
                            onClick={() => setPickingJob((v) => !v)}
                            disabled={!canon.currentResumeId || anySpecializing}
                            aria-expanded={pickingJob}
                            title={
                                canon.currentResumeId
                                    ? "Re-word this canon's resume for a specific Interested job"
                                    : "Regenerate the base resume first — nothing to specialize yet"
                            }
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-purple-400/30 text-[11px] font-semibold text-purple-100 bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            {specializing ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                                <Sparkles className="w-3 h-3" />
                            )}
                            {specializing ? "Specializing…" : "Specialize…"}
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
            </div>

            {pickingJob && canon.currentResumeId && (
                <SpecializeJobPicker
                    busy={specializing}
                    onPick={(applicationId) => {
                        setPickingJob(false);
                        onSpecialize(applicationId);
                    }}
                    onClose={() => setPickingJob(false)}
                />
            )}
        </div>
    );
};

// ─── Per-canon version-history dropdown (popover-style) ─────────────────────
// Mirrors GenerateResumeCard's PreviousResumesDropdown: a trigger button + a
// portalled popover anchored to the trigger's bounding rect. The portal is
// required because the enclosing CardGrid wrapper has `overflow-hidden` —
// an `absolute`-positioned popover would clip to the card. The query is lazy
// (`enabled: open`) so we only fetch a canon's versions when its dropdown opens.

const CanonVersionsDropdown: React.FC<{
    canonId: string;
    versionCount: number;
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
}> = ({ canonId, versionCount, open, onToggle, onClose }) => {
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    // Lazy fetch — only enabled while the popover is open. `staleTime: 0` +
    // the regenerate-time invalidation keep a freshly-generated version showing
    // when the dropdown is reopened.
    const { data, isLoading, error } = useQuery({
        queryKey: queryKeys.canonVersions(canonId),
        queryFn: () => api.resumes.list({ canonId }),
        enabled: open,
        staleTime: 0,
    });
    const versions = data?.resumes ?? [];

    const recompute = useCallback(() => {
        if (!triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        // Left-anchor to the trigger, clamped so the popover never spills off
        // the right edge of the viewport.
        const width = Math.min(360, window.innerWidth - 16);
        const left = Math.min(rect.left, window.innerWidth - width - 8);
        setPos({ top: rect.bottom + 4, left: Math.max(8, left) });
    }, []);

    // Position on open + reposition on viewport changes so the popover tracks
    // the trigger if the user scrolls the dash or resizes.
    useLayoutEffect(() => {
        if (!open) { setPos(null); return; }
        recompute();
        window.addEventListener("resize", recompute);
        window.addEventListener("scroll", recompute, true);
        return () => {
            window.removeEventListener("resize", recompute);
            window.removeEventListener("scroll", recompute, true);
        };
    }, [open, recompute]);

    // Click-outside checks BOTH the trigger and the portalled popover since
    // they live in different DOM subtrees.
    useEffect(() => {
        if (!open) return;
        function handle(e: MouseEvent) {
            const target = e.target as Node;
            if (triggerRef.current?.contains(target)) return;
            if (popoverRef.current?.contains(target)) return;
            onClose();
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [open, onClose]);

    function handleDownload(id: string) {
        window.open(`/api/resumes/${encodeURIComponent(id)}/download`, "_blank");
    }

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={onToggle}
                className="inline-flex items-center gap-1 text-[10px] text-purple-300/80 hover:text-purple-200 transition-colors"
                title="View and download prior versions"
            >
                <History className="w-2.5 h-2.5" />
                <span>{versionCount} version{versionCount === 1 ? "" : "s"}</span>
                <ChevronDown className={`w-2.5 h-2.5 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && pos && typeof document !== "undefined" && createPortal(
                <div
                    ref={popoverRef}
                    className="fixed z-50 w-[22rem] max-w-[90vw] rounded-lg bg-slate-900/95 backdrop-blur border border-white/10 shadow-xl"
                    style={{ top: pos.top, left: pos.left }}
                >
                    {isLoading ? (
                        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-white/40">
                            <Loader2 className="w-3 h-3 animate-spin" /> Loading versions…
                        </div>
                    ) : error ? (
                        <div className="px-3 py-2 text-[11px] text-rose-200">
                            Failed to load: {errMessage(error)}
                        </div>
                    ) : versions.length === 0 ? (
                        <div className="px-3 py-3 text-[11px] text-white/40">No versions yet.</div>
                    ) : (
                        <div className="max-h-[20rem] overflow-y-auto custom-scrollbar divide-y divide-white/5">
                            {versions.map((v) => (
                                <button
                                    key={v.id}
                                    type="button"
                                    onClick={() => { handleDownload(v.id); onClose(); }}
                                    disabled={!v.hasArtifact}
                                    title={v.hasArtifact ? "Download this version" : "No file for this version"}
                                    className="w-full text-left px-3 py-2 hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-start gap-3"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs text-white/90 font-semibold">
                                            v{v.canonVersion ?? "?"}
                                        </div>
                                        <div className="text-[10px] text-white/40 mt-0.5">
                                            {formatRelative(v.createdAt)}
                                        </div>
                                    </div>
                                    <span className="mt-0.5 text-[10px] uppercase tracking-wide text-purple-300/80 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded flex-shrink-0">
                                        {v.format}
                                    </span>
                                    <Download className="mt-1 w-3 h-3 text-white/40 flex-shrink-0" />
                                </button>
                            ))}
                        </div>
                    )}
                </div>,
                document.body,
            )}
        </>
    );
};

// ─── Specialize-for-a-job picker (Interested apps) ──────────────────────────
// The pipeline-picker endpoint already filters server-side to INTERESTED apps
// that carry a posting URL, so every returned item is eligible to specialize.

const SpecializeJobPicker: React.FC<{
    busy: boolean;
    onPick: (applicationId: string) => void;
    onClose: () => void;
}> = ({ busy, onPick, onClose }) => {
    const { data, isLoading, error } = useQuery({
        queryKey: queryKeys.pipelinePicker,
        queryFn: () => api.applications.pipelinePicker(),
    });
    const items = data?.items ?? [];

    return (
        <div className="mt-2 rounded-lg bg-purple-500/[0.04] border border-purple-400/20 p-2">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-wide text-purple-200/70">
                    Specialize for an Interested job
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 transition-colors"
                >
                    <X className="w-3 h-3" />
                </button>
            </div>

            {isLoading ? (
                <div className="flex items-center gap-2 px-3 py-3 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/40">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading interested applications…
                </div>
            ) : error ? (
                <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-400/30 text-[11px] text-rose-200">
                    Failed to load: {errMessage(error)}
                </div>
            ) : items.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-3 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/40">
                    <Search className="w-3.5 h-3.5 shrink-0" />
                    <span>
                        No Interested applications with a posting URL yet. Track a posting from the
                        New Postings feed to specialize this resume for it.
                    </span>
                </div>
            ) : (
                <div className="max-h-[12rem] overflow-y-auto custom-scrollbar rounded-lg bg-black/40 border border-white/10 divide-y divide-white/5">
                    {items.map((it) => {
                        let host = "";
                        try {
                            host = new URL(it.postingUrl).host;
                        } catch {
                            host = it.postingUrl;
                        }
                        return (
                            <button
                                key={it.id}
                                type="button"
                                onClick={() => onPick(it.id)}
                                disabled={busy}
                                className={[
                                    "w-full text-left px-3 py-2 transition-colors",
                                    busy ? "opacity-50 cursor-not-allowed" : "hover:bg-white/[0.03] cursor-pointer",
                                ].join(" ")}
                            >
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-semibold text-white/90 truncate">{it.company}</span>
                                    <span className="text-white/30">·</span>
                                    <span className="text-xs text-white/70 truncate">
                                        {it.postingTitle || it.role || "—"}
                                    </span>
                                    <span
                                        className={`text-[9px] uppercase tracking-wide px-1 rounded ${TRACK_PILL_CLASSES[it.track] ?? TRACK_PILL_FALLBACK}`}
                                    >
                                        {it.track}
                                    </span>
                                </div>
                                <div className="text-[10px] text-white/30 truncate mt-0.5">{host}</div>
                            </button>
                        );
                    })}
                </div>
            )}
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
                placeholder="security officer, mall patrol, access control"
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
                placeholder="security officer, mall patrol, access control"
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
