"use client";
import React, { useState } from "react";
import { X, Plus, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";

interface AddWatchlistModalProps {
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
}

type Kind = "greenhouse" | "careers-page";

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export const AddWatchlistModal: React.FC<AddWatchlistModalProps> = ({ open, onClose, onCreated }) => {
    const [kind, setKind] = useState<Kind>("greenhouse");
    const [name, setName] = useState("");
    const [companyName, setCompanyName] = useState("");
    const [boardSlug, setBoardSlug] = useState("");
    const [rootUrl, setRootUrl] = useState("");
    const [linkPattern, setLinkPattern] = useState("/careers/(positions|jobs)/");
    const [scheduleMinutes, setScheduleMinutes] = useState(30);
    const [submitting, setSubmitting] = useState(false);

    if (!open) return null;

    function reset() {
        setKind("greenhouse");
        setName("");
        setCompanyName("");
        setBoardSlug("");
        setRootUrl("");
        setLinkPattern("/careers/(positions|jobs)/");
        setScheduleMinutes(30);
    }

    function handleClose() {
        if (submitting) return;
        reset();
        onClose();
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        if (!name.trim() || !companyName.trim()) return;
        if (kind === "greenhouse" && !boardSlug.trim()) return;
        if (kind === "careers-page" && (!rootUrl.trim() || !linkPattern.trim())) return;

        setSubmitting(true);
        try {
            const config = kind === "greenhouse"
                ? { kind: "greenhouse" as const, boardSlug: boardSlug.trim(), companyName: companyName.trim() }
                : { kind: "careers-page" as const, rootUrl: rootUrl.trim(), linkPattern: linkPattern.trim(), companyName: companyName.trim() };
            await api.watchlists.create({
                name: name.trim(),
                config,
                scheduleMinutes,
            });
            toastStore.push({ message: `Watchlist created: ${name.trim()}`, type: "info" });
            onCreated();
            reset();
            onClose();
        } catch (err) {
            toastStore.push({ message: `Create failed: ${errMessage(err)}`, type: "error" });
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={handleClose}>
            <div
                className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <h2 className="text-sm font-semibold text-white">New watchlist</h2>
                    <button onClick={handleClose} className="text-white/40 hover:text-white/80" aria-label="Close">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-3">
                    <label className="text-[11px] uppercase tracking-wide text-white/40">Source</label>
                    <div className="inline-flex rounded-lg overflow-hidden border border-white/10 bg-black/40 w-fit" role="group">
                        {(["greenhouse", "careers-page"] as const).map(k => (
                            <button
                                key={k}
                                type="button"
                                onClick={() => setKind(k)}
                                disabled={submitting}
                                aria-pressed={kind === k}
                                className={[
                                    "px-3 py-1.5 text-[11px] font-semibold transition-colors",
                                    kind === k ? "bg-cyan-500/30 text-cyan-100" : "text-white/50 hover:text-white/80",
                                ].join(" ")}
                            >
                                {k}
                            </button>
                        ))}
                    </div>

                    <label className="text-[11px] uppercase tracking-wide text-white/40">Name</label>
                    <input
                        type="text"
                        placeholder="e.g. Anthropic — Engineering roles"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={submitting}
                        className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                    />

                    <label className="text-[11px] uppercase tracking-wide text-white/40">Company name</label>
                    <input
                        type="text"
                        placeholder="Anthropic"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                        disabled={submitting}
                        className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                    />

                    {kind === "greenhouse" ? (
                        <>
                            <label className="text-[11px] uppercase tracking-wide text-white/40">Greenhouse board slug</label>
                            <input
                                type="text"
                                placeholder="anthropic"
                                value={boardSlug}
                                onChange={(e) => setBoardSlug(e.target.value)}
                                disabled={submitting}
                                className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                            />
                            <p className="text-[10px] text-white/40 -mt-1">
                                The bit before <code>.greenhouse.io</code> on their job board — e.g. <code>anthropic</code> for <code>boards.greenhouse.io/anthropic</code>.
                            </p>
                        </>
                    ) : (
                        <>
                            <label className="text-[11px] uppercase tracking-wide text-white/40">Careers page URL</label>
                            <input
                                type="url"
                                placeholder="https://example.com/careers"
                                value={rootUrl}
                                onChange={(e) => setRootUrl(e.target.value)}
                                disabled={submitting}
                                className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                            />
                            <label className="text-[11px] uppercase tracking-wide text-white/40">Link pattern (regex)</label>
                            <input
                                type="text"
                                placeholder="/careers/(positions|jobs)/"
                                value={linkPattern}
                                onChange={(e) => setLinkPattern(e.target.value)}
                                disabled={submitting}
                                className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40 font-mono"
                            />
                            <p className="text-[10px] text-white/40 -mt-1">
                                A regex matched against each link&apos;s resolved <code>href</code>. Use the page&apos;s actual job-detail URL shape.
                            </p>
                        </>
                    )}

                    <label className="text-[11px] uppercase tracking-wide text-white/40">Crawl every (minutes)</label>
                    <input
                        type="number"
                        min={5}
                        max={1440}
                        value={scheduleMinutes}
                        onChange={(e) => setScheduleMinutes(Math.max(5, Math.min(1440, parseInt(e.target.value, 10) || 30)))}
                        disabled={submitting}
                        className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white focus:outline-none focus:border-cyan-400/40 w-24"
                    />

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
                            disabled={submitting || !name.trim() || !companyName.trim()}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/30 hover:bg-cyan-500/40 border border-cyan-400/40 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                            {submitting ? "Creating…" : "Create"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
