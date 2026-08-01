import React, { useState, useCallback, useMemo } from "react";
import { Trash2, Clock, Loader2, Link2 } from "lucide-react";
import { useAccount } from "@/hooks/useAccount";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";
import type { z } from "zod";
import type { ApplicationEventSchema, ApplicationEventPostSchema } from "@/lib/schemas/applicationEvents";

type ApplicationEvent = z.infer<typeof ApplicationEventSchema>;
type ApplicationEventKind = z.infer<typeof ApplicationEventPostSchema>["kind"];

const UPCOMING_KINDS: readonly ApplicationEventKind[] = ["INTERVIEW_SCHEDULED", "ASSESSMENT_REQUESTED"] as const;
const QUERY_FILTER = { upcoming: true, kinds: UPCOMING_KINDS };

const KIND_LABEL: Record<ApplicationEventKind, string> = {
    APPLIED: "Applied",
    STATUS_CHANGED: "Status changed",
    EMAIL_RECEIVED: "Email",
    ASSESSMENT_REQUESTED: "Assessment",
    INTERVIEW_SCHEDULED: "Interview",
    OFFER: "Offer",
    REJECTION: "Rejection",
    NOTE: "Note",
};

// Mirrors the pipeline kanban color motif so the calendar tiles read as
// the same "stage" badges users already recognize on the kanban.
const KIND_ACCENT: Record<ApplicationEventKind, { bar: string; text: string }> = {
    INTERVIEW_SCHEDULED: { bar: "bg-amber-500/20", text: "text-amber-500" },
    ASSESSMENT_REQUESTED: { bar: "bg-purple-500/20", text: "text-purple-400" },
    APPLIED: { bar: "bg-blue-500/20", text: "text-blue-400" },
    OFFER: { bar: "bg-emerald-500/20", text: "text-emerald-400" },
    REJECTION: { bar: "bg-slate-500/20", text: "text-slate-400" },
    STATUS_CHANGED: { bar: "bg-slate-500/20", text: "text-slate-400" },
    EMAIL_RECEIVED: { bar: "bg-slate-500/20", text: "text-slate-400" },
    NOTE: { bar: "bg-slate-500/20", text: "text-slate-400" },
};

interface CalendarWidgetProps {
    isAdding: boolean;
    setIsAdding: (val: boolean) => void;
    isEditing?: boolean;
}

