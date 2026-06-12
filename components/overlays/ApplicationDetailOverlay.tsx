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
    ChevronDown,
    ChevronRight,
    FileText,
    Users,
    UserPlus,
    Hand,
    Columns2,
    MapPin,
} from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";
import {
    APPLICATION_STATUSES,
    APPLICATION_KINDS,
    APPLICATION_TRACKS,
    type ApplicationsListResponseSchema,
    type ApplicationSchema,
    type ApplicationPatchSchema,
} from "@/lib/schemas/applications";
import type { ApplicationEventSchema } from "@/lib/schemas/applicationEvents";
import type { z } from "zod";
import { toastStore } from "@/lib/toast-store";
import { useServerEvents } from "@/hooks/useServerEvents";

type Application = z.infer<typeof ApplicationSchema>;
type ApplicationsCache = z.infer<typeof ApplicationsListResponseSchema>;
type ApplicationPatch = z.infer<typeof ApplicationPatchSchema>;
type ApplicationEvent = z.infer<typeof ApplicationEventSchema>;

type EditingField = 'company' | 'role' | 'location' | 'nextSteps' | null;

// Closed-jobs Pillar B (P3.2): an unmistakable one-click "Open posting" button
// rendered for ANY application carrying a `url` — including manually-added,
// posting-less apps (the link-less rows the user was fighting). The url is
// populated at track-as-application time (from posting.sourceUrl) and editable
// for manual apps via the POST/PATCH route, so it survives the linked posting
// being pruned. Provenance (the "Closed" badge + "Tracked from") still comes
// from PostingSourceLine when a postingId exists.
const JobLinkButton: React.FC<{ url: string }> = ({ url }) => (
    <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition-colors"
        title="Open job posting in a new tab"
    >
        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
        Open posting ↗
    </a>
);

