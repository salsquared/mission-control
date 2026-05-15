import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    X,
    Loader2,
    Mail,
    Calendar as CalendarIcon,
    StickyNote,
    CheckCircle2,
    XCircle,
    Send,
    ClipboardCheck,
    ArrowRight,
    Trash2,
    ExternalLink,
} from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";
import {
    APPLICATION_STATUSES,
    APPLICATION_KINDS,
    type ApplicationsListResponseSchema,
    type ApplicationSchema,
    type ApplicationPatchSchema,
} from "@/lib/schemas/applications";
import type { ApplicationEventSchema } from "@/lib/schemas/applicationEvents";
import type { z } from "zod";
import { toastStore } from "@/lib/toast-store";

type Application = z.infer<typeof ApplicationSchema>;
type ApplicationsCache = z.infer<typeof ApplicationsListResponseSchema>;
type ApplicationPatch = z.infer<typeof ApplicationPatchSchema>;
type ApplicationEvent = z.infer<typeof ApplicationEventSchema>;

type EditingField = 'company' | 'role' | 'nextSteps' | null;

const PostingSourceLine: React.FC<{ postingId: string }> = ({ postingId }) => {
    const { data } = useQuery({
        queryKey: queryKeys.posting(postingId),
        queryFn: () => api.postings.get(postingId),
        retry: false,
    });
    if (!data?.posting) return null;
    const closed = data.posting.status === 'closed';
    return (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-white/40">
            <span>Tracked from:</span>
            <a
                href={data.posting.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-cyan-300/80 hover:text-cyan-200 underline underline-offset-2 truncate max-w-[28ch]"
            >
                {data.posting.sourceUrl}
                <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
            {closed && (
                <span className="text-[10px] uppercase tracking-wide text-red-300/80 bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 rounded">
                    Closed
                </span>
            )}
        </div>
    );
};

interface ApplicationDetailOverlayProps {
    applicationId: string;
    onClose: () => void;
}

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
    APPLIED: Send,
    UPDATED: Mail,
    STATUS_CHANGED: ArrowRight,
    EMAIL_RECEIVED: Mail,
    ASSESSMENT_REQUESTED: ClipboardCheck,
    INTERVIEW_SCHEDULED: CalendarIcon,
    OFFER: CheckCircle2,
    REJECTION: XCircle,
    NOTE: StickyNote,
};

const KIND_COLOR: Record<string, string> = {
    APPLIED: "text-blue-400 bg-blue-500/10 border-blue-500/20",
    UPDATED: "text-blue-300 bg-blue-500/5 border-blue-500/10",
    STATUS_CHANGED: "text-slate-300 bg-slate-500/10 border-slate-500/20",
    EMAIL_RECEIVED: "text-cyan-300 bg-cyan-500/10 border-cyan-500/20",
    ASSESSMENT_REQUESTED: "text-purple-300 bg-purple-500/10 border-purple-500/20",
    INTERVIEW_SCHEDULED: "text-amber-300 bg-amber-500/10 border-amber-500/20",
    OFFER: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
    REJECTION: "text-rose-300 bg-rose-500/10 border-rose-500/20",
    NOTE: "text-slate-300 bg-white/5 border-white/10",
};

