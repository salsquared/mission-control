"use client";
import React from "react";
import { GraduationCap, Plus } from "lucide-react";
import { Card } from "../../ui/Card";
import { EducationRow } from "../../ui/EducationRow";
import type { Bullet } from "@/lib/profile/types";
import type { EducationWire } from "@/lib/schemas/profile";

export type EducationPatch = Partial<{
    institution: string;
    degree: string | null;
    field: string | null;
    startDate: string | null;
    endDate: string | null;
    bullets: Bullet[];
    scratchpad: string | null;
    position: number;
}>;

interface EducationCardProps {
    education: EducationWire[];
    onUpdate: (id: string, patch: EducationPatch) => void;
    onDelete: (id: string) => void;
    onSwap: (idx: number, delta: -1 | 1) => void;
    onAdd: () => void;
}

export const EducationCard: React.FC<EducationCardProps> = ({
    education,
    onUpdate,
    onDelete,
    onSwap,
    onAdd,
}) => {
    return (
        <Card
            title="Education"
            icon={GraduationCap}
            iconColorClass="text-emerald-300"
        >
            <div className="flex flex-col gap-3">
                {education.length === 0 ? (
                    <p className="text-sm text-white/40 italic">No education yet.</p>
                ) : (
                    education.map((ed, idx) => (
                        <EducationRow
                            key={ed.id}
                            education={ed}
                            onUpdate={(patch) => onUpdate(ed.id, patch)}
                            onDelete={() => onDelete(ed.id)}
                            onMoveUp={() => onSwap(idx, -1)}
                            onMoveDown={() => onSwap(idx, 1)}
                            canMoveUp={idx > 0}
                            canMoveDown={idx < education.length - 1}
                        />
                    ))
                )}
                <button
                    onClick={onAdd}
                    className="self-start flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-semibold text-emerald-300 transition-colors"
                >
                    <GraduationCap className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add education
                </button>
            </div>
        </Card>
    );
};