// Provenance line for posting-linked apps: shows the source URL and a Closed
// badge when the underlying JobPosting has been closed. The primary
// "Open posting" affordance is JobLinkButton (above) — this stays a quieter
// "Tracked from" provenance line.
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

    // The overlay can be opened for an app on either the career or the side
    // kanban, which React Query keeps in two separate caches. Optimistic writes
    // (and their rollbacks) must target whichever cache actually holds this app
    // — otherwise a side-track edit silently patches the empty career cache and
    // the UI never reflects it.
    const careerKey = queryKeys.applications;
    const sideKey = [...queryKeys.applications, 'side'] as const;
    const locateAppCache = () => {
        const career = queryClient.getQueryData<ApplicationsCache>(careerKey);
        if ((career?.applications ?? []).some((a) => a.id === applicationId)) return careerKey;
        return sideKey;
    };

    // Returns a rollback() that restores the pre-patch snapshot of the cache it
    // touched, so callers don't have to track which key it was.
    const optimisticPatch = (patch: Partial<Application>) => {
        const key = locateAppCache();
        const prev = queryClient.getQueryData<ApplicationsCache>(key);
        queryClient.setQueryData<ApplicationsCache>(key, (old) => ({
            applications: (old?.applications ?? []).map((a) =>
                a.id === applicationId ? { ...a, ...patch, lastUpdateAt: new Date().toISOString() } : a
            ),
        }));
        return () => queryClient.setQueryData<ApplicationsCache>(key, prev);
    };

    const saveEdit = async () => {
        if (!editingField || !app) return;
        const val = editValue.trim();
        // Company is required; bail (keep prior value) if it would become empty.
        if (editingField === 'company' && !val) { cancelEdit(); return; }
        const patch: ApplicationPatch = { id: applicationId };
        if (editingField === 'company') patch.company = val;
        if (editingField === 'role') patch.role = val || null;
        if (editingField === 'location') patch.location = val || null;
        if (editingField === 'nextSteps') patch.nextSteps = val || null;
        const rollback = optimisticPatch(patch);
        cancelEdit();
        try {
            await api.applications.update(patch);
        } catch (e) {
            rollback();
            toastStore.push({ message: `Save failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
        }
    };

    const handleKindChange = async (newKind: typeof APPLICATION_KINDS[number] | null) => {
        if (!app) return;
        const rollback = optimisticPatch({ kind: newKind });
        try {
            await api.applications.update({ id: applicationId, kind: newKind });
        } catch (e) {
            rollback();
            toastStore.push({ message: `Update failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
        }
    };

    // MB Phase 4: per-row track flip. The application disappears from the
    // current kanban and reappears in the other on save — the predicate-based
    // invalidation in ApplicationsView's invalidateApps catches both query
    // keys so React Query refetches both lists.
    const handleTrackChange = async (newTrack: typeof APPLICATION_TRACKS[number]) => {
        if (!app || app.track === newTrack) return;
        const rollback = optimisticPatch({ track: newTrack });
        try {
            await api.applications.update({ id: applicationId, track: newTrack });
            // The career-track list still has this row cached as track=career;
            // invalidate by predicate so both `['applications']` and
            // `['applications', 'side']` queries refetch.
            queryClient.invalidateQueries({
                predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'applications',
            });
        } catch (e) {
            rollback();
            toastStore.push({ message: `Track move failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' });
        }
    };

    // Match the EXACT (queryKey, queryFn) pairs ApplicationsView uses for each
    // track. This overlay used to share the `['applications']` key with the
    // parent's career query but pass a different queryFn (no track filter).
    // React Query caches by key alone, so the two fought over one entry and
    // whichever queryFn last ran won — when the career-only dataset won, a
    // clicked side-track app was never in the cache and the header stuck on
    // "Loading…" forever (and which dataset won was timing-dependent → flaky).
    // Reusing the parent's queries means we read its warm cache for both tracks
    // and resolve the app instantly regardless of which kanban it lives on.
    const { data: careerData } = useQuery({
        queryKey: careerKey,
        queryFn: () => api.applications.list({ track: 'career' }),
    });
    const { data: sideData } = useQuery({
        queryKey: sideKey,
        queryFn: () => api.applications.list({ track: 'side' }),
    });
    const app: Application | undefined = useMemo(
        () =>
            [
                ...(careerData?.applications ?? []),
                ...(sideData?.applications ?? []),
            ].find((a) => a.id === applicationId),
        [careerData, sideData, applicationId],
    );

    const eventsKey = queryKeys.applicationEvents({ applicationId });
    const { data: eventsData, isLoading: eventsLoading } = useQuery({
        queryKey: eventsKey,
        queryFn: () => api.applications.events.list({ applicationId }),
    });

    // Server returns occurredAt desc by default. The timeline reads top-down
    // newest-first, which matches the user's mental model ("what happened
    // most recently?") for an open application. Derive `events` inside the
    // memo so the `?? []` doesn't create a fresh array identity each render
    // (which would defeat the memo).
    const sortedEvents = useMemo(() => {
        const events: ApplicationEvent[] = eventsData?.events ?? [];
        return [...events].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    }, [eventsData]);

    const handleStatusChange = async (newStatus: typeof APPLICATION_STATUSES[number]) => {
        if (!app || newStatus === app.status) return;
        const rollback = optimisticPatch({ status: newStatus });
        try {
            await api.applications.update({ id: applicationId, status: newStatus });
            queryClient.invalidateQueries({ queryKey: eventsKey });
        } catch (e) {
            rollback();
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
            queryClient.invalidateQueries({
                predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'applications',
            });
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
                        {app && (
                            editingField === 'location' ? (
                                <input
                                    autoFocus
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onBlur={saveEdit}
                                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                                    placeholder="Location (e.g. Long Beach, CA / Remote)"
                                    className="text-xs bg-black/40 border border-white/20 rounded px-2 py-0.5 text-white w-full mt-1 focus:outline-none focus:border-blue-500/50"
                                />
                            ) : (
                                <p
                                    onClick={() => startEdit('location', app.location ?? '')}
                                    className="mt-1 flex items-center gap-1 text-xs text-slate-400 truncate hover:bg-white/5 rounded px-1 -mx-1 cursor-text"
                                    title="Click to edit location"
                                >
                                    <MapPin className="w-3 h-3 shrink-0 text-slate-500" />
                                    {app.location || <span className="italic text-white/30">Click to add location</span>}
                                </p>
                            )
                        )}
                        {app?.url && <JobLinkButton url={app.url} />}
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
                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                    <span className="text-[10px] uppercase tracking-wider text-white/30 mr-1">Track</span>
                                    {APPLICATION_TRACKS.map((t) => (
                                        <button
                                            key={t}
                                            onClick={() => handleTrackChange(t)}
                                            className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border transition-colors ${
                                                app.track === t
                                                    ? (t === 'career'
                                                        ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                                                        : 'bg-amber-500/20 text-amber-300 border-amber-500/30')
                                                    : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white/70'
                                            }`}
                                            title={t === 'career' ? 'Career — main pipeline' : 'Side — gig / blue-collar pipeline'}
                                        >
                                            {t}
                                        </button>
                                    ))}
                                </div>
                                <div className="mt-3 flex items-center gap-2">
                                    <span className="text-[10px] uppercase tracking-wider text-white/30">Created</span>
                                    <span className="text-xs text-white/70">
                                        {new Date(app.dateApplied ?? app.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                    </span>
                                </div>
                                <div className="mt-3">
                                    <DecisionDeadlineEditor
                                        value={app.decisionDeadline ?? null}
                                        onChange={async (iso) => {
                                            const rollback = optimisticPatch({ decisionDeadline: iso });
                                            try {
                                                await api.applications.update({ id: applicationId, decisionDeadline: iso });
                                                queryClient.invalidateQueries({
                                                    predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'applications',
                                                });
                                            } catch (e) {
                                                rollback();
                                                toastStore.push({ message: `Deadline save failed: ${e instanceof Error ? e.message : String(e)}`, type: "error" });
                                            }
                                        }}
                                    />
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

                {app && <ApplicationContactsSection applicationId={app.id} />}
                {app && <ApplicationResumesSection applicationId={app.id} company={app.company} role={app.role ?? null} />}

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

// ─── Story S11.2: Per-Application Recruiter/Hiring-Manager Contacts ───────

const ApplicationContactsSection: React.FC<{ applicationId: string }> = ({ applicationId }) => {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [adding, setAdding] = useState(false);
    const [draftName, setDraftName] = useState("");
    const [draftEmail, setDraftEmail] = useState("");
    const [draftRole, setDraftRole] = useState("");
    const [busy, setBusy] = useState(false);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.contacts(applicationId),
        queryFn: () => api.applications.contacts.list(applicationId),
        enabled: open,
    });
    const contacts = data?.contacts ?? [];

    useServerEvents("Contact", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.contacts(applicationId) });
    });

    const resetDraft = () => {
        setDraftName("");
        setDraftEmail("");
        setDraftRole("");
    };

    const handleAdd = async () => {
        const name = draftName.trim();
        if (!name) return;
        setBusy(true);
        try {
            await api.applications.contacts.create({
                applicationId,
                name,
                email: draftEmail.trim() || null,
                role: draftRole.trim() || null,
            });
            resetDraft();
            setAdding(false);
            queryClient.invalidateQueries({ queryKey: queryKeys.contacts(applicationId) });
        } catch (e) {
            toastStore.push({ message: `Add contact failed: ${e instanceof Error ? e.message : String(e)}`, type: "error" });
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!window.confirm("Delete this contact?")) return;
        try {
            await api.applications.contacts.delete(id);
            queryClient.invalidateQueries({ queryKey: queryKeys.contacts(applicationId) });
        } catch (e) {
            toastStore.push({ message: `Delete failed: ${e instanceof Error ? e.message : String(e)}`, type: "error" });
        }
    };

    const handleTouch = async (id: string) => {
        try {
            await api.applications.contacts.update({
                id,
                lastTouchedAt: new Date().toISOString(),
            });
            queryClient.invalidateQueries({ queryKey: queryKeys.contacts(applicationId) });
        } catch (e) {
            toastStore.push({ message: `Touch failed: ${e instanceof Error ? e.message : String(e)}`, type: "error" });
        }
    };

    return (
        <div className="px-4 py-3 border-t border-white/10 shrink-0">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="flex items-center justify-between w-full text-left text-xs uppercase tracking-wide text-white/50 hover:text-white/80"
            >
                <span className="flex items-center gap-2">
                    <Users className="w-3.5 h-3.5" />
                    Contacts
                    {contacts.length > 0 && <span className="text-emerald-300/80">({contacts.length})</span>}
                </span>
                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>

            {open && (
                <div className="mt-2 space-y-2">
                    {isLoading ? (
                        <div className="flex items-center gap-2 text-[11px] text-white/40">
                            <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                        </div>
                    ) : contacts.length === 0 ? (
                        <p className="text-[11px] text-white/40 italic">No contacts yet. Add a recruiter or hiring manager to address follow-ups by name.</p>
                    ) : (
                        <ul className="space-y-1">
                            {contacts.map(c => (
                                <li key={c.id} className="flex items-center justify-between gap-2 rounded-md bg-black/30 border border-white/10 px-2.5 py-1.5">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-baseline gap-2 min-w-0">
                                            <span className="text-[12px] text-white/90 truncate">{c.name}</span>
                                            {c.role && (
                                                <span className="text-[10px] text-emerald-300/70 italic shrink-0">{c.role}</span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 text-[10px] text-white/40 mt-0.5">
                                            {c.email && (
                                                <a
                                                    href={`mailto:${c.email}`}
                                                    className="inline-flex items-center gap-1 text-cyan-300/70 hover:text-cyan-200 truncate max-w-[24ch]"
                                                >
                                                    <Mail className="w-2.5 h-2.5" />
                                                    {c.email}
                                                </a>
                                            )}
                                            {c.lastTouchedAt && (
                                                <span title={new Date(c.lastTouchedAt).toLocaleString()}>
                                                    last touched {new Date(c.lastTouchedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => handleTouch(c.id)}
                                            className="p-1 rounded text-white/30 hover:text-emerald-300 transition-colors"
                                            title="Mark as touched (sets last-touched to now)"
                                        >
                                            <Hand className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleDelete(c.id)}
                                            className="p-1 rounded text-white/30 hover:text-rose-400 transition-colors"
                                            title="Delete contact"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}

                    {adding ? (
                        <div className="rounded-md bg-emerald-500/5 border border-emerald-400/20 p-2.5 space-y-2">
                            <input
                                type="text"
                                value={draftName}
                                onChange={e => setDraftName(e.target.value)}
                                placeholder="Name (required)"
                                disabled={busy}
                                autoFocus
                                className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-emerald-400/40"
                            />
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={draftEmail}
                                    onChange={e => setDraftEmail(e.target.value)}
                                    placeholder="Email"
                                    disabled={busy}
                                    className="flex-1 px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-emerald-400/40"
                                />
                                <input
                                    type="text"
                                    value={draftRole}
                                    onChange={e => setDraftRole(e.target.value)}
                                    placeholder="Role (e.g. Recruiter)"
                                    disabled={busy}
                                    className="flex-1 px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-emerald-400/40"
                                />
                            </div>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={handleAdd}
                                    disabled={busy || !draftName.trim()}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/30 text-[11px] font-semibold text-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                                    Add
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setAdding(false); resetDraft(); }}
                                    disabled={busy}
                                    className="px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-[11px] text-white/60"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setAdding(true)}
                            className="flex items-center gap-1.5 text-[11px] text-emerald-300/80 hover:text-emerald-200"
                        >
                            <UserPlus className="w-3 h-3" />
                            Add contact
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

// ─── Story S10.2: side-by-side diff between two GeneratedResume rows ──────

interface DiffSelectionSummary {
    sourceLabel: string;
    originalText: string;
    rewrittenText: string;
    matchedKeywords: string[];
}
function asSelectionSummary(raw: unknown): DiffSelectionSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    return {
        sourceLabel: typeof r.sourceLabel === 'string' ? r.sourceLabel : '',
        originalText: typeof r.originalText === 'string' ? r.originalText : '',
        rewrittenText: typeof r.rewrittenText === 'string' ? r.rewrittenText : '',
        matchedKeywords: Array.isArray(r.matchedKeywords)
            ? r.matchedKeywords.filter((x): x is string => typeof x === 'string')
            : [],
    };
}

const ResumeDiffPanel: React.FC<{ a: string; b: string; onClose: () => void }> = ({ a, b, onClose }) => {
    const { data, isLoading, error } = useQuery({
        queryKey: ['resumes', 'diff', a, b],
        queryFn: () => api.resumes.diff(a, b),
    });

    if (isLoading) {
        return (
            <div className="mt-2 rounded-md bg-black/30 border border-white/10 p-3 flex items-center gap-2 text-[11px] text-white/40">
                <Loader2 className="w-3 h-3 animate-spin" /> Diffing…
            </div>
        );
    }
    if (error || !data) {
        return (
            <div className="mt-2 rounded-md bg-rose-500/10 border border-rose-400/20 p-3 text-[11px] text-rose-200">
                Diff failed: {error instanceof Error ? error.message : 'Unknown error'}
                <button onClick={onClose} className="ml-2 underline">close</button>
            </div>
        );
    }

    const d = data.diff;
    const aLabel = `${d.a.company ?? '?'}${d.a.title ? ` · ${d.a.title}` : ''}`;
    const bLabel = `${d.b.company ?? '?'}${d.b.title ? ` · ${d.b.title}` : ''}`;

    return (
        <div className="mt-2 rounded-md bg-black/30 border border-purple-400/20 p-3 space-y-3">
            <div className="flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wide text-purple-300/80">
                    Comparing {new Date(d.a.createdAt).toLocaleDateString()} ↔ {new Date(d.b.createdAt).toLocaleDateString()}
                </div>
                <button onClick={onClose} className="text-white/40 hover:text-white/80">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded bg-rose-500/5 border border-rose-400/20 px-2 py-1">
                    <span className="text-rose-300/80 font-semibold">A:</span> <span className="text-white/70">{aLabel}</span>
                </div>
                <div className="rounded bg-emerald-500/5 border border-emerald-400/20 px-2 py-1">
                    <span className="text-emerald-300/80 font-semibold">B:</span> <span className="text-white/70">{bLabel}</span>
                </div>
            </div>

            <div className="text-[11px] text-white/50">
                {d.summary.keywordsChanged} keyword{d.summary.keywordsChanged === 1 ? '' : 's'} different ·
                {' '}{d.summary.selectionsChanged} selection{d.summary.selectionsChanged === 1 ? '' : 's'} different ·
                {' '}{d.summary.rewritesChanged} rewrite{d.summary.rewritesChanged === 1 ? '' : 's'} differ
            </div>

            {/* Keyword deltas */}
            {(d.keywords.onlyA.length > 0 || d.keywords.onlyB.length > 0) && (
                <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-white/40">Posting keywords</div>
                    {d.keywords.onlyA.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            <span className="text-[10px] text-rose-300/80">only in A:</span>
                            {d.keywords.onlyA.map(k => (
                                <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 text-rose-200">{k}</span>
                            ))}
                        </div>
                    )}
                    {d.keywords.onlyB.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            <span className="text-[10px] text-emerald-300/80">only in B:</span>
                            {d.keywords.onlyB.map(k => (
                                <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-200">{k}</span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Selections in only one */}
            {d.selections.onlyA.length > 0 && (
                <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-rose-300/80">
                        Bullets only in A ({d.selections.onlyA.length})
                    </div>
                    <ul className="space-y-1">
                        {d.selections.onlyA.map(asSelectionSummary).filter((s): s is DiffSelectionSummary => s !== null).map((s, i) => (
                            <li key={i} className="text-[11px] text-rose-100/90 bg-rose-500/5 border border-rose-500/15 rounded px-2 py-1">
                                <span className="text-rose-300/70 italic">{s.sourceLabel}:</span> {s.rewrittenText || s.originalText}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {d.selections.onlyB.length > 0 && (
                <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-emerald-300/80">
                        Bullets only in B ({d.selections.onlyB.length})
                    </div>
                    <ul className="space-y-1">
                        {d.selections.onlyB.map(asSelectionSummary).filter((s): s is DiffSelectionSummary => s !== null).map((s, i) => (
                            <li key={i} className="text-[11px] text-emerald-100/90 bg-emerald-500/5 border border-emerald-500/15 rounded px-2 py-1">
                                <span className="text-emerald-300/70 italic">{s.sourceLabel}:</span> {s.rewrittenText || s.originalText}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Shared bullets with rewrite differences */}
            {d.selections.shared.some(s => s.rewriteChanged) && (
                <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-white/40">
                        Same bullet, rewritten differently ({d.selections.shared.filter(s => s.rewriteChanged).length})
                    </div>
                    <ul className="space-y-2">
                        {d.selections.shared.filter(s => s.rewriteChanged).map(s => {
                            const aSum = asSelectionSummary(s.a);
                            const bSum = asSelectionSummary(s.b);
                            if (!aSum || !bSum) return null;
                            return (
                                <li key={s.bulletId} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px]">
                                    <div className="text-white/40 italic mb-1">{aSum.sourceLabel || bSum.sourceLabel}</div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="text-rose-100/90"><span className="text-rose-300/70">A:</span> {aSum.rewrittenText}</div>
                                        <div className="text-emerald-100/90"><span className="text-emerald-300/70">B:</span> {bSum.rewrittenText}</div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {d.summary.keywordsChanged === 0 && d.summary.selectionsChanged === 0 && d.summary.rewritesChanged === 0 && (
                <div className="text-[11px] text-white/50 italic">
                    These two resumes are functionally identical — same keywords, same bullets, same rewrites.
                </div>
            )}
        </div>
    );
};

// ─── M8-2.4: Per-Application Generate + "Resumes sent" section ─────────

const ApplicationResumesSection: React.FC<{ applicationId: string; company: string; role: string | null }> = ({ applicationId, company, role }) => {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [postingUrl, setPostingUrl] = useState("");
    const [postingText, setPostingText] = useState("");
    const [generating, setGenerating] = useState(false);
    // Story S10.2 — multi-select for diff. Up to 2 ids; selecting a 3rd kicks
    // out the oldest pick (FIFO) so the user doesn't have to manually
    // deselect before recomparing.
    const [selectedForDiff, setSelectedForDiff] = useState<string[]>([]);
    const [diffPair, setDiffPair] = useState<{ a: string; b: string } | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.resumes({ applicationId }),
        queryFn: () => api.resumes.list({ applicationId }),
        enabled: open,
    });
    const resumes = data?.resumes ?? [];

    const toggleSelect = (id: string) => {
        setSelectedForDiff(prev => {
            if (prev.includes(id)) return prev.filter(x => x !== id);
            const next = [...prev, id];
            return next.length > 2 ? next.slice(-2) : next;
        });
    };
    const canCompare = selectedForDiff.length === 2;

    async function handleGenerate() {
        if (generating) return;
        if (!postingUrl.trim() && !postingText.trim()) return;
        setGenerating(true);
        try {
            const res = await fetch("/api/resumes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    posting: {
                        url: postingUrl.trim() || undefined,
                        text: postingText.trim() || undefined,
                    },
                    applicationId,
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const resumeId = res.headers.get("X-Resume-Id");
            const fmt = res.headers.get("X-Resume-Format") ?? "pdf";
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            if (fmt === "pdf") {
                window.open(url, "_blank");
            } else {
                const a = document.createElement("a");
                a.href = url;
                a.download = `resume-${company}-${new Date().toISOString().slice(0, 10)}.docx`;
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
            toastStore.push({ message: `Resume generated for ${company} (${fmt.toUpperCase()})`, type: "info" });
            setPostingUrl("");
            setPostingText("");
            if (resumeId) {
                queryClient.invalidateQueries({ queryKey: queryKeys.resumes({ applicationId }) });
            }
        } catch (e) {
            toastStore.push({ message: `Generate failed: ${e instanceof Error ? e.message : String(e)}`, type: "error" });
        } finally {
            setGenerating(false);
        }
    }

    return (
        <div className="px-4 py-3 border-t border-white/10 shrink-0">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="flex items-center justify-between w-full text-left text-xs uppercase tracking-wide text-white/50 hover:text-white/80"
            >
                <span>Resumes for this application{resumes.length > 0 && <span className="ml-2 text-purple-300/80">({resumes.length})</span>}</span>
                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>

            {open && (
                <div className="mt-2 space-y-3">
                    {/* Existing resumes */}
                    {isLoading ? (
                        <div className="flex items-center gap-2 text-[11px] text-white/40">
                            <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                        </div>
                    ) : resumes.length === 0 ? (
                        <p className="text-[11px] text-white/40 italic">No resumes generated for this application yet.</p>
                    ) : (
                        <>
                            <ul className="space-y-1">
                                {resumes.map(r => {
                                    const checked = selectedForDiff.includes(r.id);
                                    return (
                                        <li key={r.id} className="flex items-center justify-between rounded-md bg-black/30 border border-white/10 px-2.5 py-1.5">
                                            <div className="flex items-center gap-2 min-w-0">
                                                {resumes.length >= 2 && (
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() => toggleSelect(r.id)}
                                                        title="Pick two to compare"
                                                        className="accent-purple-500 cursor-pointer"
                                                    />
                                                )}
                                                <span className="text-[10px] uppercase tracking-wide text-purple-300/80 bg-purple-500/10 px-1.5 py-0.5 rounded">
                                                    {r.format}
                                                </span>
                                                <span className="text-[11px] text-white/70">
                                                    {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' })}
                                                </span>
                                                {r.status === 'failed' && (
                                                    <span className="text-[10px] text-red-300/80 bg-red-500/10 border border-red-500/20 px-1 rounded">failed</span>
                                                )}
                                            </div>
                                            {r.hasArtifact ? (
                                                <a
                                                    href={api.resumes.downloadUrl(r.id)}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-[11px] text-purple-300 hover:text-purple-200 underline underline-offset-2"
                                                >
                                                    Download
                                                </a>
                                            ) : (
                                                <span className="text-[10px] text-white/30">no file</span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>

                            {resumes.length >= 2 && (
                                <div className="flex items-center gap-2 text-[11px] text-white/50">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (!canCompare) return;
                                            setDiffPair({ a: selectedForDiff[0], b: selectedForDiff[1] });
                                        }}
                                        disabled={!canCompare}
                                        className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-purple-500/15 hover:bg-purple-500/25 border border-purple-400/20 text-purple-100 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <Columns2 className="w-3 h-3" />
                                        Compare selected
                                    </button>
                                    <span className="text-white/40">
                                        {selectedForDiff.length === 0 && "Pick two resumes to diff."}
                                        {selectedForDiff.length === 1 && "Pick one more to diff."}
                                        {selectedForDiff.length === 2 && "Ready to compare."}
                                    </span>
                                </div>
                            )}

                            {diffPair && (
                                <ResumeDiffPanel
                                    a={diffPair.a}
                                    b={diffPair.b}
                                    onClose={() => setDiffPair(null)}
                                />
                            )}
                        </>
                    )}

                    {/* Generate-for-this-application form */}
                    <div className="rounded-md bg-purple-500/5 border border-purple-400/20 p-2.5 space-y-2">
                        <div className="text-[11px] text-white/60">
                            Generate a tailored resume for <span className="text-white/90">{role || "this role"}</span> at <span className="text-white/90">{company}</span>.
                        </div>
                        <input
                            type="url"
                            value={postingUrl}
                            onChange={e => setPostingUrl(e.target.value)}
                            placeholder="Posting URL (optional)"
                            disabled={generating}
                            className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40"
                        />
                        <textarea
                            value={postingText}
                            onChange={e => setPostingText(e.target.value)}
                            placeholder="Or paste posting text…"
                            disabled={generating}
                            rows={3}
                            className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-purple-400/40 resize-y"
                        />
                        <button
                            type="button"
                            onClick={handleGenerate}
                            disabled={generating || (!postingUrl.trim() && !postingText.trim())}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-[11px] font-semibold text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                            {generating ? "Generating…" : "Generate"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

// Story S6.3 — decision-deadline inline editor. Renders as a date input so the
// underlying ISO datetime is easy to set/clear. Empty value clears the field
// (sets the column to NULL). Anchored to noon UTC so it doesn't drift across
// timezone boundaries when displayed.
// Module-scope so the React compiler doesn't flag the `Date.now()` call as
// an impure call from within render (same pattern as `fmtRelative` elsewhere).
function deadlineBadge(value: string | null): { text: string; cls: string } | null {
    if (!value) return null;
    const daysOut = Math.round((new Date(value).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysOut < 0) return { text: `${Math.abs(daysOut)}d ago`, cls: "text-rose-300 bg-rose-500/10 border-rose-500/30" };
    if (daysOut === 0) return { text: "today", cls: "text-amber-300 bg-amber-500/10 border-amber-500/30" };
    if (daysOut <= 3) return { text: `in ${daysOut}d`, cls: "text-amber-300 bg-amber-500/10 border-amber-500/30" };
    return { text: `in ${daysOut}d`, cls: "text-white/50 bg-white/5 border-white/10" };
}

const DecisionDeadlineEditor: React.FC<{
    value: string | null;
    onChange: (iso: string | null) => void | Promise<void>;
}> = ({ value, onChange }) => {
    const dateStr = value ? value.slice(0, 10) : "";
    const badge = deadlineBadge(value);
    return (
        <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-white/30">Decision deadline</span>
            <input
                type="date"
                value={dateStr}
                onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) { void onChange(null); return; }
                    void onChange(new Date(`${raw}T12:00:00.000Z`).toISOString());
                }}
                className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-xs text-white/80 focus:outline-none focus:border-amber-500/40"
            />
            {badge && (
                <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge.cls}`}>
                    {badge.text}
                </span>
            )}
            {value && (
                <button
                    type="button"
                    onClick={() => void onChange(null)}
                    className="text-[10px] text-white/30 hover:text-white/70 underline underline-offset-2"
                    title="Clear deadline"
                >
                    clear
                </button>
            )}
        </div>
    );
};
