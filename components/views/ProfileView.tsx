import React, { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession, signIn } from "next-auth/react";
import { Loader2, User as UserIcon, Plus, Briefcase, FolderGit, GraduationCap } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { ProfileHeaderCard } from "../cards/ProfileHeaderCard";
import { WorkRoleCard } from "../cards/WorkRoleCard";
import { ProjectCard } from "../cards/ProjectCard";
import { EducationCard } from "../cards/EducationCard";
import { useServerEvents } from "@/hooks/useServerEvents";
import { api, queryKeys } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";
import type { ProfileWire, WorkRoleWire, ProjectWire, EducationWire } from "@/lib/schemas/profile";

type WorkRolePatch = Partial<Pick<WorkRoleWire, 'company' | 'title' | 'location' | 'startDate' | 'endDate' | 'bullets' | 'position'>>;
type ProjectPatch = Partial<Pick<ProjectWire, 'name' | 'description' | 'repoUrl' | 'liveUrl' | 'bullets' | 'position'>>;
type EducationPatch = Partial<Pick<EducationWire, 'institution' | 'degree' | 'field' | 'startDate' | 'endDate' | 'bullets' | 'position'>>;

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export const ProfileView: React.FC = () => {
    const { data: session, status } = useSession();
    const queryClient = useQueryClient();

    const { data: profileData, isLoading } = useQuery({
        queryKey: queryKeys.profile,
        queryFn: () => api.profile.get(),
        enabled: Boolean(session),
    });
    const profile = profileData?.profile;

    const invalidateProfile = useCallback(
        () => queryClient.invalidateQueries({ queryKey: queryKeys.profile }),
        [queryClient]
    );
    useServerEvents('Profile', invalidateProfile);

    // Generic mutation wrapper: optimistically updates the cached profile via
    // a mutator function, then fires the API call. On failure, rolls back and
    // surfaces a toast. Keeps every card's onUpdate path one-liner-clean.
    const mutate = useCallback(
        async (
            optimistic: (current: ProfileWire) => ProfileWire,
            apiCall: () => Promise<unknown>,
            errLabel: string,
        ) => {
            const prev = queryClient.getQueryData(queryKeys.profile);
            if (profile) {
                queryClient.setQueryData(queryKeys.profile, { profile: optimistic(profile) });
            }
            try {
                await apiCall();
                invalidateProfile();
            } catch (e) {
                queryClient.setQueryData(queryKeys.profile, prev);
                toastStore.push({ message: `${errLabel}: ${errMessage(e)}`, type: 'error' });
            }
        },
        [profile, queryClient, invalidateProfile]
    );

    // ─── Profile header ────────────────────────────────────────────────────
    const handleHeaderSave = (patch: Parameters<typeof api.profile.update>[0]) =>
        mutate(
            (p) => ({ ...p, ...patch }),
            () => api.profile.update(patch),
            'Profile update failed',
        );

    // ─── Work roles ────────────────────────────────────────────────────────
    const handleWorkRoleUpdate = (id: string, patch: WorkRolePatch) =>
        mutate(
            (p) => ({ ...p, workRoles: p.workRoles.map((r) => r.id === id ? { ...r, ...patch } : r) }),
            () => api.profile.workRoles.update({ id, ...patch }),
            'Work role update failed',
        );
    const handleWorkRoleDelete = (id: string) =>
        mutate(
            (p) => ({ ...p, workRoles: p.workRoles.filter((r) => r.id !== id) }),
            () => api.profile.workRoles.delete(id),
            'Work role delete failed',
        );
    const handleAddWorkRole = async () => {
        try {
            await api.profile.workRoles.create({
                company: 'New company',
                title: 'New role',
                startDate: new Date().toISOString(),
            });
            invalidateProfile();
        } catch (e) {
            toastStore.push({ message: `Add role failed: ${errMessage(e)}`, type: 'error' });
        }
    };

    // ─── Projects ──────────────────────────────────────────────────────────
    const handleProjectUpdate = (id: string, patch: ProjectPatch) =>
        mutate(
            (p) => ({ ...p, projects: p.projects.map((pr) => pr.id === id ? { ...pr, ...patch } : pr) }),
            () => api.profile.projects.update({ id, ...patch }),
            'Project update failed',
        );
    const handleProjectDelete = (id: string) =>
        mutate(
            (p) => ({ ...p, projects: p.projects.filter((pr) => pr.id !== id) }),
            () => api.profile.projects.delete(id),
            'Project delete failed',
        );
    const handleAddProject = async () => {
        try {
            await api.profile.projects.create({ name: 'New project' });
            invalidateProfile();
        } catch (e) {
            toastStore.push({ message: `Add project failed: ${errMessage(e)}`, type: 'error' });
        }
    };

    // ─── Education ─────────────────────────────────────────────────────────
    const handleEducationUpdate = (id: string, patch: EducationPatch) =>
        mutate(
            (p) => ({ ...p, education: p.education.map((ed) => ed.id === id ? { ...ed, ...patch } : ed) }),
            () => api.profile.education.update({ id, ...patch }),
            'Education update failed',
        );
    const handleEducationDelete = (id: string) =>
        mutate(
            (p) => ({ ...p, education: p.education.filter((ed) => ed.id !== id) }),
            () => api.profile.education.delete(id),
            'Education delete failed',
        );
    const handleAddEducation = async () => {
        try {
            await api.profile.education.create({ institution: 'New institution' });
            invalidateProfile();
        } catch (e) {
            toastStore.push({ message: `Add education failed: ${errMessage(e)}`, type: 'error' });
        }
    };

    // ─── Reorder helpers (swap positions with neighbor) ────────────────────
    // Per-kind to keep the api.profile.*.update call site narrowly typed
    // (the union of the three update fns has an incompatible-parameters
    // intersection, which is why a generic dispatcher used to need `any`).
    const swapWorkRoles = (idx: number, delta: -1 | 1) => {
        if (!profile) return;
        const a = profile.workRoles[idx];
        const b = profile.workRoles[idx + delta];
        if (!a || !b) return;
        const aPos = a.position;
        const bPos = b.position;
        mutate(
            (p) => ({
                ...p,
                workRoles: p.workRoles.map((r) => {
                    if (r.id === a.id) return { ...r, position: bPos };
                    if (r.id === b.id) return { ...r, position: aPos };
                    return r;
                }).sort((x, y) => x.position - y.position),
            }),
            () => Promise.all([
                api.profile.workRoles.update({ id: a.id, position: bPos }),
                api.profile.workRoles.update({ id: b.id, position: aPos }),
            ]),
            'Reorder failed',
        );
    };

    const swapProjects = (idx: number, delta: -1 | 1) => {
        if (!profile) return;
        const a = profile.projects[idx];
        const b = profile.projects[idx + delta];
        if (!a || !b) return;
        const aPos = a.position;
        const bPos = b.position;
        mutate(
            (p) => ({
                ...p,
                projects: p.projects.map((pr) => {
                    if (pr.id === a.id) return { ...pr, position: bPos };
                    if (pr.id === b.id) return { ...pr, position: aPos };
                    return pr;
                }).sort((x, y) => x.position - y.position),
            }),
            () => Promise.all([
                api.profile.projects.update({ id: a.id, position: bPos }),
                api.profile.projects.update({ id: b.id, position: aPos }),
            ]),
            'Reorder failed',
        );
    };

    const swapEducation = (idx: number, delta: -1 | 1) => {
        if (!profile) return;
        const a = profile.education[idx];
        const b = profile.education[idx + delta];
        if (!a || !b) return;
        const aPos = a.position;
        const bPos = b.position;
        mutate(
            (p) => ({
                ...p,
                education: p.education.map((ed) => {
                    if (ed.id === a.id) return { ...ed, position: bPos };
                    if (ed.id === b.id) return { ...ed, position: aPos };
                    return ed;
                }).sort((x, y) => x.position - y.position),
            }),
            () => Promise.all([
                api.profile.education.update({ id: a.id, position: bPos }),
                api.profile.education.update({ id: b.id, position: aPos }),
            ]),
            'Reorder failed',
        );
    };

    // ─── Render gates ──────────────────────────────────────────────────────
    if (status === 'loading' && !profile) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
            </div>
        );
    }

    if (!session) {
        return (
            <Scrollbar className="w-full h-full pb-8">
                <Section title="Profile" description="Sign in to manage your resume profile">
                    <div className="mt-8 flex flex-col items-center justify-center h-80 gap-5 p-12 bg-black/20 border border-white/5 rounded-3xl max-w-xl mx-auto text-center backdrop-blur-md">
                        <div className="p-4 bg-purple-500/10 rounded-full"><UserIcon className="w-12 h-12 text-purple-400" /></div>
                        <div>
                            <h3 className="text-2xl font-bold bg-clip-text text-transparent bg-linear-to-r from-slate-100 to-slate-400">Profile</h3>
                            <p className="text-sm text-slate-400 mt-2 leading-relaxed max-w-sm mx-auto">One structured profile of your work history, projects, and education — reused everywhere.</p>
                        </div>
                        <button onClick={() => signIn('google')} className="mt-2 flex items-center gap-2 px-8 py-3 bg-purple-600 hover:bg-purple-500 active:scale-95 text-white rounded-xl transition-all font-semibold shadow-xl shadow-purple-500/20">
                            Sign in
                        </button>
                    </div>
                </Section>
            </Scrollbar>
        );
    }

    if (isLoading || !profile) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
            </div>
        );
    }

    return (
        <Scrollbar className="w-full h-full pb-8">
            <div className="flex flex-col gap-4 max-w-5xl mx-auto px-2 pt-4">
                <Section title="Identity">
                    <div className="mt-4">
                        <ProfileHeaderCard
                            headline={profile.headline}
                            summary={profile.summary}
                            location={profile.location}
                            email={profile.email}
                            phone={profile.phone}
                            links={profile.links ?? null}
                            onSave={handleHeaderSave}
                        />
                    </div>
                </Section>

                <Section title="Work History">
                    <div className="mt-4 space-y-3">
                        {profile.workRoles.length === 0 ? (
                            <p className="text-sm text-white/40 italic">No roles yet. Click &quot;Add role&quot; below.</p>
                        ) : (
                            profile.workRoles.map((role, idx) => (
                                <WorkRoleCard
                                    key={role.id}
                                    role={role}
                                    onUpdate={(patch) => handleWorkRoleUpdate(role.id, patch)}
                                    onDelete={() => handleWorkRoleDelete(role.id)}
                                    onMoveUp={() => swapWorkRoles(idx, -1)}
                                    onMoveDown={() => swapWorkRoles(idx, 1)}
                                    canMoveUp={idx > 0}
                                    canMoveDown={idx < profile.workRoles.length - 1}
                                />
                            ))
                        )}
                        <button onClick={handleAddWorkRole} className="self-start flex items-center gap-2 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 rounded-lg text-xs font-semibold text-purple-300 transition-colors">
                            <Briefcase className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add role
                        </button>
                    </div>
                </Section>

                <Section title="Projects">
                    <div className="mt-4 space-y-3">
                        {profile.projects.length === 0 ? (
                            <p className="text-sm text-white/40 italic">No projects yet.</p>
                        ) : (
                            profile.projects.map((pr, idx) => (
                                <ProjectCard
                                    key={pr.id}
                                    project={pr}
                                    onUpdate={(patch) => handleProjectUpdate(pr.id, patch)}
                                    onDelete={() => handleProjectDelete(pr.id)}
                                    onMoveUp={() => swapProjects(idx, -1)}
                                    onMoveDown={() => swapProjects(idx, 1)}
                                    canMoveUp={idx > 0}
                                    canMoveDown={idx < profile.projects.length - 1}
                                />
                            ))
                        )}
                        <button onClick={handleAddProject} className="self-start flex items-center gap-2 px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-xs font-semibold text-cyan-300 transition-colors">
                            <FolderGit className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add project
                        </button>
                    </div>
                </Section>

                <Section title="Education">
                    <div className="mt-4 space-y-3">
                        {profile.education.length === 0 ? (
                            <p className="text-sm text-white/40 italic">No education yet.</p>
                        ) : (
                            profile.education.map((ed, idx) => (
                                <EducationCard
                                    key={ed.id}
                                    education={ed}
                                    onUpdate={(patch) => handleEducationUpdate(ed.id, patch)}
                                    onDelete={() => handleEducationDelete(ed.id)}
                                    onMoveUp={() => swapEducation(idx, -1)}
                                    onMoveDown={() => swapEducation(idx, 1)}
                                    canMoveUp={idx > 0}
                                    canMoveDown={idx < profile.education.length - 1}
                                />
                            ))
                        )}
                        <button onClick={handleAddEducation} className="self-start flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-semibold text-emerald-300 transition-colors">
                            <GraduationCap className="w-3.5 h-3.5" /> <Plus className="w-3.5 h-3.5" /> Add education
                        </button>
                    </div>
                </Section>
            </div>
        </Scrollbar>
    );
};
