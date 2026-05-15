"use client";
import React, { useState } from "react";
import { FileText, Loader2, Link as LinkIcon } from "lucide-react";
import { toastStore } from "@/lib/toast-store";

interface GenerateResult {
    url: string;
    filename: string;
    title: string | null;
    company: string | null;
}

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function GenerateResumeCard() {
    const [url, setUrl] = useState("");
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [stage, setStage] = useState<string | null>(null);
    const [lastResult, setLastResult] = useState<GenerateResult | null>(null);

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
                }),
            });
            if (!res.ok) {
                let detail = "";
                try {
                    const j = await res.json();
                    detail = j.error ? (typeof j.error === "string" ? j.error : JSON.stringify(j.error)) : "";
                    if (j.stage) detail = `[${j.stage}] ${detail}`;
                } catch { /* non-JSON */ }
                throw new Error(detail || `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const filename = (() => {
                const cd = res.headers.get("Content-Disposition") ?? "";
                const m = cd.match(/filename="([^"]+)"/);
                return m?.[1] ?? "resume.pdf";
            })();
            const objectUrl = URL.createObjectURL(blob);
            setLastResult({
                url: objectUrl,
                filename,
                title: res.headers.get("X-Resume-Title"),
                company: res.headers.get("X-Resume-Company"),
            });
            window.open(objectUrl, "_blank");
            toastStore.push({ message: "Resume generated", type: "info" });
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
                rewrite them to emphasize what the posting cares about, and hand back a PDF.
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

            <div className="mt-3 flex items-center gap-3">
                <button
                    onClick={handleGenerate}
                    disabled={!canSubmit}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-xs font-semibold text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                    {busy ? (stage ?? "Working…") : "Generate"}
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
        </div>
    );
}
