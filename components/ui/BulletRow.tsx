import React, { useState } from "react";
import { Lock, LockOpen, EyeOff, Eye, Trash2 } from "lucide-react";
import type { Bullet } from "@/lib/profile/types";
import { cn } from "@/lib/utils";

interface BulletRowProps {
    bullet: Bullet;
    onChange: (next: Bullet) => void;
    onDelete: () => void;
}

export const BulletRow: React.FC<BulletRowProps> = ({ bullet, onChange, onDelete }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(bullet.text);

    const commit = () => {
        const trimmed = draft.trim();
        setEditing(false);
        if (trimmed && trimmed !== bullet.text) {
            onChange({ ...bullet, text: trimmed });
        } else if (!trimmed) {
            setDraft(bullet.text); // revert
        }
    };

    const startEdit = () => {
        setDraft(bullet.text);
        setEditing(true);
    };

    return (
        <div className={cn(
            "group flex items-start gap-2 px-2 py-1.5 rounded-md border border-transparent hover:border-white/10 hover:bg-white/5 transition-colors",
            bullet.excluded && "opacity-40",
        )}>
            <span className="text-white/30 mt-1 select-none">•</span>
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
                        className="text-sm text-white/85 cursor-text whitespace-pre-wrap"
                        title="Click to edit"
                    >
                        {bullet.text}
                    </p>
                )}
                {bullet.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                        {bullet.tags.map((tag) => (
                            <span
                                key={tag}
                                className="text-[10px] uppercase tracking-wider text-white/40 bg-white/5 border border-white/10 rounded px-1.5 py-0.5"
                            >
                                {tag}
                            </span>
                        ))}
                    </div>
                )}
            </div>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={() => onChange({ ...bullet, locked: !bullet.locked })}
                    className={cn(
                        "p-1 rounded hover:bg-white/10",
                        bullet.locked ? "text-amber-400" : "text-white/30 hover:text-white/60",
                    )}
                    title={bullet.locked ? "Locked — always include" : "Lock as always-include"}
                >
                    {bullet.locked ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
                </button>
                <button
                    onClick={() => onChange({ ...bullet, excluded: !bullet.excluded })}
                    className={cn(
                        "p-1 rounded hover:bg-white/10",
                        bullet.excluded ? "text-rose-400" : "text-white/30 hover:text-white/60",
                    )}
                    title={bullet.excluded ? "Excluded — never include" : "Exclude from generated resumes"}
                >
                    {bullet.excluded ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                <button
                    onClick={onDelete}
                    className="p-1 rounded text-white/30 hover:text-rose-400 hover:bg-rose-500/10"
                    title="Delete bullet"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>
        </div>
    );
};
