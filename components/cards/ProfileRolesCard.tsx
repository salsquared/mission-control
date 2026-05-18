import React from "react";
import { Briefcase, Plus } from "lucide-react";
import { Card } from "../ui/Card";
import { WorkRoleCard } from "./WorkRoleCard";
import type { Bullet } from "@/lib/profile/types";
import type { WorkRoleWire } from "@/lib/schemas/profile";

type WorkRolePatch = Partial<{
    company: string;
    title: string;
    location: string | null;
    startDate: string;
    endDate: string | null;
    bullets: Bullet[];
    position: number;
}>;

interface ProfileRolesCardProps {
    workRoles: WorkRoleWire[];
    onUpdate: (id: string, patch: WorkRolePatch) => void;
    onDelete: (id: string) => void;
    onSwap: (idx: number, delta: -1 | 1) => void;
    onAdd: () => void;
}

export const ProfileRolesCard: React.FC<ProfileRolesCardProps> = ({
    workRoles,
    onUpdate,
    onDelete,
    onSwap,
    onAdd,
}) => {
    return (
        <Card
            title="Work history"
            icon={Briefcase}
            iconColorClass="text-purple-400"
        >
            <div className="flex flex-col gap-3">
                {workRoles.length === 0 ? (
                    <p className="text-sm text-white/40 italic">No roles yet. Click &quot;Add role&quot; below.</p>
                ) : (
                    workRoles.map((role, idx) => (
                        <WorkRoleCard
                            key={role.id}
                            role={role}
                            onUpdate={(patch) => onUpdate(role.id, patch)}
                            onDelete={() => onDelete(role.id)}
                            onMoveUp={() => onSwap(idx, -1)}
                            onMoveDown={() => onSwap(idx, 1)}
                            canMoveUp={idx > 0}
                            canMoveDown={idx < workRoles.length - 1}
                        />
                    ))
                )}
                <button
                    onClick={onAdd}
                    className="self-start flex items-center gap-2 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 rounded-lg text-xs font-semibold text-purple-300 transition-colors"
                >
                    <Briefcase className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add role
                </button>
            </div>
        </Card>
    );
};
