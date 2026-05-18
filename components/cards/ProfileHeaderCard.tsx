import React from "react";
import { User as UserIcon, Mail, Phone, MapPin } from "lucide-react";
import { Card } from "../ui/Card";
import { EditableField } from "../ui/EditableField";
import type { ProfileLink } from "@/lib/repositories/profile";

interface ProfileHeaderCardProps {
    headline: string | null;
    summary: string | null;
    location: string | null;
    email: string | null;
    phone: string | null;
    links: ProfileLink[] | null;
    onSave: (patch: {
        headline?: string | null;
        summary?: string | null;
        location?: string | null;
        email?: string | null;
        phone?: string | null;
        links?: ProfileLink[] | null;
    }) => void;
}

export const ProfileHeaderCard: React.FC<ProfileHeaderCardProps> = ({
    headline,
    summary,
    location,
    email,
    phone,
    onSave,
}) => {
    return (
        <Card
            title="Personal info"
            icon={UserIcon}
            iconColorClass="text-purple-400"
        >
            <div className="flex flex-col gap-3">
                <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/30">Headline</span>
                    <EditableField
                        value={headline}
                        onSave={(v) => onSave({ headline: v })}
                        placeholder="Click to add a headline (e.g. 'Senior Engineer · Distributed Systems')"
                        readClassName="text-lg font-semibold text-white"
                    />
                </div>
                <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/30">Summary</span>
                    <EditableField
                        value={summary}
                        onSave={(v) => onSave({ summary: v })}
                        placeholder="One-paragraph elevator pitch"
                        multiline
                        readClassName="text-sm text-white/70 whitespace-pre-wrap"
                    />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-1">
                    <div className="flex items-center gap-2">
                        <MapPin className="w-3.5 h-3.5 text-white/40 shrink-0" />
                        <EditableField
                            value={location}
                            onSave={(v) => onSave({ location: v })}
                            placeholder="Location"
                            readClassName="text-sm text-white/80"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <Mail className="w-3.5 h-3.5 text-white/40 shrink-0" />
                        <EditableField
                            value={email}
                            onSave={(v) => onSave({ email: v })}
                            placeholder="Email"
                            type="email"
                            readClassName="text-sm text-white/80"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <Phone className="w-3.5 h-3.5 text-white/40 shrink-0" />
                        <EditableField
                            value={phone}
                            onSave={(v) => onSave({ phone: v })}
                            placeholder="Phone"
                            type="tel"
                            readClassName="text-sm text-white/80"
                        />
                    </div>
                </div>
            </div>
        </Card>
    );
};
