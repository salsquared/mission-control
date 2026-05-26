/**
 * M7.8.3 (story S7.13) — Scratchpad modal editor for per-entity user-voice notes.
 *
 * Mounted by each entity row's `StickyNote` trigger button (M7.8.4) on the
 * Profile dash. The textarea body is `scratchpad: String?` on WorkRole /
 * Project / Education. Persists via the existing entity PATCH path — no new
 * route needed.
 *
 * UX:
 *   - Backdrop click = cancel (mirrors AddApplicationModal).
 *   - Esc = cancel; Ctrl/Cmd+Enter = save.
 *   - Character count badge updates live, turns rose at the cap.
 *   - Save button disabled while submitting or unchanged.
 *   - Empty save (trimmed) writes null to the column so the trigger button
 *     visual state correctly reads "no notes yet".
 */

"use client";

import React, { useEffect, useRef, useState } from "react";
import { X, Loader2, StickyNote } from "lucide-react";

const SCRATCHPAD_MAX_BYTES = 8192;

export type ScratchpadEntityKind = "work-role" | "project" | "education";

interface ScratchpadOverlayProps {
    open: boolean;
    entityKind: ScratchpadEntityKind;
    /** Short label rendered in the modal header. e.g. "Acme Corp — Senior Engineer" */
    entityLabel: string;
    initialValue: string | null;
    /** Called with the trimmed string on save. Empty trim sends null so the
     *  column clears and the trigger button visual state reflects "empty". */
    onSave: (next: string | null) => void | Promise<void>;
    onClose: () => void;
}

// Theme-color picker for the per-kind accent on the header + Save button.
// Matches the same convention used elsewhere on ProfileIdentityCard
// (purple = WorkRole, cyan = Project, emerald = Education).
const KIND_ACCENT: Record<ScratchpadEntityKind, { text: string; bg: string; border: string; ring: string }> = {
    "work-role": {
        text: "text-purple-300",
        bg: "bg-purple-500/15 hover:bg-purple-500/25",
        border: "border-purple-500/30",
        ring: "focus:border-purple-400/40",
    },
    project: {
        text: "text-cyan-300",
        bg: "bg-cyan-500/15 hover:bg-cyan-500/25",
        border: "border-cyan-500/30",
        ring: "focus:border-cyan-400/40",
    },
    education: {
        text: "text-emerald-300",
        bg: "bg-emerald-500/15 hover:bg-emerald-500/25",
        border: "border-emerald-500/30",
        ring: "focus:border-emerald-400/40",
    },
};

const PLACEHOLDER = "In your own words: what did you build at this role, what problems did you solve, what was hard, what energizes you?";

export const ScratchpadOverlay: React.FC<ScratchpadOverlayProps> = ({
    open,
    entityKind,
    entityLabel,
    initialValue,
    onSave,
    onClose,
}) => {
    const [draft, setDraft] = useState(initialValue ?? "");
    const [submitting, setSubmitting] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Reset draft when the overlay opens (re-mount safety net — without this,
    // a closed-then-reopened overlay on a different entity would still show
    // the previous entity's draft).
    useEffect(() => {
        if (open) setDraft(initialValue ?? "");
    }, [open, initialValue]);

    // Esc to cancel.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (!open) return null;

    const accent = KIND_ACCENT[entityKind];
    const trimmed = draft.trim();
    const overCap = draft.length > SCRATCHPAD_MAX_BYTES;
    const unchanged = (initialValue ?? "") === draft;
    const canSave = !submitting && !overCap && !unchanged;

    async function handleSave(): Promise<void> {
        if (!canSave) return;
        setSubmitting(true);
        try {
            await onSave(trimmed.length === 0 ? null : trimmed);
            // Don't close here — the caller decides (lets the parent flush
            // toast + close in a single tick). The parent's onClose runs
            // after a successful save.
        } finally {
            setSubmitting(false);
        }
    }

    function onKeyDownTextarea(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            handleSave();
        }
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <div
                className="w-full max-w-2xl bg-[#111] border border-white/10 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-white/10">
                    <div className="flex items-center gap-2 min-w-0">
                        <StickyNote className={`w-4 h-4 shrink-0 ${accent.text}`} />
                        <div className="min-w-0">
                            <h2 className="text-sm font-semibold text-white truncate">{entityLabel}</h2>
                            <p className="text-[11px] text-white/40">Notes — your voice + experience for AI grounding (never rendered verbatim)</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={submitting}
                        className="p-2 hover:bg-white/10 rounded-md text-white/60 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-4 flex flex-col gap-2">
                    <textarea
                        ref={textareaRef}
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={onKeyDownTextarea}
                        rows={12}
                        placeholder={PLACEHOLDER}
                        disabled={submitting}
                        className={`w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none ${accent.ring} resize-y disabled:opacity-50`}
                    />
                    <div className="flex items-center justify-between text-[11px]">
                        <span className="text-white/40">
                            Ctrl/Cmd+Enter to save · Esc to cancel
                        </span>
                        <span className={overCap ? "text-rose-400" : "text-white/40"}>
                            {draft.length.toLocaleString()} / {SCRATCHPAD_MAX_BYTES.toLocaleString()}
                            {overCap && " — over cap"}
                        </span>
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/10">
                    <button
                        onClick={onClose}
                        disabled={submitting}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 hover:bg-white/10 text-white/70 border border-white/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!canSave}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${accent.bg} ${accent.border} ${accent.text}`}
                    >
                        {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        {submitting ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
};
