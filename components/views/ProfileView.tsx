import React, { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { signIn } from "next-auth/react";
import { useAccount } from "@/hooks/useAccount";
import { Loader2, Mail } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { CardGrid, type CardItem } from "../grids/CardGrid";
import { PersonalInfoCard } from "../cards/profile/PersonalInfoCard";
import { WorkHistoryCard } from "../cards/profile/WorkHistoryCard";
import { ProjectsCard } from "../cards/profile/ProjectsCard";
import { EducationCard } from "../cards/profile/EducationCard";
import { GenerateResumeCard } from "../cards/profile/GenerateResumeCard";
import { CanonsCard } from "../cards/profile/CanonsCard";
import { ImportResumesCard } from "../cards/profile/ImportResumesCard";
import { GeneratedResumesCard } from "../cards/profile/GeneratedResumesCard";
import { SnapshotsCard } from "../cards/profile/SnapshotsCard";
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
    // Edge-trusted: a verified viewer is always present once past Cloudflare
    // Access, so there's no "signed out" wall. `googleConnected` drives only a
    // NON-blocking reconnect banner (token missing / scopes stale).
    const { user, role, googleConnected, isLoading: accountLoading } = useAccount();

    // The reconnect banner is OWNER-ONLY (docs/multi-user-crew.html P3.5,
    // decided in OQ6a: crew never connect Google in v1).
    //
    // The condition is `role === 'owner'`, NOT `googleConnected`. Crew have no
    // `Account` row, so `googleConnected` is permanently false for them and is
    // indistinguishable from the owner's "not connected yet" — keyed on it, the
    // banner renders for crew forever, and it does worse than look broken: it
    // invites them into a Gmail/Calendar scope grant that is an explicit v1
    // non-goal (and one `ALLOWED_SIGNIN_EMAILS` would reject anyway, so the
    // invitation cannot even be accepted).
    //
    // `=== 'owner'` rather than `!== 'crew'` so the unknown-role window (`role`
    // is `undefined` until /api/account resolves) behaves like crew. The owner
    // sees no flash: the spinner below covers the first resolve.
    const isOwner = role === 'owner';
    const queryClient = useQueryClient();

    const { data: profileData, isLoading } = useQuery({
        queryKey: queryKeys.profile,
        queryFn: () => api.profile.get(),
        enabled: Boolean(user),
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
    // No sign-in wall: a verified viewer is always present past the edge. A
    // spinner covers the first viewer/profile resolve — which is also what keeps
    // the owner-only connect banner (below) from flashing in a beat late. The
    // banner is the only Google-related surface here, and it never blocks the
    // view.
    if (accountLoading || isLoading || !profile) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
            </div>
        );
    }

    const resumeCards: CardItem[] = [
        { id: "generate-resume", colSpan: 1, hFit: true, content: <GenerateResumeCard /> },
        { id: "generated-resumes", colSpan: 1, hFit: true, content: <GeneratedResumesCard /> },
        { id: "import-resumes", colSpan: 2, hFit: true, content: <ImportResumesCard /> },
        { id: "canons", colSpan: 2, hFit: true, content: <CanonsCard /> },
    ];

    const historyCards: CardItem[] = [
        { id: "profile-snapshots", colSpan: 1, hFit: true, content: <SnapshotsCard /> },
    ];

    // M-followup (post-split) — the monolithic ProfileIdentityCard split into
    // four focused cards. Each is full-width (colSpan=3) so the per-card
    // chrome from CardGrid doesn't collapse two side-by-side; ProfileView
    // grew its CardGrid items inline rather than thread props through one
    // big card.
    const identityCards: CardItem[] = [
        {
            id: "personal-info",
            colSpan: 3,
            hFit: true,
            content: (
                <PersonalInfoCard
                    headline={profile.headline}
                    tagline={profile.tagline ?? null}
                    location={profile.location}
                    email={profile.email}
                    phone={profile.phone}
                    skills={profile.skills ?? null}
                    hobbies={profile.hobbies ?? null}
                    languages={profile.languages ?? null}
                    onSave={handleHeaderSave}
                />
            ),
        },
        {
            id: "work-history",
            colSpan: 3,
            hFit: true,
            content: (
                <WorkHistoryCard
                    workRoles={profile.workRoles}
                    onUpdate={handleWorkRoleUpdate}
                    onDelete={handleWorkRoleDelete}
                    onSwap={swapWorkRoles}
                    onAdd={handleAddWorkRole}
                />
            ),
        },
        {
            id: "projects",
            colSpan: 3,
            hFit: true,
            content: (
                <ProjectsCard
                    projects={profile.projects}
                    onUpdate={handleProjectUpdate}
                    onDelete={handleProjectDelete}
                    onSwap={swapProjects}
                    onAdd={handleAddProject}
                />
            ),
        },
        {
            id: "education",
            colSpan: 3,
            hFit: true,
            content: (
                <EducationCard
                    education={profile.education}
                    onUpdate={handleEducationUpdate}
                    onDelete={handleEducationDelete}
                    onSwap={swapEducation}
                    onAdd={handleAddEducation}
                />
            ),
        },
    ];

    return (
        <Scrollbar className="w-full h-full pb-8">
            {isOwner && !googleConnected && (
                <div className="mt-4 flex flex-col sm:flex-row items-start sm:items-center gap-4 p-4 bg-purple-500/10 border border-purple-500/20 rounded-2xl">
                    <div className="p-2 bg-purple-500/10 rounded-xl shrink-0">
                        <Mail className="w-6 h-6 text-purple-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-slate-200">Connect Gmail / Calendar</h3>
                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">Google isn't connected (or the access token needs refreshing). Reconnect to enable inbox scanning and calendar sync — your profile works either way.</p>
                    </div>
                    <button
                        onClick={() => signIn('google')}
                        className="shrink-0 flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 active:scale-95 text-white rounded-xl transition-all text-sm font-semibold"
                    >
                        Connect
                    </button>
                </div>
            )}

            <Section title="Resume">
                <div className="mt-4">
                    <CardGrid items={resumeCards} columns={2} />
                </div>
            </Section>

            <Section title="Identity" description="The building blocks the resume generator pulls from. Hover a bullet to lock 🔒 (always include) or exclude 🚫 (never include). Tags help the generator match the right bullets to a posting.">
                <div className="mt-4">
                    <CardGrid items={identityCards} />
                </div>
            </Section>

            <Section title="History" description="Versioned snapshots of your profile — capture one before a big edit so you can always look back at how the resume material was worded.">
                <div className="mt-4">
                    <CardGrid items={historyCards} columns={2} />
                </div>
            </Section>
        </Scrollbar>
    );
};
