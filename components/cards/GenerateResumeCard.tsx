"use client";
import React, { useState } from "react";
import { FileText, FileType2, Loader2, Link as LinkIcon, ChevronDown, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toastStore } from "@/lib/toast-store";
import { api, queryKeys } from "@/lib/api-client";

type Format = "pdf" | "docx";

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

export function GenerateResumeCard() {
    const [url, setUrl] = useState("");
    const [text, setText] = useState("");
    // Lazy init from localStorage so we don't need a useEffect + setState
    // dance (the latter pattern triggers react-compiler's cascading-render
    // warning). Safe at module load because this component is "use client".
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

    // Traceability (M8-2.3): fetch the full row when the user expands "Why these bullets?"
    const traceQuery = useQuery({
        queryKey: queryKeys.resume(lastResult?.id ?? ""),
        queryFn: () => api.resumes.get(lastResult!.id!),
        enabled: showTrace && !!lastResult?.id,
    });

    function pickFormat(f: Format) {
        setFormat(f);
        try { window.localStorage.setItem(FORMAT_STORAGE_KEY, f); } catch { /* noop */ }
    }

    const canSubmit = !busy && (url.trim().length > 0 || text.trim().length > 0);

    async function handleGenerate() {
        if (!canSubmit) return;
        setBusy(true);
        setStage("Generating…");
        try {
            const res = await fetch("/api/resumes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    posting: {
                        url: url.trim().length > 0 ? url.trim() : undefined,
                        text: text.trim().length > 0 ? text.trim() : undefined,
                    },
                    options: { format },
                }),
            });
            if (!res.ok) {
                let detail = "";
                let stageLabel = "";
                try {
                    const j = await res.json();
                    detail = j.error ? (typeof j.error === "string" ? j.error : JSON.stringify(j.error)) : "";
                    // Translate the API's internal `stage` field into something the
                    // user understands — "rewrite" means nothing to them, "AI
                    // rewrite step" does.
                    stageLabel = STAGE_LABELS[j.stage as keyof typeof STAGE_LABELS] ?? "";
                } catch { /* non-JSON */ }
                const composed = stageLabel
                    ? `${stageLabel}: ${detail}`
                    : detail || `HTTP ${res.status}`;
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
            // PDFs preview in-browser; DOCX needs a download. Open PDFs in a new tab; trigger download for DOCX.
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
        <div className="rounded-2xl border border-purple-400/20 bg-purple-500/5 p-4">
            <div className="flex items-center gap-2 mb-3">
                <FileText className="w-4 h-4 text-purple-300" />
                <h3 className="text-sm font-semibold text-purple-200">Generate tailored resume</h3>
            </div>
            <p className="text-xs text-white/50 mb-3">
                Paste a job posting (URL or text). I&apos;ll pick the relevant bullets from your profile,
                rewrite them to emphasize what the posting cares about, and hand back a PDF or DOCX.
            </p>

            <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">Posting URL</label>
            <div className="relative mb-3">
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

            <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">
                Or paste posting text
            </label>
            <textarea
                placeholder="Paste the listing's full description here…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
                rows={6}
                className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40 resize-y"
            />

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
                {lastResult && (
                    <a
                        href={lastResult.url}
                        download={lastResult.filename}
                        className="text-xs text-purple-300 hover:text-purple-200 underline underline-offset-2"
                    >
                        Download last: {lastResult.filename}
                    </a>
                )}
            </div>

            {lastResult?.id && (
                <div className="mt-3">
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
            )}
        </div>
    );
}

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
