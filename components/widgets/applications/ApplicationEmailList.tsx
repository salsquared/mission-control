import React from "react";
import { Mail } from "lucide-react";

export interface ApplicationEmailItem {
    id: string;
    subject: string;
    fromAddress: string;
    receivedAt: string;
}

interface Props {
    emails: ApplicationEmailItem[];
    max?: number;
}

function relativeTime(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return "just now";
    const m = Math.floor(ms / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
}

// Pull the display name out of a "Name <addr@x>" header, falling back to
// just the address.
function senderDisplay(from: string): string {
    const angle = from.indexOf("<");
    if (angle > 0) return from.slice(0, angle).trim().replace(/^"|"$/g, "");
    return from;
}

export const ApplicationEmailList: React.FC<Props> = ({ emails, max = 3 }) => {
    if (emails.length === 0) {
        return (
            <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-500 italic">
                <Mail className="w-3 h-3" />
                No emails linked yet.
            </div>
        );
    }

    const shown = emails.slice(0, max);

    return (
        <ul className="mt-3 space-y-1.5">
            {shown.map((e) => (
                <li
                    key={e.id}
                    className="bg-black/20 border border-white/5 rounded-md px-2 py-1.5 text-[10px] leading-tight"
                >
                    <div className="text-slate-200 truncate font-medium">{e.subject}</div>
                    <div className="flex justify-between items-center text-slate-500 mt-0.5">
                        <span className="truncate">{senderDisplay(e.fromAddress)}</span>
                        <span className="shrink-0 ml-2">{relativeTime(e.receivedAt)}</span>
                    </div>
                </li>
            ))}
        </ul>
    );
};
