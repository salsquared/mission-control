"use client";
import React, { useCallback } from "react";
import { Archive, Loader2, Download, Layers, Sparkles } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { buildResumeDisplayLabel } from "@/lib/resumes/labels";
import { Card } from "../../ui/Card";

// Mirrors GenerateResumeCard / CanonsCard relative-time formatting.
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

// Shape of one row from api.resumes.list (general mode).
interface ResumeRow {
    id: string;
    createdAt: string;
    format: string;
    status: string;
    hasArtifact: boolean;
    postingTitle: string | null;
    postingCompany: string | null;
    postingInputSummary: string | null;
    userDisplayName: string | null;
    canonVersion?: number | null;
    isCanonical?: boolean;
}

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// Canon versions: the synthetic posting's title IS the canon name, so
// postingTitle holds it. Append the version.
function canonLabel(r: ResumeRow): string {
    const base = r.postingTitle?.trim() || "Canon resume";
    return r.canonVersion != null ? `${base} · v${r.canonVersion}` : base;
}

// Specialized: a per-job resume (from Generate, or a canon's Specialize) —
// label it by name / role / company like the previous-resumes dropdown.
function specializedLabel(r: ResumeRow): string {
    const canonical = buildResumeDisplayLabel({
        userDisplayName: r.userDisplayName,
        postingTitle: r.postingTitle,
        postingCompany: r.postingCompany,
    });
    if (canonical) return canonical;
    if (r.postingInputSummary?.trim()) return `${r.postingInputSummary} Resume`;
    return "Generated resume";
}

export function GeneratedResumesCard() {
    const queryClient = useQueryClient();

    // Shares the resumes query key with GenerateResumeCard's dropdown, so a
    // generate from either surface refreshes both.
    const { data, isLoading, error } = useQuery({
        queryKey: queryKeys.resumes(),
        queryFn: () => api.resumes.list({ limit: 200 }),
    });
    const resumes: ResumeRow[] = data?.resumes ?? [];

    const invalidate = useCallback(
        () => queryClient.invalidateQueries({ queryKey: queryKeys.resumes() }),
        [queryClient],
    );
    useServerEvents("GeneratedResume", invalidate);

    // isCanonical === true → Canon version; everything else → Specialized
    // (a normal Generate, a URL/Paste generate, or a canon Specialize).
    const canon = resumes.filter((r) => r.isCanonical === true);
    const specialized = resumes.filter((r) => r.isCanonical !== true);

    return (
        <Card title="Generated resumes" icon={Archive} iconColorClass="text-purple-300" loading={isLoading}>
            <p className="text-xs text-white/50 mb-3">
                Every resume you&apos;ve generated, by kind. <strong className="text-purple-200/80">Canon</strong> = a
                role-type&apos;s reusable resume; <strong className="text-purple-200/80">Specialized</strong> = tailored
                to one job (via Generate, or a canon&apos;s Specialize).
            </p>

            {error ? (
                <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-400/30 text-[11px] text-rose-200">
                    Failed to load resumes: {errMessage(error)}
                </div>
            ) : resumes.length === 0 && !isLoading ? (
                <div className="px-3 py-4 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/40">
                    No resumes generated yet. Use Generate (left) or regenerate a canon to create one.
                </div>
            ) : (
                <div className="space-y-4">
                    <ResumeGroup
                        label="Canon"
                        icon={Layers}
                        rows={canon}
                        labelOf={canonLabel}
                        emptyHint="No canon resumes yet — regenerate a canon."
                    />
                    <ResumeGroup
                        label="Specialized"
                        icon={Sparkles}
                        rows={specialized}
                        labelOf={specializedLabel}
                        emptyHint="No specialized resumes yet — use Generate or a canon's Specialize."
                    />
                </div>
            )}
        </Card>
    );
}

// ─── One kind-group (Canon / Specialized) ───────────────────────────────────

const ResumeGroup: React.FC<{
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    rows: ResumeRow[];
    labelOf: (r: ResumeRow) => string;
    emptyHint: string;
}> = ({ label, icon: Icon, rows, labelOf, emptyHint }) => {
    function download(id: string) {
        window.open(`/api/resumes/${encodeURIComponent(id)}/download`, "_blank");
    }

    return (
        <div>
            <div className="flex items-center gap-2 mb-1.5">
                <Icon className="w-3 h-3 text-purple-300/80" />
                <span className="text-[10px] uppercase tracking-wide text-purple-200/80 font-semibold">{label}</span>
                <span className="text-[10px] text-white/30">{rows.length}</span>
            </div>
            {rows.length === 0 ? (
                <div className="px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[11px] text-white/30 italic">
                    {emptyHint}
                </div>
            ) : (
                <div className="max-h-[16rem] overflow-y-auto custom-scrollbar rounded-lg bg-black/40 border border-white/10 divide-y divide-white/5">
                    {rows.map((r) => (
                        <button
                            key={r.id}
                            type="button"
                            onClick={() => download(r.id)}
                            disabled={!r.hasArtifact}
                            title={r.hasArtifact ? "Download this resume" : "No file for this resume"}
                            className="w-full text-left px-3 py-2 hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-start gap-3"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="text-xs text-white/90 font-semibold break-words leading-snug">
                                    {labelOf(r)}
                                </div>
                                <div className="text-[10px] text-white/40 mt-0.5">{formatRelative(r.createdAt)}</div>
                            </div>
                            <span className="mt-0.5 text-[10px] uppercase tracking-wide text-purple-300/80 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded flex-shrink-0">
                                {r.format}
                            </span>
                            <Download className="mt-1 w-3 h-3 text-white/40 flex-shrink-0" />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
