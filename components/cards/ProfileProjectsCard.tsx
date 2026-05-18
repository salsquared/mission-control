import React from "react";
import { FolderGit, Plus } from "lucide-react";
import { Card } from "../ui/Card";
import { ProjectCard } from "./ProjectCard";
import type { Bullet } from "@/lib/profile/types";
import type { ProjectWire } from "@/lib/schemas/profile";

type ProjectPatch = Partial<{
    name: string;
    description: string | null;
    repoUrl: string | null;
    liveUrl: string | null;
    githubRepo: string | null;
    portfolio: boolean;
    bullets: Bullet[];
    position: number;
}>;

interface ProfileProjectsCardProps {
    projects: ProjectWire[];
    onUpdate: (id: string, patch: ProjectPatch) => void;
    onDelete: (id: string) => void;
    onSwap: (idx: number, delta: -1 | 1) => void;
    onAdd: () => void;
}

export const ProfileProjectsCard: React.FC<ProfileProjectsCardProps> = ({
    projects,
    onUpdate,
    onDelete,
    onSwap,
    onAdd,
}) => {
    return (
        <Card
            title="Projects"
            icon={FolderGit}
            iconColorClass="text-cyan-400"
        >
            <div className="flex flex-col gap-3">
                {projects.length === 0 ? (
                    <p className="text-sm text-white/40 italic">No projects yet.</p>
                ) : (
                    projects.map((pr, idx) => (
                        <ProjectCard
                            key={pr.id}
                            project={pr}
                            onUpdate={(patch) => onUpdate(pr.id, patch)}
                            onDelete={() => onDelete(pr.id)}
                            onMoveUp={() => onSwap(idx, -1)}
                            onMoveDown={() => onSwap(idx, 1)}
                            canMoveUp={idx > 0}
                            canMoveDown={idx < projects.length - 1}
                        />
                    ))
                )}
                <button
                    onClick={onAdd}
                    className="self-start flex items-center gap-2 px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-xs font-semibold text-cyan-300 transition-colors"
                >
                    <FolderGit className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add project
                </button>
            </div>
        </Card>
    );
};
