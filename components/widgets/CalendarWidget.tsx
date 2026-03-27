import React, { useState, useEffect } from "react";
import { Trash2, Clock, Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
}

export const CalendarWidget: React.FC<{isAdding: boolean, setIsAdding: (val: boolean) => void}> = ({isAdding, setIsAdding}) => {
    const { data: session } = useSession();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(false);
    
    const [newEvent, setNewEvent] = useState({
      summary: "",
      start: "",
      end: ""
    });

    const userId = (session?.user as any)?.id;

    const fetchEvents = async () => {
        if (!userId) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/calendar/event?userId=${userId}`);
            const data = await res.json();
            if (data.events) {
                setEvents(data.events);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (userId) {
            fetchEvents();
        }
    }, [userId]);

    const handleCreate = async () => {
        if (!userId || !newEvent.summary || !newEvent.start || !newEvent.end) return;
        setLoading(true);
        try {
            const startISO = new Date(newEvent.start).toISOString();
            const endISO = new Date(newEvent.end).toISOString();
            
            await fetch("/api/calendar/event", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userId,
                    summary: newEvent.summary,
                    start: startISO,
                    end: endISO,
                    description: "Created from Mission Control Pipeline",
                })
            });
            setIsAdding(false);
            setNewEvent({summary: "", start: "", end: ""});
            await fetchEvents();
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (eventId: string) => {
        if (!userId) return;
        setLoading(true);
        try {
            await fetch(`/api/calendar/event?userId=${userId}&eventId=${eventId}`, {
                method: "DELETE",
            });
            await fetchEvents();
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-full w-full">
            <div className="overflow-y-auto flex-1 custom-scrollbar pr-2 space-y-3">
                {isAdding && (
                    <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-3 mb-4">
                        <input 
                            placeholder="Event summary..." 
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-sm text-slate-200" 
                            value={newEvent.summary}
                            onChange={(e) => setNewEvent({...newEvent, summary: e.target.value})}
                        />
                        <div className="flex gap-2 text-xs text-slate-400 items-center">
                            Start: <input type="datetime-local" className="bg-slate-900 border border-slate-700 rounded-lg p-1.5 flex-1" value={newEvent.start} onChange={(e) => setNewEvent({...newEvent, start: e.target.value})}/>
                        </div>
                        <div className="flex gap-2 text-xs text-slate-400 items-center">
                            End: <input type="datetime-local" className="bg-slate-900 border border-slate-700 rounded-lg p-1.5 flex-1" value={newEvent.end} onChange={(e) => setNewEvent({...newEvent, end: e.target.value})}/>
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <button onClick={() => setIsAdding(false)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
                            <button onClick={handleCreate} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg">Save Event</button>
                        </div>
                    </div>
                )}

                {loading && events.length === 0 ? (
                    <div className="flex justify-center items-center py-10">
                        <Loader2 className="w-6 h-6 animate-spin text-blue-500/50" />
                    </div>
                ) : events.length === 0 ? (
                    <div className="text-center text-sm text-slate-500 py-10">No upcoming pipeline events.</div>
                ) : (
                    events.map((ev) => {
                        const sd = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
                        return (
                            <div key={ev.id} className="group relative bg-slate-800 border border-slate-700/50 rounded-xl p-3 hover:border-blue-500/30 transition-all flex justify-between items-start">
                                <div>
                                    <h5 className="text-sm font-semibold text-slate-200">{ev.summary || "Untitled Event"}</h5>
                                    {sd && (
                                        <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1.5">
                                            <Clock className="w-3.5 h-3.5" />
                                            <span>{sd.toLocaleDateString()} at {sd.toLocaleTimeString([], {timeStyle: 'short'})}</span>
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