export const ApplicationDetailOverlay: React.FC<ApplicationDetailOverlayProps> = ({ applicationId, onClose }) => {
    const queryClient = useQueryClient();
    const [noteText, setNoteText] = useState("");
    const [savingNote, setSavingNote] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [editingField, setEditingField] = useState<EditingField>(null);
    const [editValue, setEditValue] = useState("");

    const startEdit = (field: Exclude<EditingField, null>, currentValue: string) => {
        setEditingField(field);
        setEditValue(currentValue);
    };

    const cancelEdit = () => {
        setEditingField(null);
        setEditValue("");
    };

    const optimisticPatch = (patch: Partial<Application>) => {
        const prev = queryClient.getQueryData<ApplicationsCache>(queryKeys.applications);
        queryClient.setQueryData<ApplicationsCache>(queryKeys.applications, (old) => ({
            applications: (old?.applications ?? []).map((a) =>
                a.id === applicationId ? { ...a, ...patch, lastUpdateAt: new Date().toISOString() } : a
            ),
        }));
        return prev;
    };

    const saveEdit = async () => {
        if (!editingField || !app) return;
        const val = editValue.trim();
        // Company is required; bail (keep prior value) if it would become empty.
        if (editingField === 'company' && !val) { cancelEdit(); return; }
        const patch: ApplicationPatch = { id: applicationId };
        if (editingField === 'company') patch.company = val;
        if (editingField === 'role') patch.role = val || null;
        if (editingField === 'nextSteps') patch.nextSteps = val || null;
        const prev = optimisticPatch(patch);
        cancelEdit();
        try {
            await api.applications.update(patch);
        } catch (e) {
            queryClient.setQueryData(queryKeys.applications, prev);
            toastStore.push({ message: `Save failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
        }
    };

    const handleKindChange = async (newKind: typeof APPLICATION_KINDS[number] | null) => {
        if (!app) return;
        const prev = optimisticPatch({ kind: newKind });
        try {
            await api.applications.update({ id: applicationId, kind: newKind });
        } catch (e) {
            queryClient.setQueryData(queryKeys.applications, prev);
            toastStore.push({ message: `Update failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
        }
    };

    const { data: appsData } = useQuery({
        queryKey: queryKeys.applications,
        queryFn: () => api.applications.list(),
    });
    const app: Application | undefined = (appsData?.applications ?? []).find((a) => a.id === applicationId);

    const eventsKey = queryKeys.applicationEvents({ applicationId });
    const { data: eventsData, isLoading: eventsLoading } = useQuery({
        queryKey: eventsKey,
        queryFn: () => api.applications.events.list({ applicationId }),
    });
    const events: ApplicationEvent[] = eventsData?.events ?? [];

    // Server returns occurredAt desc by default. The timeline reads top-down
    // newest-first, which matches the user's mental model ("what happened
    // most recently?") for an open application.
    const sortedEvents = useMemo(
        () => [...events].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()),
        [events]
    );

    const handleStatusChange = async (newStatus: typeof APPLICATION_STATUSES[number]) => {
        if (!app || newStatus === app.status) return;
        const prev = queryClient.getQueryData<ApplicationsCache>(queryKeys.applications);
        queryClient.setQueryData<ApplicationsCache>(queryKeys.applications, (old) => ({
            applications: (old?.applications ?? []).map((a) =>
                a.id === applicationId ? { ...a, status: newStatus, lastUpdateAt: new Date().toISOString() } : a
            ),
        }));
        try {
            await api.applications.update({ id: applicationId, status: newStatus });
            queryClient.invalidateQueries({ queryKey: eventsKey });
        } catch (e) {
            queryClient.setQueryData(queryKeys.applications, prev);
            toastStore.push({ message: `Status update failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
        }
    };

    const handleAddNote = async (e: React.FormEvent) => {
        e.preventDefault();
        const text = noteText.trim();
        if (!text) return;
        setSavingNote(true);
        try {
            await api.applications.events.create({
                applicationId,
                kind: 'NOTE',
                title: text.length > 80 ? text.slice(0, 77) + '…' : text,
                notes: text,
                occurredAt: new Date().toISOString(),
            });
            setNoteText("");
            queryClient.invalidateQueries({ queryKey: eventsKey });
        } catch (e) {
            toastStore.push({ message: `Note save failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
        } finally {
            setSavingNote(false);
        }
    };

    const handleDelete = async () => {
        if (!app) return;
        const confirmed = window.confirm(`Delete application for ${app.company}? This removes the application and all timeline events.`);
        if (!confirmed) return;
        setDeleting(true);
        try {
            await api.applications.delete(applicationId);
            toastStore.push({ message: `Deleted ${app.company}`, type: 'info' });
            queryClient.invalidateQueries({ queryKey: queryKeys.applications });
            onClose();
        } catch (e) {
            toastStore.push({ message: `Delete failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
            setDeleting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-xl h-full bg-[#111] border-l border-white/10 flex flex-col shadow-2xl animate-in slide-in-from-right-full duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between p-4 border-b border-white/10 shrink-0">
                    <div className="min-w-0 flex-1">
                        {editingField === 'company' ? (
                            <input
                                autoFocus
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={saveEdit}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                                className="text-lg font-bold bg-black/40 border border-white/20 rounded px-2 py-0.5 text-white w-full focus:outline-none focus:border-blue-500/50"
                            />
                        ) : (
                            <h2
                                onClick={() => app && startEdit('company', app.company)}
                                className="text-lg font-bold text-white truncate hover:bg-white/5 rounded px-1 -mx-1 cursor-text"
                                title="Click to edit"
                            >
                                {app?.company ?? 'Loading…'}
                            </h2>
                        )}
                        {editingField === 'role' ? (
                            <input
                                autoFocus
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={saveEdit}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                                placeholder="Role"
                                className="text-sm bg-black/40 border border-white/20 rounded px-2 py-0.5 text-white w-full mt-1 focus:outline-none focus:border-blue-500/50"
                            />
                        ) : (
                            <p
                                onClick={() => app && startEdit('role', app.role ?? '')}
                                className="text-sm text-slate-400 truncate hover:bg-white/5 rounded px-1 -mx-1 cursor-text"
                                title="Click to edit role"
                            >
                                {app?.role || <span className="italic text-white/30">Click to add role</span>}
                            </p>
                        )}
                        {app?.postingId && (
                            <PostingSourceLine postingId={app.postingId} />
                        )}
                        {app && (
                            <>
                                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                                    {APPLICATION_STATUSES.map((s) => (
                                        <button
                                            key={s}
                                            onClick={() => handleStatusChange(s)}
                                            className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border transition-colors ${
                                                app.status === s
                                                    ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                                                    : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white/70'
                                            }`}
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                    <span className="text-[10px] uppercase tracking-wider text-white/30 mr-1">Kind</span>
                                    {APPLICATION_KINDS.map((k) => (
                                        <button
                                            key={k}
                                            onClick={() => handleKindChange(app.kind === k ? null : k)}
                                            className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border transition-colors ${
                                                app.kind === k
                                                    ? 'bg-purple-500/20 text-purple-300 border-purple-500/30'
                                                    : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white/70'
                                            }`}
                                        >
                                            {k}
                                        </button>
                                    ))}
                                </div>
                                <div className="mt-3">
                                    <span className="text-[10px] uppercase tracking-wider text-white/30">Next steps</span>
                                    {editingField === 'nextSteps' ? (
                                        <textarea
                                            autoFocus
                                            value={editValue}
                                            onChange={(e) => setEditValue(e.target.value)}
                                            onBlur={saveEdit}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
                                                if (e.key === 'Escape') cancelEdit();
                                            }}
                                            rows={2}
                                            placeholder="What's next? (⌘/Ctrl+Enter to save)"
                                            className="mt-1 w-full bg-black/40 border border-white/20 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500/50 resize-none"
                                        />
                                    ) : (
                                        <p
                                            onClick={() => startEdit('nextSteps', app.nextSteps ?? '')}
                                            className="text-sm text-white/70 hover:bg-white/5 rounded px-1 -mx-1 cursor-text whitespace-pre-wrap mt-0.5 min-h-[1.25rem]"
                                            title="Click to edit next steps"
                                        >
                                            {app.nextSteps || <span className="italic text-white/30">Click to add…</span>}
                                        </p>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                        <button
                            onClick={handleDelete}
                            disabled={deleting || !app}
                            className="p-2 hover:bg-rose-500/10 rounded-md text-rose-400/60 hover:text-rose-400 transition-colors disabled:opacity-30"
                            title="Delete application"
                        >
                            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 hover:bg-white/10 rounded-md text-white/60 hover:text-white transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                    <h3 className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-3">Timeline</h3>
                    {eventsLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-6 h-6 text-blue-500/50 animate-spin" />
                        </div>
                    ) : sortedEvents.length === 0 ? (
                        <div className="text-center text-sm text-slate-500 py-12">
                            No events yet. Add a note below or change the status to start the timeline.
                        </div>
                    ) : (
                        <ol className="flex flex-col gap-2">
                            {sortedEvents.map((event) => {
                                const Icon = KIND_ICON[event.kind] ?? Mail;
                                const colorClass = KIND_COLOR[event.kind] ?? KIND_COLOR.NOTE;
                                return (
                                    <li key={event.id} className={`rounded-lg border p-3 ${colorClass}`}>
                                        <div className="flex items-start gap-2.5">
                                            <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline justify-between gap-2">
                                                    <span className="font-semibold text-sm text-white truncate">{event.title}</span>
                                                    <span className="text-[10px] text-white/40 uppercase tracking-wider shrink-0">
                                                        {new Date(event.occurredAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                                    </span>
                                                </div>
                                                {event.scheduledAt && (
                                                    <div className="text-xs text-white/60 mt-1">
                                                        scheduled: {new Date(event.scheduledAt).toLocaleString()}
                                                    </div>
                                                )}
                                                {event.notes && event.notes !== event.title && (
                                                    <p className="text-xs text-white/70 mt-1.5 whitespace-pre-wrap">{event.notes}</p>
                                                )}
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </div>

                <form onSubmit={handleAddNote} className="p-4 border-t border-white/10 shrink-0 flex gap-2">
                    <input
                        type="text"
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Add a note…"
                        disabled={!app || savingNote}
                        className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50 disabled:opacity-50"
                    />
                    <button
                        type="submit"
                        disabled={!noteText.trim() || savingNote || !app}
                        className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:bg-blue-500/20 disabled:cursor-not-allowed text-white rounded-md transition-colors flex items-center gap-2"
                    >
                        {savingNote ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Add'}
                    </button>
                </form>
            </div>
        </div>
    );
};
