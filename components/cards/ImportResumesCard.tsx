"use client";
import React, { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload, FileText, FilePlus, X } from "lucide-react";
import { toastStore } from "@/lib/toast-store";
import { queryKeys } from "@/lib/api-client";
import { Card } from "../ui/Card";

interface PerFileCounts {
    workRolesAdded: number;
    workRolesMerged: number;
    workRolesDroppedNoStartDate?: number;
    workRolesFoldedIntoProjects?: number;
    projectsAdded: number;
    projectsMerged: number;
    educationAdded: number;
    educationMerged: number;
    bulletsAdded: number;
    bulletsDeduped: number;
    headerFieldsFilled: number;
}

interface ImportResult {
    counts: PerFileCounts;
    perFile: { filename: string; counts: PerFileCounts }[];
}

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/json";

// Mirror of `MAX_FILES` in `app/api/profile/import/route.ts`. Kept in sync by
// convention — if the server cap moves, bump this. Better to reject in the UI
// than to make the user wait through a failed upload.
const MAX_FILES = 8;

export function ImportResumesCard() {
    const queryClient = useQueryClient();
    const fileInput = useRef<HTMLInputElement>(null);
    const [files, setFiles] = useState<File[]>([]);
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [lastResult, setLastResult] = useState<ImportResult | null>(null);

    function addFiles(incoming: FileList | File[] | null) {
        if (!incoming) return;
        const list = Array.from(incoming).filter(f => f.size > 0);
        setFiles(prev => {
            const seen = new Set(prev.map(f => `${f.name}:${f.size}`));
            const out = [...prev];
            let dropped = 0;
            for (const f of list) {
                const key = `${f.name}:${f.size}`;
                if (seen.has(key)) continue;
                if (out.length >= MAX_FILES) { dropped++; continue; }
                out.push(f);
                seen.add(key);
            }
            if (dropped > 0) {
                toastStore.push({
                    message: `Import is capped at ${MAX_FILES} files; ${dropped} skipped.`,
                    type: "warning",
                });
            }
            return out;
        });
    }

    function removeFile(idx: number) {
        setFiles(prev => prev.filter((_, i) => i !== idx));
    }

    async function handleImport() {
        if (files.length === 0 || busy) return;
        setBusy(true);
        try {
            const fd = new FormData();
            for (const f of files) fd.append("files", f);
            const res = await fetch("/api/profile/import", { method: "POST", body: fd });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const stage = body.stage ? `[${body.stage}] ` : "";
                throw new Error(`${stage}${body.error ?? `HTTP ${res.status}`}`);
            }
            setLastResult({ counts: body.counts, perFile: body.perFile });
            await queryClient.invalidateQueries({ queryKey: queryKeys.profile });
            const c = body.counts as PerFileCounts;
            const summary = [
                c.workRolesAdded ? `${c.workRolesAdded} roles` : null,
                c.projectsAdded ? `${c.projectsAdded} projects` : null,
                c.educationAdded ? `${c.educationAdded} edu` : null,
                c.bulletsAdded ? `${c.bulletsAdded} bullets` : null,
            ].filter(Boolean).join(", ");
            toastStore.push({ message: `Imported: ${summary || "no new items (everything deduped)"}`, type: "info" });
            // Surface roles dropped because the LLM couldn't infer a startDate —
            // otherwise the user wonders why half their resume is missing.
            const dropped = c.workRolesDroppedNoStartDate ?? 0;
            if (dropped > 0) {
                toastStore.push({
                    message: `${dropped} work role${dropped === 1 ? "" : "s"} skipped — couldn't read a start date. Add manually.`,
                    type: "warning",
                });
            }
            // Surface cross-category folds so the user knows we caught
            // misclassifications (student-org / personal-project entries that
            // the source resume formatted like a job).
            const folded = c.workRolesFoldedIntoProjects ?? 0;
            if (folded > 0) {
                toastStore.push({
                    message: `${folded} entr${folded === 1 ? "y" : "ies"} reclassified from work role to project (student org / personal project).`,
                    type: "info",
                });
            }
            setFiles([]);
        } catch (e) {
            toastStore.push({ message: `Import failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card
            title="Import resumes (append, never overwrite)"
            icon={FilePlus}
            iconColorClass="text-cyan-300"
        >
            <p className="text-xs text-white/50 mb-3">
                Drop one or many resumes (PDF, DOCX, TXT, JSON). Each file is parsed by an LLM and merged into
                your profile repository — duplicate roles and bullets are de-duped against what you already have.
            </p>

            <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    addFiles(e.dataTransfer.files);
                }}
                onClick={() => !busy && fileInput.current?.click()}
                className={[
                    "rounded-lg border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-colors",
                    dragOver ? "border-cyan-300 bg-cyan-400/10" : "border-white/15 hover:border-cyan-400/40",
                    busy ? "opacity-50 pointer-events-none" : "",
                ].join(" ")}
            >
                <Upload className="w-5 h-5 text-white/40 mx-auto mb-1.5" />
                <div className="text-xs text-white/60">
                    Drop files here, or click to browse
                </div>
                <div className="text-[10px] text-white/30 mt-0.5">PDF · DOCX · TXT · JSON</div>
            </div>
            <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
            />

            {files.length > 0 && (
                <ul className="mt-3 space-y-1">
                    {files.map((f, i) => (
                        <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded-md bg-black/30 border border-white/10 px-2.5 py-1.5">
                            <span className="flex items-center gap-2 text-xs text-white/70 min-w-0">
                                <FileText className="w-3.5 h-3.5 text-white/40 shrink-0" />
                                <span className="truncate">{f.name}</span>
                                <span className="text-[10px] text-white/30 shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                            </span>
                            <button
                                onClick={() => removeFile(i)}
                                disabled={busy}
                                className="text-white/30 hover:text-white/70 disabled:opacity-40"
                                aria-label={`Remove ${f.name}`}
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-3 flex items-center gap-3">
                <button
                    onClick={handleImport}
                    disabled={files.length === 0 || busy}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 text-xs font-semibold text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    {busy ? "Importing…" : `Append ${files.length} ${files.length === 1 ? "file" : "files"} to repository`}
                </button>
            </div>

            {lastResult && (
                <div className="mt-3 rounded-md bg-black/30 border border-white/10 px-3 py-2 text-xs text-white/70 space-y-1">
                    <div className="font-semibold text-white/80">Last import:</div>
                    <div>
                        +{lastResult.counts.workRolesAdded} roles · +{lastResult.counts.projectsAdded} projects · +{lastResult.counts.educationAdded} education · +{lastResult.counts.bulletsAdded} bullets · {lastResult.counts.bulletsDeduped} dedup&apos;d
                    </div>
                    {lastResult.perFile.length > 1 && (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-white/50">
                            {lastResult.perFile.map(p => (
                                <li key={p.filename}>
                                    <span className="text-white/70">{p.filename}:</span> +{p.counts.workRolesAdded}/{p.counts.workRolesMerged} roles · +{p.counts.bulletsAdded}/{p.counts.bulletsDeduped} bullets
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </Card>
    );
}
