import React, { useState } from "react";
import { FolderGit, Plus, Trash2, ArrowUp, ArrowDown, ExternalLink, Github } from "lucide-react";
import { Card } from "../ui/Card";
import { EditableField } from "../ui/EditableField";
import { BulletRow } from "../ui/BulletRow";
import { makeBullet } from "@/lib/profile/bullets";
import type { Bullet } from "@/lib/profile/types";
import type { ProjectWire } from "@/lib/schemas/profile";

interface ProjectCardProps {
    project: ProjectWire;
    onUpdate: (patch: Partial<{
        name: string;
        description: string | null;
        repoUrl: string | null;
        liveUrl: string | null;
        bullets: Bullet[];
    }>) => void;
    onDelete: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({
    project,
    onUpdate,
    onDelete,
    onMoveUp,
    onMoveDown,
    canMoveUp,
    canMoveDown,
}) => {
    const [newBulletText, setNewBulletText] = useState("");

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

    return (
        <Card
            icon={FolderGit}
            iconColorClass="text-cyan-400"
            wrapperClassName="bg-black/40 border border-white/5 hover:border-cyan-500/30 transition-colors rounded-2xl p-5"
        >
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

            <div className="mt-3 flex flex-col gap-0.5">
                {project.bullets.length === 0 ? (
                    <p className="text-xs text-white/30 italic px-2 py-1">No bullets yet — add one below.</p>
                ) : (
                    project.bullets.map((b, idx) => (
                        <BulletRow
                            key={b.id || `tmp-${idx}`}
                            bullet={b}
                            onChange={(next) => updateBullet(idx, next)}
                            onDelete={() => removeBullet(idx)}
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
        </Card>
    );
};
