import React from "react";
import {
    User as UserIcon,
    Briefcase,
    FolderGit,
    GraduationCap,
    Mail,
    Phone,
    MapPin,
    Plus,
    type LucideIcon,
} from "lucide-react";
import { Card } from "../ui/Card";
import { EditableField } from "../ui/EditableField";
import { WorkRoleRow } from "../ui/WorkRoleRow";
import { ProjectRow } from "../ui/ProjectRow";
import { EducationRow } from "../ui/EducationRow";
import type { Bullet } from "@/lib/profile/types";
import type { WorkRoleWire, ProjectWire, EducationWire } from "@/lib/schemas/profile";
import type { ProfileLink } from "@/lib/repositories/profile";

type HeaderPatch = {
    headline?: string | null;
    summary?: string | null;
    location?: string | null;
    email?: string | null;
    phone?: string | null;
    links?: ProfileLink[] | null;
};

type WorkRolePatch = Partial<{
    company: string;
    title: string;
    location: string | null;
    startDate: string;
    endDate: string | null;
    bullets: Bullet[];
    position: number;
}>;

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

type EducationPatch = Partial<{
    institution: string;
    degree: string | null;
    field: string | null;
    startDate: string | null;
    endDate: string | null;
    bullets: Bullet[];
    position: number;
}>;

interface ProfileIdentityCardProps {
    headline: string | null;
    summary: string | null;
    location: string | null;
    email: string | null;
    phone: string | null;
    links: ProfileLink[] | null;
    onHeaderSave: (patch: HeaderPatch) => void;

    workRoles: WorkRoleWire[];
    onWorkRoleUpdate: (id: string, patch: WorkRolePatch) => void;
    onWorkRoleDelete: (id: string) => void;
    onWorkRoleSwap: (idx: number, delta: -1 | 1) => void;
    onAddWorkRole: () => void;

    projects: ProjectWire[];
    onProjectUpdate: (id: string, patch: ProjectPatch) => void;
    onProjectDelete: (id: string) => void;
    onProjectSwap: (idx: number, delta: -1 | 1) => void;
    onAddProject: () => void;

    education: EducationWire[];
    onEducationUpdate: (id: string, patch: EducationPatch) => void;
    onEducationDelete: (id: string) => void;
    onEducationSwap: (idx: number, delta: -1 | 1) => void;
    onAddEducation: () => void;
}

const SubsectionHeader: React.FC<{ icon: LucideIcon; title: string; colorClass: string }> = ({
    icon: Icon,
    title,
    colorClass,
}) => (
    <div className={`flex items-center gap-2 ${colorClass}`}>
        <Icon className="w-4 h-4" />
        <h3 className="font-bold tracking-wider uppercase text-sm">{title}</h3>
    </div>
);

