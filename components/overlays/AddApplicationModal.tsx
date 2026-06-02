import React, { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import {
    APPLICATION_STATUSES,
    APPLICATION_KINDS,
    APPLICATION_TRACKS,
} from "@/lib/schemas/applications";
import { toastStore } from "@/lib/toast-store";

type AppTrack = typeof APPLICATION_TRACKS[number];

interface AddApplicationModalProps {
    open: boolean;
    onClose: () => void;
    onCreated?: (id: string) => void;
    /**
     * MB Phase 4: track preselected for the form. Defaults to "career". Each
     * pipeline kanban mounts its own modal instance pinned to its track so the
     * `+ Add` button creates a row in the correct pipeline without the user
     * having to remember to set it.
     */
    defaultTrack?: AppTrack;
}

export const AddApplicationModal: React.FC<AddApplicationModalProps> = ({ open, onClose, onCreated, defaultTrack = "career" }) => {
    const [company, setCompany] = useState("");
    const [role, setRole] = useState("");
    const [location, setLocation] = useState("");
    const [status, setStatus] = useState<typeof APPLICATION_STATUSES[number]>("APPLIED");
    const [kind, setKind] = useState<typeof APPLICATION_KINDS[number] | "">("");
    const [track, setTrack] = useState<AppTrack>(defaultTrack);
    const [dateApplied, setDateApplied] = useState("");
    const [submitting, setSubmitting] = useState(false);

    if (!open) return null;

    const reset = () => {
        setCompany("");
        setRole("");
        setLocation("");
        setStatus("APPLIED");
        setKind("");
        setTrack(defaultTrack);
        setDateApplied("");
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!company.trim()) return;
        setSubmitting(true);
        try {
            const result = await api.applications.create({
                company: company.trim(),
                role: role.trim() || null,
                location: location.trim() || null,
                status,
                kind: kind || null,
                track,
                dateApplied: dateApplied ? new Date(dateApplied).toISOString() : null,
            });
            toastStore.push({ message: `Added ${result.application.company}`, type: 'info' });
            reset();
            onClose();
            onCreated?.(result.application.id);
        } catch (e: any) {
            toastStore.push({ message: `Add failed: ${e.message}`, type: 'error' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <div
                className="w-full max-w-md bg-[#111] border border-white/10 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-white/10">
                    <h2 className="text-lg font-semibold text-white">Add Application</h2>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white/10 rounded-md text-white/60 hover:text-white transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Company *</span>
                        <input
                            type="text"
                            value={company}
                            onChange={(e) => setCompany(e.target.value)}
                            required
                            autoFocus
                            placeholder="Acme Corp"
                            className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50"
                        />
                    </label>

                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Role</span>
                        <input
                            type="text"
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                            placeholder="Senior Engineer"
                            className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50"
                        />
                    </label>

                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Location</span>
                        <input
                            type="text"
                            value={location}
                            onChange={(e) => setLocation(e.target.value)}
                            placeholder="Long Beach, CA / Remote"
                            className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-blue-500/50"
                        />
                    </label>

                    <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1.5 text-sm">
                            <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Status</span>
                            <select
                                value={status}
                                onChange={(e) => setStatus(e.target.value as typeof APPLICATION_STATUSES[number])}
                                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-white focus:outline-none focus:border-blue-500/50"
                            >
                                {APPLICATION_STATUSES.map((s) => (
                                    <option key={s} value={s} className="bg-[#111]">{s}</option>
                                ))}
                            </select>
                        </label>

                        <label className="flex flex-col gap-1.5 text-sm">
                            <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Kind</span>
                            <select
                                value={kind}
                                onChange={(e) => setKind(e.target.value as typeof APPLICATION_KINDS[number] | "")}
                                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-white focus:outline-none focus:border-blue-500/50"
                            >
                                <option value="" className="bg-[#111]">—</option>
                                {APPLICATION_KINDS.map((k) => (
                                    <option key={k} value={k} className="bg-[#111]">{k}</option>
                                ))}
                            </select>
                        </label>
                    </div>

                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Track</span>
                        <select
                            value={track}
                            onChange={(e) => setTrack(e.target.value as AppTrack)}
                            className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-white focus:outline-none focus:border-blue-500/50"
                        >
                            {APPLICATION_TRACKS.map((t) => (
                                <option key={t} value={t} className="bg-[#111]">
                                    {t === "career" ? "Career (main pipeline)" : "Side (gig / blue-collar)"}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="text-white/60 text-xs font-medium uppercase tracking-wider">Date Applied</span>
                        <input
                            type="date"
                            value={dateApplied}
                            onChange={(e) => setDateApplied(e.target.value)}
                            className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-white focus:outline-none focus:border-blue-500/50"
                        />
                    </label>

                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5 mt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-white/60 hover:text-white hover:bg-white/5 rounded-md transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting || !company.trim()}
                            className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:bg-blue-500/30 disabled:cursor-not-allowed text-white rounded-md transition-colors flex items-center gap-2"
                        >
                            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            {submitting ? "Adding…" : "Add"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
