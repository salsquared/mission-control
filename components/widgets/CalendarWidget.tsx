import React, { useState, useCallback, useMemo } from "react";
import { Trash2, Clock, Loader2, Briefcase, Link2 } from "lucide-react";
import { useSession } from "next-auth/react";
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

interface CalendarWidgetProps {
    isAdding: boolean;
    setIsAdding: (val: boolean) => void;
}

export const CalendarWidget: React.FC<CalendarWidgetProps> = ({ isAdding, setIsAdding }) => {
    const { data: session } = useSession();
    const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
    const queryClient = useQueryClient();

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

    const { data: candidatesResponse, isLoading: candidatesLoading } = useQuery({
        queryKey: ['gcal-candidates'],
        queryFn: () => api.applications.events.gcalCandidates(),
        enabled: Boolean(userId) && isAdding && mode === "link",
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
            <div className="overflow-y-auto flex-1 custom-scrollbar pr-2 space-y-3">
                {isAdding && (
                    <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-3 mb-4">
                        <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-700 w-fit">
                            <button
                                onClick={() => setMode("create")}
                                className={`px-3 py-1.5 text-xs rounded-md transition-all ${mode === "create" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
                            >
                                New event
                            </button>
                            <button
                                onClick={() => setMode("link")}
                                className={`px-3 py-1.5 text-xs rounded-md transition-all ${mode === "link" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
                            >
                                Link Gcal event
                            </button>
                        </div>

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

                        {mode === "create" ? (
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

                {loading && sortedEvents.length === 0 ? (
                    <div className="flex justify-center items-center py-10">
                        <Loader2 className="w-6 h-6 animate-spin text-blue-500/50" />
                    </div>
                ) : sortedEvents.length === 0 ? (
                    <div className="text-center text-sm text-slate-500 py-10">No upcoming pipeline events.</div>
                ) : (
                    sortedEvents.map((ev) => {
                        const sd = ev.scheduledAt ? new Date(ev.scheduledAt) : null;
                        const company = ev.application?.company;
                        return (
                            <div key={ev.id} className="group relative bg-slate-800 border border-slate-700/50 rounded-xl p-3 hover:border-blue-500/30 transition-all flex justify-between items-start">
                                <div className="min-w-0">
                                    <h5 className="text-sm font-semibold text-slate-200 truncate">{ev.title}</h5>
                                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-blue-400/80 mt-1">
                                        <Briefcase className="w-3 h-3" />
                                        <span className="truncate">{company ?? 'Unknown'} · {KIND_LABEL[ev.kind]}</span>
                                    </div>
                                    {sd && (
                                        <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1.5">
                                            <Clock className="w-3.5 h-3.5" />
                                            <span>{sd.toLocaleDateString()} at {sd.toLocaleTimeString([], { timeStyle: 'short' })}</span>
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => handleDelete(ev.id)}
                                    className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-all shrink-0 cursor-pointer"
                                    title="Delete event"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};
