import React, { useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Sparkles, X } from "lucide-react";
import { EditableField } from "./EditableField";
import { BulletRow } from "./BulletRow";
import { makeBullet } from "@/lib/profile/bullets";
import { api } from "@/lib/api-client";
import type { Bullet } from "@/lib/profile/types";
import type { WorkRoleWire } from "@/lib/schemas/profile";

interface WorkRoleRowProps {
    role: WorkRoleWire;
    onUpdate: (patch: Partial<{
        company: string;
        title: string;
        location: string | null;
        startDate: string;
        endDate: string | null;
        bullets: Bullet[];
    }>) => void;
    onDelete: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
}

const dateToInput = (iso: string | Date | null | undefined): string =>
    iso ? new Date(iso).toISOString().slice(0, 10) : "";

const inputToIso = (yyyymmdd: string | null): string | null =>
    yyyymmdd ? new Date(yyyymmdd + 'T00:00:00Z').toISOString() : null;

export const WorkRoleRow: React.FC<WorkRoleRowProps> = ({
    role,
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
        const arr = [...role.bullets];
        arr[idx] = next;
        onUpdate({ bullets: arr });
    };
    const removeBullet = (idx: number) => {
        onUpdate({ bullets: role.bullets.filter((_, i) => i !== idx) });
    };
    const addBullet = () => {
        const text = newBulletText.trim();
        if (!text) return;
        onUpdate({ bullets: [...role.bullets, makeBullet(text)] });
        setNewBulletText("");
    };
    const handleDraft = async () => {
        setDrafting(true);
        setDraftError(null);
        try {
            const result = await api.profile.bullets.assistFill('work-role', role.id);
            if (result.mode !== 'fill') throw new Error('unexpected response shape');
            onUpdate({ bullets: result.suggestions });
        } catch (err) {
            setDraftError(err instanceof Error ? err.message : 'Failed to draft bullets');
        } finally {
            setDrafting(false);
        }
    };

    return (
        <div className="bg-white/5 border border-white/5 hover:border-purple-500/20 rounded-md p-3 transition-colors">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <EditableField
                        value={role.title}
                        onSave={(v) => v && onUpdate({ title: v })}
                        placeholder="Role title"
                        readClassName="text-base font-semibold text-white"
                    />
                    <EditableField
                        value={role.company}
                        onSave={(v) => v && onUpdate({ company: v })}
                        placeholder="Company"
                        readClassName="text-sm text-purple-300"
                    />
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                    {onMoveUp && (
                        <button onClick={onMoveUp} disabled={!canMoveUp} className="p-1.5 rounded text-white/30 hover:text-white/70 hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed" title="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
                    )}
                    {onMoveDown && (
                        <button onClick={onMoveDown} disabled={!canMoveDown} className="p-1.5 rounded text-white/30 hover:text-white/70 hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed" title="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
                    )}
                    <button onClick={onDelete} className="p-1.5 rounded text-rose-400/40 hover:text-rose-400 hover:bg-rose-500/10" title="Delete role"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
            </div>

            <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/30">Location</span>
                    <EditableField
                        value={role.location}
                        onSave={(v) => onUpdate({ location: v })}
                        placeholder="—"
                        readClassName="text-sm text-white/70"
                    />
                </div>
                <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/30">Start</span>
                    <EditableField
                        value={dateToInput(role.startDate)}
                        onSave={(v) => v && onUpdate({ startDate: inputToIso(v) ?? undefined })}
                        placeholder="YYYY-MM-DD"
                        type="date"
                        readClassName="text-sm text-white/70"
                    />
                </div>
                <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/30">End</span>
                    <EditableField
                        value={dateToInput(role.endDate)}
                        onSave={(v) => onUpdate({ endDate: inputToIso(v) })}
                        placeholder="Present"
                        type="date"
                        readClassName="text-sm text-white/70"
                        allowEmpty
                    />
                </div>
            </div>

            <div className="mt-3 flex flex-col gap-0.5">
                {role.bullets.length === 0 ? (
                    <>
                        <p className="text-xs text-white/30 italic px-2 py-1">No bullets yet — add one below.</p>
                        <div className="flex items-center gap-2 px-2 py-0.5">
                            <button
                                type="button"
                                onClick={handleDraft}
                                disabled={drafting}
                                className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white/80 disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 rounded transition-colors"
                                title="Draft starter bullets with the LLM, grounded on this role's spine fields"
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
                    role.bullets.map((b, idx) => (
                        <BulletRow
                            key={b.id || `tmp-${idx}`}
                            bullet={b}
                            onChange={(next) => updateBullet(idx, next)}
                            onDelete={() => removeBullet(idx)}
                            rewriteContext={{ parentKind: 'work-role', parentId: role.id }}
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