export const ProfileIdentityCard: React.FC<ProfileIdentityCardProps> = ({
    headline,
    summary,
    location,
    email,
    phone,
    onHeaderSave,
    workRoles,
    onWorkRoleUpdate,
    onWorkRoleDelete,
    onWorkRoleSwap,
    onAddWorkRole,
    projects,
    onProjectUpdate,
    onProjectDelete,
    onProjectSwap,
    onAddProject,
    education,
    onEducationUpdate,
    onEducationDelete,
    onEducationSwap,
    onAddEducation,
}) => {
    return (
        <Card>
            <div className="flex flex-col gap-8">
                {/* Personal info */}
                <section className="flex flex-col gap-3">
                    <SubsectionHeader icon={UserIcon} title="Personal info" colorClass="text-purple-400" />
                    <div>
                        <span className="text-[10px] uppercase tracking-wider text-white/30">Headline</span>
                        <EditableField
                            value={headline}
                            onSave={(v) => onHeaderSave({ headline: v })}
                            placeholder="Click to add a headline (e.g. 'Senior Engineer · Distributed Systems')"
                            readClassName="text-lg font-semibold text-white"
                        />
                    </div>
                    <div>
                        <span className="text-[10px] uppercase tracking-wider text-white/30">Summary</span>
                        <EditableField
                            value={summary}
                            onSave={(v) => onHeaderSave({ summary: v })}
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
                                onSave={(v) => onHeaderSave({ location: v })}
                                placeholder="Location"
                                readClassName="text-sm text-white/80"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Mail className="w-3.5 h-3.5 text-white/40 shrink-0" />
                            <EditableField
                                value={email}
                                onSave={(v) => onHeaderSave({ email: v })}
                                placeholder="Email"
                                type="email"
                                readClassName="text-sm text-white/80"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Phone className="w-3.5 h-3.5 text-white/40 shrink-0" />
                            <EditableField
                                value={phone}
                                onSave={(v) => onHeaderSave({ phone: v })}
                                placeholder="Phone"
                                type="tel"
                                readClassName="text-sm text-white/80"
                            />
                        </div>
                    </div>
                </section>

                {/* Work history */}
                <section className="flex flex-col gap-3">
                    <SubsectionHeader icon={Briefcase} title="Work history" colorClass="text-purple-400" />
                    {workRoles.length === 0 ? (
                        <p className="text-sm text-white/40 italic">No roles yet. Click &quot;Add role&quot; below.</p>
                    ) : (
                        workRoles.map((role, idx) => (
                            <WorkRoleRow
                                key={role.id}
                                role={role}
                                onUpdate={(patch) => onWorkRoleUpdate(role.id, patch)}
                                onDelete={() => onWorkRoleDelete(role.id)}
                                onMoveUp={() => onWorkRoleSwap(idx, -1)}
                                onMoveDown={() => onWorkRoleSwap(idx, 1)}
                                canMoveUp={idx > 0}
                                canMoveDown={idx < workRoles.length - 1}
                            />
                        ))
                    )}
                    <button
                        onClick={onAddWorkRole}
                        className="self-start flex items-center gap-2 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 rounded-lg text-xs font-semibold text-purple-300 transition-colors"
                    >
                        <Briefcase className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add role
                    </button>
                </section>

                {/* Projects */}
                <section className="flex flex-col gap-3">
                    <SubsectionHeader icon={FolderGit} title="Projects" colorClass="text-cyan-400" />
                    {projects.length === 0 ? (
                        <p className="text-sm text-white/40 italic">No projects yet.</p>
                    ) : (
                        projects.map((pr, idx) => (
                            <ProjectRow
                                key={pr.id}
                                project={pr}
                                onUpdate={(patch) => onProjectUpdate(pr.id, patch)}
                                onDelete={() => onProjectDelete(pr.id)}
                                onMoveUp={() => onProjectSwap(idx, -1)}
                                onMoveDown={() => onProjectSwap(idx, 1)}
                                canMoveUp={idx > 0}
                                canMoveDown={idx < projects.length - 1}
                            />
                        ))
                    )}
                    <button
                        onClick={onAddProject}
                        className="self-start flex items-center gap-2 px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-xs font-semibold text-cyan-300 transition-colors"
                    >
                        <FolderGit className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add project
                    </button>
                </section>

                {/* Education */}
                <section className="flex flex-col gap-3">
                    <SubsectionHeader icon={GraduationCap} title="Education" colorClass="text-emerald-400" />
                    {education.length === 0 ? (
                        <p className="text-sm text-white/40 italic">No education yet.</p>
                    ) : (
                        education.map((ed, idx) => (
                            <EducationRow
                                key={ed.id}
                                education={ed}
                                onUpdate={(patch) => onEducationUpdate(ed.id, patch)}
                                onDelete={() => onEducationDelete(ed.id)}
                                onMoveUp={() => onEducationSwap(idx, -1)}
                                onMoveDown={() => onEducationSwap(idx, 1)}
                                canMoveUp={idx > 0}
                                canMoveDown={idx < education.length - 1}
                            />
                        ))
                    )}
                    <button
                        onClick={onAddEducation}
                        className="self-start flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-semibold text-emerald-300 transition-colors"
                    >
                        <GraduationCap className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add education
                    </button>
                </section>
            </div>
        </Card>
    );
};
