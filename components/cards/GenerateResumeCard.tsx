"use client";
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
    FileText,
    FileType2,
    Loader2,
    Link as LinkIcon,
    ChevronDown,
    ChevronRight,
    Briefcase,
    Pencil,
    History,
    Download,
    Search,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toastStore } from "@/lib/toast-store";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { Card } from "../ui/Card";

type Format = "pdf" | "docx";
type InputMode = "pipeline" | "url" | "paste";

interface GenerateResult {
    id: string | null;
    url: string;
    filename: string;
    title: string | null;
    company: string | null;
    format: Format;
}

interface SelectionRow {
    kind: string;
    sourceId: string;
    sourceLabel: string;
    bulletId: string;
    originalText: string;
    rewrittenText: string;
    score: number;
    matchedTags: string[];
    matchedKeywords: string[];
    locked: boolean;
}

const FORMAT_STORAGE_KEY = "mc-resume-format";

// Human-readable labels for the API route's internal `stage` values. The
// stage field comes from app/api/resumes/route.ts — keep this map in sync
// if new stages get added there.
const STAGE_LABELS = {
    input: "Bad input",
    load: "Loading your profile",
    parse: "Reading the posting",
    select: "Picking bullets",
    rewrite: "Rewriting bullets via AI",
    render: "Rendering the file",
} as const;

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

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

