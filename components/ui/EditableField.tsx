import React, { useState } from "react";
import { cn } from "@/lib/utils";

interface EditableFieldProps {
    value: string | null;
    onSave: (next: string | null) => void;
    placeholder?: string;
    multiline?: boolean;
    className?: string;       // applied to both read and edit modes
    readClassName?: string;    // additional, read-mode only
    inputClassName?: string;   // additional, edit-mode only
    allowEmpty?: boolean;      // if false (default), empty value is rejected as cancel
    type?: 'text' | 'date' | 'email' | 'tel';
}

// Lightweight inline-edit primitive. Click to switch to edit mode; blur commits;
// Enter commits (Shift+Enter inserts newline in multiline); Escape cancels.
export const EditableField: React.FC<EditableFieldProps> = ({
    value,
    onSave,
    placeholder = "Click to edit",
    multiline = false,
    className,
    readClassName,
    inputClassName,
    allowEmpty = false,
    type = 'text',
}) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value ?? "");

    const commit = () => {
        setEditing(false);
        const trimmed = draft.trim();
        if (trimmed === (value ?? "")) return;
        if (!trimmed && !allowEmpty) return;
        onSave(trimmed || null);
    };

    const cancel = () => {
        setDraft(value ?? "");
        setEditing(false);
    };

    if (editing) {
        const sharedProps = {
            autoFocus: true,
            value: draft,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
            onBlur: commit,
            onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' && (!multiline || !e.shiftKey)) { e.preventDefault(); commit(); }
                if (e.key === 'Escape') cancel();
            },
            className: cn(
                "bg-black/40 border border-white/20 rounded px-2 py-1 text-white focus:outline-none focus:border-blue-500/50 w-full",
                className,
                inputClassName,
            ),
        };
        return multiline
            ? <textarea {...sharedProps} rows={3} className={sharedProps.className + " resize-none"} />
            : <input {...sharedProps} type={type} />;
    }

    return (
        <span
            onClick={() => {
                setDraft(value ?? "");
                setEditing(true);
            }}
            className={cn(
                "cursor-text rounded px-1 -mx-1 hover:bg-white/5 transition-colors block",
                className,
                readClassName,
                !value && "italic text-white/30",
            )}
            title="Click to edit"
        >
            {value || placeholder}
        </span>
    );
};