export const CalendarWidget: React.FC<CalendarWidgetProps> = ({ isAdding, setIsAdding, isEditing = false }) => {
    const { user, role } = useAccount();
    const userId = user?.id ?? null;
    const queryClient = useQueryClient();

    // Link-from-Google mode is OWNER-ONLY (docs/multi-user-crew.html P3.7, OQ6a):
    // both of its calls — `gcal-candidates` and `adopt` — reach
    // `getGoogleAuthClient`, which throws for a crew member (no `Account` row).
    // The gate lives HERE, inside the widget, rather than at either mount site,
    // because the widget renders on both crew dashes — ApplicationsView (the
    // Upcoming Interviews card) and ToDoCard's calendar mode on PlanningView —
    // and gating one call site would leave the other live.
    //
    // `role === 'owner'`, not `role !== 'crew'`: `role` is `undefined` until
    // /api/account resolves, and the unknown-role window must behave like crew
    // (no owner-only request may leave the client before we know who is asking).
    // The mode also never renders and then vanishes — it appears only once the
    // owner is confirmed.
    const isOwner = role === 'owner';

    const { data: eventsResponse, isLoading } = useQuery({
        queryKey: queryKeys.applicationEvents(QUERY_FILTER),
        queryFn: () => api.applications.events.list(QUERY_FILTER),
        enabled: Boolean(userId),
    });
    const events: ApplicationEvent[] = eventsResponse?.events ?? [];

    // Apps list — needed for the "add event" picker. Re-uses the same query
    // key as the Pipeline kanban so we share the cache.
    const { data: appsResponse } = useQuery({
        queryKey: queryKeys.applications,
        queryFn: () => api.applications.list(),
        enabled: Boolean(userId) && isAdding,
    });
    const apps = appsResponse?.applications ?? [];

    const invalidate = useCallback(
        () => queryClient.invalidateQueries({ queryKey: ['application-events'] }),
        [queryClient]
    );
    useServerEvents("CalendarEvent", invalidate);

    const [submitting, setSubmitting] = useState(false);
    const [mode, setMode] = useState<"create" | "link">("create");
    const loading = isLoading || submitting;

    // The mode the widget actually RENDERS and QUERIES on. Derived rather than
    // read straight off state so a non-owner can never be in "link" — not even
    // transiently, e.g. if the owner picked it and the account query later
    // resolved to something else. Every downstream read uses `activeMode`; only
    // the toggle (owner-only, below) writes `mode`.
    const activeMode = isOwner ? mode : "create";

    const { data: candidatesResponse, isLoading: candidatesLoading } = useQuery({
        queryKey: ['gcal-candidates'],
        queryFn: () => api.applications.events.gcalCandidates(),
        // `isOwner` first: this is the fetch gate, not just the button gate.
        // Never enabled for crew or during the unknown-role window.
        enabled: isOwner && Boolean(userId) && isAdding && activeMode === "link",
    });
    const candidates = candidatesResponse?.candidates ?? [];

    const [newEvent, setNewEvent] = useState<{
        applicationId: string;
        kind: ApplicationEventKind;
        title: string;
        start: string;
        end: string;
        notes: string;
    }>({
        applicationId: "",
        kind: "INTERVIEW_SCHEDULED",
        title: "",
        start: "",
        end: "",
        notes: "",
    });

    const handleCreate = async () => {
        if (!newEvent.applicationId || !newEvent.title || !newEvent.start) return;
        setSubmitting(true);
        try {
            await api.applications.events.create({
                applicationId: newEvent.applicationId,
                kind: newEvent.kind,
                title: newEvent.title,
                scheduledAt: new Date(newEvent.start).toISOString(),
                endsAt: newEvent.end ? new Date(newEvent.end).toISOString() : undefined,
                notes: newEvent.notes || undefined,
            });
            setIsAdding(false);
            setNewEvent({ applicationId: "", kind: "INTERVIEW_SCHEDULED", title: "", start: "", end: "", notes: "" });
            await invalidate();
        } catch (e) {
            console.error(e);
        } finally {
            setSubmitting(false);
        }
    };

    const handleAdopt = async (gcalEventId: string) => {
        // Owner-only route (`/api/applications/events/adopt`). Unreachable from
        // the UI below, which never renders the candidate list for a non-owner —
        // this is the belt to that braces, so the guard is on the call and not
        // only on the control that makes it.
        if (!isOwner) return;
        if (!newEvent.applicationId) {
            toastStore.push({ message: 'Pick an application first', type: 'warning' });
            return;
        }
        setSubmitting(true);
        try {
            await api.applications.events.adopt({
                applicationId: newEvent.applicationId,
                gcalEventId,
                kind: newEvent.kind,
            });
            setIsAdding(false);
            setNewEvent({ applicationId: "", kind: "INTERVIEW_SCHEDULED", title: "", start: "", end: "", notes: "" });
            setMode("create");
            await invalidate();
            queryClient.invalidateQueries({ queryKey: ['gcal-candidates'] });
        } catch (e: any) {
            toastStore.push({ message: `Adopt failed: ${e.message}`, type: 'error' });
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (eventId: string) => {
        setSubmitting(true);
        try {
            await api.applications.events.delete(eventId);
            await invalidate();
        } catch (e) {
            console.error(e);
        } finally {
            setSubmitting(false);
        }
    };

    const sortedEvents = useMemo(
        () =>
            [...events].sort(
                (a, b) =>
                    new Date(a.scheduledAt ?? 0).getTime() - new Date(b.scheduledAt ?? 0).getTime()
            ),
        [events]
    );

    return (
        <div className="flex flex-col h-full w-full">
            <div className="overflow-y-auto flex-1 custom-scrollbar pr-2">
                {isAdding && (
                    <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-3 mb-4">
                        {/* Owner-only. Hidden whole for crew rather than shown
                            disabled: "Link Gcal event" advertises a Google
                            connection crew will never have (OQ6a), and a
                            one-option switch is not a switch. */}
                        {isOwner && (
                            <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-700 w-fit">
                                <button
                                    onClick={() => setMode("create")}
                                    className={`px-3 py-1.5 text-xs rounded-md transition-all ${activeMode === "create" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
                                >
                                    New event
                                </button>
                                <button
                                    onClick={() => setMode("link")}
                                    className={`px-3 py-1.5 text-xs rounded-md transition-all ${activeMode === "link" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
                                >
                                    Link Gcal event
                                </button>
                            </div>
                        )}

                        <select
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-slate-200"
                            value={newEvent.applicationId}
                            onChange={(e) => setNewEvent({ ...newEvent, applicationId: e.target.value })}
                        >
                            <option value="">Select application…</option>
                            {apps.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.company}{a.role ? ` — ${a.role}` : ""}
                                </option>
                            ))}
                        </select>
                        <select
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-slate-200"
                            value={newEvent.kind}
                            onChange={(e) => setNewEvent({ ...newEvent, kind: e.target.value as ApplicationEventKind })}
                        >
                            <option value="INTERVIEW_SCHEDULED">Interview</option>
                            <option value="ASSESSMENT_REQUESTED">Assessment</option>
                            <option value="NOTE">Note</option>
                        </select>

                        {activeMode === "create" ? (
                            <>
                                <input
                                    placeholder="Title (e.g. 'Final round interview')"
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-slate-200"
                                    value={newEvent.title}
                                    onChange={(e) => setNewEvent({ ...newEvent, title: e.target.value })}
                                />
                                <div className="flex gap-2 text-xs text-slate-400 items-center">
                                    Start: <input type="datetime-local" className="bg-slate-900 border border-slate-700 rounded-lg p-1.5 flex-1" value={newEvent.start} onChange={(e) => setNewEvent({ ...newEvent, start: e.target.value })} />
                                </div>
                                <div className="flex gap-2 text-xs text-slate-400 items-center">
                                    End: <input type="datetime-local" className="bg-slate-900 border border-slate-700 rounded-lg p-1.5 flex-1" value={newEvent.end} onChange={(e) => setNewEvent({ ...newEvent, end: e.target.value })} />
                                </div>
                                <textarea
                                    placeholder="Notes (optional)"
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-slate-200 resize-none"
                                    rows={2}
                                    value={newEvent.notes}
                                    onChange={(e) => setNewEvent({ ...newEvent, notes: e.target.value })}
                                />
                                <div className="flex justify-end gap-2 pt-2">
                                    <button onClick={() => setIsAdding(false)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
                                    <button onClick={handleCreate} disabled={!newEvent.applicationId || !newEvent.title || !newEvent.start} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400 text-white rounded-lg">Save Event</button>
                                </div>
                            </>
                        ) : (
                            <div className="space-y-2">
                                <p className="text-xs text-slate-400">Pick a Gcal event in the next 90 days to attach to this application.</p>
                                {candidatesLoading ? (
                                    <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="w-3 h-3 animate-spin" /> loading candidates…</div>
                                ) : candidates.length === 0 ? (
                                    <div className="text-xs text-slate-500">No untagged Gcal events found in the next 90 days.</div>
                                ) : (
                                    <div className="max-h-48 overflow-y-auto space-y-1.5 custom-scrollbar pr-1">
                                        {candidates.map((c) => {
                                            const sd = new Date(c.scheduledAt);
                                            return (
                                                <button
                                                    key={c.gcalEventId}
                                                    onClick={() => handleAdopt(c.gcalEventId)}
                                                    disabled={!newEvent.applicationId || submitting}
                                                    className="w-full text-left p-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-md text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                    <div className="font-semibold text-slate-200 truncate flex items-center gap-1.5">
                                                        <Link2 className="w-3 h-3 text-emerald-400" />
                                                        {c.summary}
                                                    </div>
                                                    <div className="text-slate-500 text-[10px] mt-0.5">{sd.toLocaleString()}</div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                <div className="flex justify-end gap-2 pt-2">
                                    <button onClick={() => setIsAdding(false)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Both zero-states center on BOTH axes, not just horizontally.
                    `text-center` alone left them pinned to the top of the scroll
                    region with a tall void beneath, which is what a fixed-height
                    mount makes obvious.

                    `h-full` and `py-10` are both load-bearing because the two
                    mount sites size differently. ApplicationsView's card is
                    `h-[40vh]` — definite, so `h-full` resolves and the flex
                    centering takes over (the padding just insets harmlessly).
                    ToDoCard's is `max-h-[65vh]` — auto until it hits the cap, and
                    a percentage height does not resolve against an auto-height
                    parent, so there `h-full` is inert and `py-10` keeps the old
                    spacing. Content-hugging there means there is no void to
                    center in anyway. Dropping either class regresses one site. */}
                {loading && sortedEvents.length === 0 ? (
                    <div className="flex h-full items-center justify-center py-10">
                        <Loader2 className="w-6 h-6 animate-spin text-blue-500/50" />
                    </div>
                ) : sortedEvents.length === 0 ? (
                    <div className="flex h-full items-center justify-center py-10 text-center text-sm text-slate-500">No upcoming pipeline events.</div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {sortedEvents.map((ev) => {
                            const sd = ev.scheduledAt ? new Date(ev.scheduledAt) : null;
                            const company = ev.application?.company;
                            const accent = KIND_ACCENT[ev.kind];
                            return (
                                <div key={ev.id} className="group relative bg-black/40 border border-white/5 rounded-xl px-3 py-2 shadow-xl hover:border-white/20 hover:bg-black/60 transition-all overflow-hidden">
                                    <div className={`absolute top-0 left-0 w-1 h-full ${accent.bar} opacity-50`}></div>
                                    <div className="flex justify-between items-start gap-2">
                                        <h5 className="text-sm font-semibold text-slate-100 truncate flex-1 leading-tight">{ev.title}</h5>
                                        <span className="text-xs text-slate-400 truncate shrink-0 max-w-[45%] text-right leading-tight">{company ?? 'Unknown'}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2 mt-1.5">
                                        {sd ? (
                                            <div className="flex items-center gap-1.5 text-xs text-slate-400 min-w-0">
                                                <Clock className="w-3.5 h-3.5 shrink-0" />
                                                <span className="truncate">{sd.toLocaleDateString()} at {sd.toLocaleTimeString([], { timeStyle: 'short' })}</span>
                                            </div>
                                        ) : <span />}
                                        <div className="flex items-center gap-2 shrink-0">
                                            {isEditing && (
                                                <button
                                                    onClick={() => handleDelete(ev.id)}
                                                    className="p-1 -m-1 text-slate-500 hover:text-red-400 transition-colors cursor-pointer"
                                                    title="Delete event"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                            <span className={`${accent.text} text-[10px] uppercase tracking-widest font-bold`}>{KIND_LABEL[ev.kind]}</span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};