export function GenerateResumeCard() {
    const queryClient = useQueryClient();
    const [inputMode, setInputMode] = useState<InputMode>("pipeline");
    const [url, setUrl] = useState("");
    const [text, setText] = useState("");
    const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);
    const [format, setFormat] = useState<Format>(() => {
        try {
            const saved = window.localStorage.getItem(FORMAT_STORAGE_KEY);
            if (saved === "pdf" || saved === "docx") return saved;
        } catch { /* localStorage unavailable */ }
        return "pdf";
    });
    const [busy, setBusy] = useState(false);
    const [stage, setStage] = useState<string | null>(null);
    const [lastResult, setLastResult] = useState<GenerateResult | null>(null);
    const [showTrace, setShowTrace] = useState(false);
    const [showHistory, setShowHistory] = useState(false);

    // Traceability (M8-2.3) — full row for "Why these bullets?".
    const traceQuery = useQuery({
        queryKey: queryKeys.resume(lastResult?.id ?? ""),
        queryFn: () => api.resumes.get(lastResult!.id!),
        enabled: showTrace && !!lastResult?.id,
    });

    // M8.4.6 — global previous-resumes list, drives the dropdown.
    const resumesQuery = useQuery({
        queryKey: queryKeys.resumes(),
        queryFn: () => api.resumes.list({ limit: 100 }),
    });
    const recentResumes = resumesQuery.data?.resumes ?? [];

    // M8.4.9 — SSE-driven auto-refresh after a generate. Invalidates the list
    // query so the dropdown picks up the new row without a remount.
    const invalidateResumes = useCallback(
        () => queryClient.invalidateQueries({ queryKey: queryKeys.resumes() }),
        [queryClient],
    );
    useServerEvents("GeneratedResume", invalidateResumes);

    function pickFormat(f: Format) {
        setFormat(f);
        try { window.localStorage.setItem(FORMAT_STORAGE_KEY, f); } catch { /* noop */ }
    }

    const hasInput =
        inputMode === "pipeline" ? !!selectedApplicationId :
        inputMode === "url" ? url.trim().length > 0 :
        text.trim().length > 0;
    const canSubmit = !busy && hasInput;

    async function handleGenerate() {
        if (!canSubmit) return;
        setBusy(true);
        setStage("Generating…");
        try {
            const postingBody =
                inputMode === "pipeline" ? { applicationId: selectedApplicationId } :
                inputMode === "url" ? { url: url.trim() } :
                { text: text.trim() };

            const res = await fetch("/api/resumes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ posting: postingBody, options: { format } }),
            });
            if (!res.ok) {
                let detail = "";
                let stageLabel = "";
                try {
                    const j = await res.json();
                    detail = j.error ? (typeof j.error === "string" ? j.error : JSON.stringify(j.error)) : "";
                    stageLabel = STAGE_LABELS[j.stage as keyof typeof STAGE_LABELS] ?? "";
                } catch { /* non-JSON */ }
                const composed = stageLabel ? `${stageLabel}: ${detail}` : detail || `HTTP ${res.status}`;
                throw new Error(composed);
            }
            const blob = await res.blob();
            const responseFormat = (res.headers.get("X-Resume-Format") as Format | null) ?? format;
            const filename = (() => {
                const cd = res.headers.get("Content-Disposition") ?? "";
                const m = cd.match(/filename="([^"]+)"/);
                return m?.[1] ?? `resume.${responseFormat}`;
            })();
            const objectUrl = URL.createObjectURL(blob);
            setLastResult({
                id: res.headers.get("X-Resume-Id"),
                url: objectUrl,
                filename,
                title: res.headers.get("X-Resume-Title"),
                company: res.headers.get("X-Resume-Company"),
                format: responseFormat,
            });
            setShowTrace(false);
            if (responseFormat === "pdf") {
                window.open(objectUrl, "_blank");
            } else {
                const a = document.createElement("a");
                a.href = objectUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
            toastStore.push({ message: `Resume generated (${responseFormat.toUpperCase()})`, type: "info" });
        } catch (e) {
            toastStore.push({ message: `Generate failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusy(false);
            setStage(null);
        }
    }

    return (
        <Card
            title="Generate tailored resume"
            icon={FileText}
            iconColorClass="text-purple-300"
        >
            <p className="text-xs text-white/50 mb-3">
                Pick an Interested-column application, paste a posting URL, or paste posting text.
                I&apos;ll pick the relevant bullets from your profile, rewrite them to emphasize what the posting cares about, and hand back a PDF or DOCX.
            </p>

            {/* M8.4.8 — Pipeline / URL / Paste segmented control. */}
            <InputModeTabs mode={inputMode} onChange={setInputMode} disabled={busy} />

            <div className="mt-3">
                {inputMode === "pipeline" && (
                    <InterestedAppPicker
                        selectedApplicationId={selectedApplicationId}
                        onSelect={setSelectedApplicationId}
                        disabled={busy}
                    />
                )}
                {inputMode === "url" && (
                    <>
                        <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">Posting URL</label>
                        <div className="relative">
                            <LinkIcon className="w-3.5 h-3.5 text-white/30 absolute left-2.5 top-2.5" />
                            <input
                                type="url"
                                placeholder="https://example.com/jobs/12345"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                disabled={busy}
                                className="w-full pl-8 pr-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40"
                            />
                        </div>
                    </>
                )}
                {inputMode === "paste" && (
                    <>
                        <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">Posting text</label>
                        <textarea
                            placeholder="Paste the listing's full description here…"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            disabled={busy}
                            rows={6}
                            className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40 resize-y"
                        />
                    </>
                )}
            </div>

            <div className="mt-3 flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-lg overflow-hidden border border-white/10 bg-black/40" role="group" aria-label="Output format">
                    {(["pdf", "docx"] as const).map(f => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => pickFormat(f)}
                            disabled={busy}
                            aria-pressed={format === f}
                            className={[
                                "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center gap-1.5",
                                format === f
                                    ? "bg-purple-500/30 text-purple-100"
                                    : "text-white/50 hover:text-white/80",
                                busy ? "opacity-40 cursor-not-allowed" : "",
                            ].join(" ")}
                        >
                            {f === "pdf" ? <FileText className="w-3 h-3" /> : <FileType2 className="w-3 h-3" />}
                            {f}
                        </button>
                    ))}
                </div>
                <button
                    onClick={handleGenerate}
                    disabled={!canSubmit}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-xs font-semibold text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                    {busy ? (stage ?? "Working…") : `Generate ${format.toUpperCase()}`}
                </button>

                {/* M8.4.6 — Previous resumes dropdown. Hidden when archive empty. */}
                {recentResumes.length > 0 && (
                    <PreviousResumesDropdown
                        open={showHistory}
                        onToggle={() => setShowHistory(s => !s)}
                        onClose={() => setShowHistory(false)}
                        resumes={recentResumes}
                    />
                )}
            </div>

            {lastResult?.id && (
                <div className="mt-3 space-y-2">
                    <div>
                        <button
                            type="button"
                            onClick={() => setShowTrace(s => !s)}
                            className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80 transition-colors"
                        >
                            {showTrace ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            Why these bullets?
                        </button>
                        {showTrace && (
                            <div className="mt-2 rounded-lg bg-black/30 border border-white/10 px-3 py-2 max-h-[24rem] overflow-y-auto">
                                {traceQuery.isLoading ? (
                                    <div className="flex items-center gap-2 text-[11px] text-white/40">
                                        <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                                    </div>
                                ) : traceQuery.error ? (
                                    <div className="text-[11px] text-red-300/80">Failed to load: {errMessage(traceQuery.error)}</div>
                                ) : traceQuery.data ? (
                                    <TraceList selections={(traceQuery.data.resume.selections as SelectionRow[]) ?? []} />
                                ) : null}
                            </div>
                        )}
                    </div>
                    {traceQuery.data && (
                        <SkillsGapBlock gap={(traceQuery.data.resume.skillsGap as string[] | undefined) ?? []} />
                    )}
                </div>
            )}
        </Card>
    );
}

// ─── M8.4.8 — Segmented input-mode control ──────────────────────────────────

const TAB_DEFS: Array<{ id: InputMode; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: "pipeline", label: "Pipeline", icon: Briefcase },
    { id: "url", label: "URL", icon: LinkIcon },
    { id: "paste", label: "Paste", icon: Pencil },
];

const InputModeTabs: React.FC<{
    mode: InputMode;
    onChange: (m: InputMode) => void;
    disabled: boolean;
}> = ({ mode, onChange, disabled }) => (
    // `self-start` keeps the segmented control hugging its content inside the
    // Card's `flex flex-col` parent. Without it the default `align-items:
    // stretch` blows the `inline-flex` out to full card width and the buttons
    // clump on the left with empty space trailing right.
    <div className="self-start inline-flex rounded-lg overflow-hidden border border-white/10 bg-black/40" role="group" aria-label="Posting source">
        {TAB_DEFS.map(t => {
            const active = mode === t.id;
            const Icon = t.icon;
            return (
                <button
                    key={t.id}
                    type="button"
                    onClick={() => onChange(t.id)}
                    disabled={disabled}
                    aria-pressed={active}
                    className={[
                        "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center gap-1.5",
                        active ? "bg-purple-500/30 text-purple-100" : "text-white/50 hover:text-white/80",
                        disabled ? "opacity-40 cursor-not-allowed" : "",
                    ].join(" ")}
                >
                    <Icon className="w-3 h-3" />
                    {t.label}
                </button>
            );
        })}
    </div>
);

// ─── M8.4.7 — Pipeline picker: single-select list of INTERESTED apps ────────

type TrackFilter = "all" | "career" | "side";

const TRACK_FILTER_DEFS: Array<{ id: TrackFilter; label: string }> = [
    { id: "all", label: "Both" },
    { id: "career", label: "Career" },
    { id: "side", label: "Side" },
];

const InterestedAppPicker: React.FC<{
    selectedApplicationId: string | null;
    onSelect: (id: string | null) => void;
    disabled: boolean;
}> = ({ selectedApplicationId, onSelect, disabled }) => {
    const [trackFilter, setTrackFilter] = useState<TrackFilter>("all");
    const { data, isLoading, error } = useQuery({
        queryKey: queryKeys.pipelinePicker,
        queryFn: () => api.applications.pipelinePicker(),
    });
    const allItems = data?.items ?? [];
    const items = trackFilter === "all"
        ? allItems
        : allItems.filter(it => it.track === trackFilter);

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-4 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/40">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading interested applications…
            </div>
        );
    }
    if (error) {
        return (
            <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-400/30 text-[11px] text-rose-200">
                Failed to load: {errMessage(error)}
            </div>
        );
    }
    if (allItems.length === 0) {
        return (
            <div className="flex items-center gap-2 px-3 py-4 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/40">
                <Search className="w-3.5 h-3.5" />
                <span>
                    No Interested-column applications with a posting URL yet.
                    Track a posting from the New Postings feed to add one here.
                </span>
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-2">
            {/* Track filter — same chrome as the Pipeline/URL/Paste tabs and the
                PDF/DOCX format selector so the card has one consistent
                segmented-control vocabulary. */}
            <div className="self-start inline-flex rounded-lg overflow-hidden border border-white/10 bg-black/40" role="group" aria-label="Track filter">
                {TRACK_FILTER_DEFS.map(t => {
                    const active = trackFilter === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => setTrackFilter(t.id)}
                            disabled={disabled}
                            aria-pressed={active}
                            className={[
                                "px-3 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                                active ? "bg-purple-500/30 text-purple-100" : "text-white/50 hover:text-white/80",
                                disabled ? "opacity-40 cursor-not-allowed" : "",
                            ].join(" ")}
                        >
                            {t.label}
                        </button>
                    );
                })}
            </div>
            {items.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-4 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/40">
                    <Search className="w-3.5 h-3.5" />
                    <span>
                        No {trackFilter === "career" ? "career-track" : "side-track"} Interested apps with a posting URL. Switch the filter, or track one from the New Postings feed.
                    </span>
                </div>
            ) : (
                <div className="max-h-[14rem] overflow-y-auto rounded-lg bg-black/40 border border-white/10 divide-y divide-white/5">
                    {items.map(it => {
                        const active = selectedApplicationId === it.id;
                        let host = "";
                        try { host = new URL(it.postingUrl).host; } catch { host = it.postingUrl; }
                        return (
                            <button
                                key={it.id}
                                type="button"
                                onClick={() => onSelect(active ? null : it.id)}
                                disabled={disabled}
                                aria-pressed={active}
                                className={[
                                    "w-full text-left px-3 py-2 transition-colors",
                                    active ? "bg-purple-500/15 border-l-2 border-purple-400/60" : "hover:bg-white/[0.03]",
                                    disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                                ].join(" ")}
                            >
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-semibold text-white/90 truncate">{it.company}</span>
                                    <span className="text-white/30">·</span>
                                    <span className="text-xs text-white/70 truncate">{it.postingTitle || it.role || "—"}</span>
                                    <span className="text-[9px] uppercase tracking-wide text-white/40 bg-white/[0.04] border border-white/10 px-1 rounded">
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

// ─── M8.4.6 — Previous-resumes dropdown (popover-style) ─────────────────────

interface PreviousResumeRow {
    id: string;
    createdAt: string;
    format: string;
    status: string;
    hasArtifact: boolean;
    postingTitle: string | null;
    postingCompany: string | null;
}

const PreviousResumesDropdown: React.FC<{
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
    resumes: PreviousResumeRow[];
}> = ({ open, onToggle, onClose, resumes }) => {
    // The popover is portalled to <body> because the enclosing CardGrid
    // wrapper has `overflow-hidden` (load-bearing for `rounded-lg` corner
    // clipping). An `absolute`-positioned popover gets clipped to the card.
    // Fixed positioning + portal lets it escape; we anchor to the trigger
    // button's bounding rect on each open / window resize / window scroll.
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

    const recompute = useCallback(() => {
        if (!triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        setPos({
            top: rect.bottom + 4,
            right: Math.max(8, window.innerWidth - rect.right),
        });
    }, []);

    // Position on open + reposition on viewport changes so the popover
    // tracks the trigger if the user scrolls the dash or resizes.
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

    // Click-outside has to check BOTH the trigger and the portalled popover
    // since they're no longer in the same DOM subtree.
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
        // /api/resumes/[id]/download is the existing M8-2.4 endpoint —
        // streams the artifact bytes with the right Content-Disposition.
        window.open(`/api/resumes/${encodeURIComponent(id)}/download`, "_blank");
    }

    const visible = resumes.slice(0, 20);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={onToggle}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.04] border border-white/10 transition-colors"
            >
                <History className="w-3 h-3" />
                <span>Recent resumes ({resumes.length})</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && pos && typeof document !== "undefined" && createPortal(
                <div
                    ref={popoverRef}
                    className="fixed z-50 w-[26rem] max-w-[90vw] rounded-lg bg-slate-900/95 backdrop-blur border border-white/10 shadow-xl"
                    style={{ top: pos.top, right: pos.right }}
                >
                    <div className="max-h-[20rem] overflow-y-auto divide-y divide-white/5">
                        {visible.map(r => (
                            <button
                                key={r.id}
                                type="button"
                                onClick={() => { handleDownload(r.id); onClose(); }}
                                disabled={!r.hasArtifact}
                                className="w-full text-left px-3 py-2 hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-3"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 text-xs">
                                        <span className="font-semibold text-white/90 truncate">{r.postingCompany ?? "(unknown)"}</span>
                                        <span className="text-white/30">·</span>
                                        <span className="text-white/70 truncate">{r.postingTitle ?? "(no title)"}</span>
                                    </div>
                                    <div className="text-[10px] text-white/40 mt-0.5">{formatRelative(r.createdAt)}</div>
                                </div>
                                <span className="text-[10px] uppercase tracking-wide text-purple-300/80 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded">
                                    {r.format}
                                </span>
                                <Download className="w-3 h-3 text-white/40 flex-shrink-0" />
                            </button>
                        ))}
                    </div>
                    {resumes.length > visible.length && (
                        <div className="px-3 py-1.5 text-[10px] text-white/40 border-t border-white/5">
                            Showing 20 most recent of {resumes.length}.
                        </div>
                    )}
                </div>,
                document.body,
            )}
        </>
    );
};

// Story S8.8 — surface keywords the posting emphasized that the profile has
// no evidence for. Posting keywords that are *covered* aren't shown — those
// are visible per-bullet in the trace via `tag:` / `kw:` chips above.
const SkillsGapBlock: React.FC<{ gap: string[] }> = ({ gap }) => {
    const [expanded, setExpanded] = useState(false);
    if (gap.length === 0) {
        return (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-300/70">
                <span aria-hidden>●</span>
                <span>No skills gap — every posting keyword has coverage in your profile.</span>
            </div>
        );
    }
    return (
        <div>
            <button
                type="button"
                onClick={() => setExpanded(s => !s)}
                className="flex items-center gap-1 text-[11px] text-amber-300/80 hover:text-amber-200 transition-colors"
            >
                {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Skills gap — {gap.length} posting keyword{gap.length === 1 ? "" : "s"} uncovered
            </button>
            {expanded && (
                <div className="mt-2 rounded-lg bg-amber-500/[0.04] border border-amber-500/20 px-3 py-2">
                    <p className="text-[10px] text-white/40 mb-1.5">
                        These terms appeared in the posting but don&apos;t match any of your bullet tags or substring of your bullet text. Consider addressing them in a cover letter or adding evidence to your profile.
                    </p>
                    <div className="flex flex-wrap gap-1">
                        {gap.map(g => (
                            <span key={g} className="text-[10px] text-amber-200 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                                {g}
                            </span>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

const TraceList: React.FC<{ selections: SelectionRow[] }> = ({ selections }) => {
    if (selections.length === 0) {
        return <div className="text-[11px] text-white/40 italic">No selections recorded.</div>;
    }
    return (
        <ul className="space-y-2.5">
            {selections.map(s => {
                const changed = s.rewrittenText !== s.originalText;
                return (
                    <li key={s.bulletId} className="text-[11px]">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="uppercase tracking-wide text-purple-300/80 text-[10px]">{s.kind}</span>
                            <span className="text-white/70 truncate">{s.sourceLabel}</span>
                            {s.locked && (
                                <span className="text-[10px] text-amber-300/80 bg-amber-500/10 border border-amber-500/20 px-1 rounded">locked</span>
                            )}
                            <span className="text-white/30">score {Number.isFinite(s.score) ? s.score : "∞"}</span>
                        </div>
                        {changed ? (
                            <div className="space-y-1 ml-1">
                                <div className="text-white/40 line-through">{s.originalText}</div>
                                <div className="text-white/90">{s.rewrittenText}</div>
                            </div>
                        ) : (
                            <div className="text-white/80 ml-1">{s.originalText}</div>
                        )}
                        {(s.matchedTags.length > 0 || s.matchedKeywords.length > 0) && (
                            <div className="mt-1 ml-1 flex flex-wrap gap-1">
                                {s.matchedTags.map(t => (
                                    <span key={`t-${t}`} className="text-[10px] text-cyan-300/80 bg-cyan-500/10 border border-cyan-500/20 px-1.5 rounded">
                                        tag:{t}
                                    </span>
                                ))}
                                {s.matchedKeywords.map(k => (
                                    <span key={`k-${k}`} className="text-[10px] text-purple-300/80 bg-purple-500/10 border border-purple-500/20 px-1.5 rounded">
                                        kw:{k}
                                    </span>
                                ))}
                            </div>
                        )}
                    </li>
                );
            })}
        </ul>
    );
};
