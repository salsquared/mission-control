import React, { useState } from "react";
import { Lock, LockOpen, EyeOff, Eye, Trash2, Plus, X } from "lucide-react";
import type { Bullet } from "@/lib/profile/types";
import { cn } from "@/lib/utils";

interface BulletRowProps {
    bullet: Bullet;
    onChange: (next: Bullet) => void;
    onDelete: () => void;
}

const TAG_MAX_LENGTH = 30;

export const BulletRow: React.FC<BulletRowProps> = ({ bullet, onChange, onDelete }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(bullet.text);
    const [addingTag, setAddingTag] = useState(false);
    const [tagDraft, setTagDraft] = useState("");

    const commit = () => {
        const trimmed = draft.trim();
        setEditing(false);
        if (trimmed && trimmed !== bullet.text) {
            onChange({ ...bullet, text: trimmed });
        } else if (!trimmed) {
            setDraft(bullet.text);
        }
    };

    const startEdit = () => {
        setDraft(bullet.text);
        setEditing(true);
    };

    const removeTag = (t: string) => {
        onChange({ ...bullet, tags: bullet.tags.filter(x => x !== t) });
    };

    const commitTag = () => {
        const t = tagDraft.trim().toLowerCase().slice(0, TAG_MAX_LENGTH);
        setAddingTag(false);
        setTagDraft("");
        if (!t) return;
        if (bullet.tags.includes(t)) return;
        onChange({ ...bullet, tags: [...bullet.tags, t] });
    };

    // Lock/exclude buttons stay persistently visible when active so the
    // state is discoverable without hovering — M8-2.5 story 36 fix.
    const lockBtnAlwaysVisible = bullet.locked;
    const excludeBtnAlwaysVisible = bullet.excluded;

    return (
        <div className={cn(
            "group flex items-start gap-2 px-2 py-1.5 rounded-md border transition-colors",
            bullet.locked
                ? "border-amber-500/30 bg-amber-500/[0.04] hover:border-amber-500/50"
                : bullet.excluded
                ? "border-rose-500/20 bg-rose-500/[0.03] hover:border-rose-500/40 opacity-50"
                : "border-transparent hover:border-white/10 hover:bg-white/5",
        )}>
            <span className={cn(
                "mt-1 select-none",
                bullet.locked ? "text-amber-400" : bullet.excluded ? "text-rose-400/70" : "text-white/30",
            )}>•</span>

            <div className="flex-1 min-w-0">
                {editing ? (
                    <textarea
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
                            if (e.key === 'Escape') { setDraft(bullet.text); setEditing(false); }
                        }}
                        rows={Math.max(1, Math.min(6, draft.split('\n').length))}
                        className="w-full bg-black/40 border border-white/20 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500/50 resize-none"
                    />
                ) : (
                    <p
                        onClick={startEdit}
                        className={cn(
                            "text-sm cursor-text whitespace-pre-wrap",
                            bullet.excluded ? "text-white/50 line-through decoration-rose-500/40" : "text-white/85",
                        )}
                        title="Click to edit"
                    >
                        {bullet.text}
                    </p>
                )}

                <div className="mt-1 flex flex-wrap gap-1 items-center">
                    {bullet.tags.map((tag) => (
                        <button
                            key={tag}
                            onClick={() => removeTag(tag)}
                            className="group/tag flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-white/50 bg-white/5 border border-white/10 hover:border-rose-400/40 hover:text-white/80 rounded px-1.5 py-0.5 transition-colors"
                            title={`Remove tag: ${tag}`}
                        >
                            <span>{tag}</span>
                            <X className="w-2 h-2 opacity-0 group-hover/tag:opacity-100 transition-opacity" />
                        </button>
                    ))}
                    {addingTag ? (
                        <input
                            autoFocus
                            type="text"
                            value={tagDraft}
                            onChange={(e) => setTagDraft(e.target.value)}
                            onBlur={commitTag}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); commitTag(); }
                                if (e.key === 'Escape') { setAddingTag(false); setTagDraft(""); }
                            }}
                            placeholder="tag…"
                            maxLength={TAG_MAX_LENGTH}
                            className="text-[10px] uppercase tracking-wider bg-black/40 border border-white/20 rounded px-1.5 py-0.5 text-white/80 placeholder-white/30 focus:outline-none focus:border-blue-500/50 w-20"
                        />
                    ) : (
                        <button
                            onClick={() => setAddingTag(true)}
                            className="flex items-center gap-0.5 text-[10px] text-white/30 hover:text-white/70 border border-dashed border-white/15 hover:border-white/30 rounded px-1.5 py-0.5 transition-colors"
                            title="Add a tag"
                        >
                            <Plus className="w-2.5 h-2.5" />
                            <span className="uppercase tracking-wider">tag</span>
                        </button>
                    )}
                </div>
            </div>

            <div className={cn(
                "flex items-center gap-0.5 transition-opacity",
                lockBtnAlwaysVisible || excludeBtnAlwaysVisible
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100",
            )}>
                <button
                    onClick={() => onChange({ ...bullet, locked: !bullet.locked, excluded: bullet.locked ? bullet.excluded : false })}
                    className={cn(
                        "p-1 rounded hover:bg-white/10",
                        bullet.locked ? "text-amber-400 opacity-100" : "text-white/30 hover:text-white/60",
                    )}
                    title={bullet.locked
                        ? "🔒 Always included — click to unlock"
                        : "Lock this bullet so it's always included in generated resumes"}
                    aria-pressed={bullet.locked}
                >
                    {bullet.locked ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
                </button>
                <button
                    onClick={() => onChange({ ...bullet, excluded: !bullet.excluded, locked: bullet.excluded ? bullet.locked : false })}
                    className={cn(
                        "p-1 rounded hover:bg-white/10",
                        bullet.excluded ? "text-rose-400 opacity-100" : "text-white/30 hover:text-white/60",
                    )}
                    title={bullet.excluded
                        ? "🚫 Excluded — click to re-include"
                        : "Exclude this bullet from every generated resume"}
                    aria-pressed={bullet.excluded}
                >
                    {bullet.excluded ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                <button
                    onClick={onDelete}
                    className="p-1 rounded text-white/30 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100"
                    title="Delete bullet permanently"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>
        </div>
    );
};
