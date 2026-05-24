import React, { useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, ExternalLink, Github, Star, RefreshCw, Sparkles, X } from "lucide-react";
import { EditableField } from "./EditableField";
import { BulletRow } from "./BulletRow";
import { makeBullet } from "@/lib/profile/bullets";
import { api } from "@/lib/api-client";
import type { Bullet } from "@/lib/profile/types";
import type { ProjectWire } from "@/lib/schemas/profile";

interface ProjectRowProps {
    project: ProjectWire;
    onUpdate: (patch: Partial<{
        name: string;
        description: string | null;
        repoUrl: string | null;
        liveUrl: string | null;
        githubRepo: string | null;
        portfolio: boolean;
        bullets: Bullet[];
    }>) => void;
    onDelete: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
}

export const ProjectRow: React.FC<ProjectRowProps> = ({
    project,
    onUpdate,
    onDelete,
    onMoveUp,
    onMoveDown,
    canMoveUp,
    canMoveDown,
}) => {
    const [newBulletText, setNewBulletText] = useState("");
    const [drafting, setDrafting] = useState(false);
    const [draftError, setDraftError] = useState<string | null>(null);

    const updateBullet = (idx: number, next: Bullet) => {
        const arr = [...project.bullets];
        arr[idx] = next;
        onUpdate({ bullets: arr });
    };
    const removeBullet = (idx: number) => {
        onUpdate({ bullets: project.bullets.filter((_, i) => i !== idx) });
    };
    const addBullet = () => {
        const text = newBulletText.trim();
        if (!text) return;
        onUpdate({ bullets: [...project.bullets, makeBullet(text)] });
        setNewBulletText("");
    };
    const handleDraft = async () => {
        setDrafting(true);
        setDraftError(null);
        try {
            const result = await api.profile.bullets.assistFill('project', project.id);
            if (result.mode !== 'fill') throw new Error('unexpected response shape');
            onUpdate({ bullets: result.suggestions });
        } catch (err) {
            setDraftError(err instanceof Error ? err.message : 'Failed to draft bullets');
        } finally {
            setDrafting(false);
        }
    };

    return (
        <div className="bg-white/5 border border-white/5 hover:border-cyan-500/20 rounded-md p-3 transition-colors">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <EditableField
                        value={project.name}
                        onSave={(v) => v && onUpdate({ name: v })}
                        placeholder="Project name"
                        readClassName="text-base font-semibold text-white"
                    />
                    <EditableField
                        value={project.description}
                        onSave={(v) => onUpdate({ description: v })}
                        placeholder="One-line description"
                        readClassName="text-sm text-white/60"
                    />
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                    {onMoveUp && (
                        <button onClick={onMoveUp} disabled={!canMoveUp} className="p-1.5 rounded text-white/30 hover:text-white/70 hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed" title="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
                    )}
                    {onMoveDown && (
                        <button onClick={onMoveDown} disabled={!canMoveDown} className="p-1.5 rounded text-white/30 hover:text-white/70 hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed" title="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
                    )}
                    <button onClick={onDelete} className="p-1.5 rounded text-rose-400/40 hover:text-rose-400 hover:bg-rose-500/10" title="Delete project"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
            </div>

            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-2">
                    <Github className="w-3.5 h-3.5 text-white/40 shrink-0" />
                    <EditableField
                        value={project.repoUrl}
                        onSave={(v) => onUpdate({ repoUrl: v })}
                        placeholder="Repo URL"
                        readClassName="text-sm text-white/70 truncate"
                    />
                </div>
                <div className="flex items-center gap-2">
                    <ExternalLink className="w-3.5 h-3.5 text-white/40 shrink-0" />
                    <EditableField
                        value={project.liveUrl}
                        onSave={(v) => onUpdate({ liveUrl: v })}
                        placeholder="Live URL"
                        readClassName="text-sm text-white/70 truncate"
                    />
                </div>
            </div>

            {/* Portfolio / GitHub-metrics row (M9) — flip portfolio on + supply
                owner/repo and the scheduler will refresh stars / language mix
                / commits daily, surfaced on generated resumes. */}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                <label
                    className={[
                        "inline-flex items-center gap-2 px-2 py-1 rounded-md border cursor-pointer transition-colors",
                        project.portfolio
                            ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
                            : "border-white/10 text-white/40 hover:border-white/20 hover:text-white/70",
                    ].join(" ")}
                    title="Flag this project as portfolio — the M9 scheduler will fetch GitHub metrics on the next tick"
                >
                    <input
                        type="checkbox"
                        checked={project.portfolio}
                        onChange={(e) => onUpdate({ portfolio: e.target.checked })}
                        className="sr-only"
                    />
                    <Star className={`w-3.5 h-3.5 ${project.portfolio ? "fill-amber-400 text-amber-400" : ""}`} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide">Portfolio</span>
                </label>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Github className="w-3.5 h-3.5 text-white/40 shrink-0" />
                    <EditableField
                        value={project.githubRepo}
                        onSave={(v) => {
                            // Trim + reject anything that doesn't match owner/repo. Server-side
                            // schema also enforces this with a regex.
                            const trimmed = v?.trim() || null;
                            if (trimmed && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return;
                            onUpdate({ githubRepo: trimmed });
                        }}
                        placeholder="owner/repo"
                        readClassName="text-sm text-white/70 truncate"
                    />
                </div>
                {project.metricsUpdatedAt && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-white/40" title="Metrics last refreshed">
                        <RefreshCw className="w-3 h-3" />
                        {new Date(project.metricsUpdatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                )}
            </div>

            <div className="mt-3 flex flex-col gap-0.5">
                {project.bullets.length === 0 ? (
                    <>
                        <p className="text-xs text-white/30 italic px-2 py-1">No bullets yet — add one below.</p>
                        <div className="flex items-center gap-2 px-2 py-0.5">
                            <button
                                type="button"
                                onClick={handleDraft}
                                disabled={drafting}
                                className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white/80 disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 rounded transition-colors"
                                title="Draft starter bullets with the LLM, grounded on this project's spine fields"
                            >
                                <Sparkles className="w-3.5 h-3.5" />
                                {drafting ? 'Drafting…' : 'Draft with LLM'}
                            </button>
                        </div>
                        {draftError && (
                            <div className="mx-2 mb-1 inline-flex items-center gap-1 self-start text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1">
                                <span>{draftError}</span>
                                <button
                                    type="button"
                                    onClick={() => setDraftError(null)}
                                    className="text-rose-300/60 hover:text-rose-200"
                                    title="Dismiss"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        )}
                    </>
                ) : (
                    project.bullets.map((b, idx) => (
                        <BulletRow
                            key={b.id || `tmp-${idx}`}
                            bullet={b}
                            onChange={(next) => updateBullet(idx, next)}
                            onDelete={() => removeBullet(idx)}
                            rewriteContext={{ parentKind: 'project', parentId: project.id }}
                        />
                    ))
                )}
                <div className="flex items-center gap-2 mt-1">
                    <input
                        type="text"
                        value={newBulletText}
                        onChange={(e) => setNewBulletText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBullet(); } }}
                        placeholder="Add a bullet…"
                        className="flex-1 bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50"
                    />
                    <button
                        onClick={addBullet}
                        disabled={!newBulletText.trim()}
                        className="p-1.5 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-30 disabled:cursor-not-allowed text-blue-400 rounded-md transition-colors"
                        title="Add bullet"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </div>
    );
};
