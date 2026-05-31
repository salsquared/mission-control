import { z } from 'zod';
import { toastStore } from './toast-store';
import {
    TasksListResponseSchema,
    TaskMutationResponseSchema,
    TaskCreateResponseSchema,
    TaskDeleteResponseSchema,
    TaskPatchSchema,
    TaskPostSchema,
} from './schemas/tasks';
import {
    GoalsListResponseSchema,
    GoalMutationResponseSchema,
    GoalDeleteResponseSchema,
    GoalPostSchema,
    GoalPatchSchema,
} from './schemas/goals';
import {
    ApplicationsListResponseSchema,
    ApplicationMutationResponseSchema,
    ApplicationDeleteResponseSchema,
    ApplicationPostSchema,
    ApplicationPatchSchema,
    BackfillRequestSchema,
    BackfillResponseSchema,
    ApplicationBulkTrackSchema,
    ApplicationBulkTrackResponseSchema,
    ApplicationBulkTrackConflictSchema,
} from './schemas/applications';
import {
    SettingsGetResponseSchema,
    SettingsPostResponseSchema,
    SettingsPostConflictSchema,
    SettingsPostSchema,
} from './schemas/settings';
import { SystemTelemetryResponseSchema, FetcherHealthResponseSchema } from './schemas/system';
import {
    CacheInvalidatePostSchema,
    CacheInvalidateResponseSchema,
} from './schemas/cache';
import {
    SavedPapersListResponseSchema,
    SavedPaperMutationResponseSchema,
    SavedPaperDeleteResponseSchema,
    SavedPaperPostSchema,
} from './schemas/saved-papers';
import {
    CalendarEventListResponseSchema,
    CalendarEventMutationResponseSchema,
    CalendarEventDeleteResponseSchema,
    CalendarEventPostSchema,
} from './schemas/calendar';
import {
    ApplicationEventsListResponseSchema,
    ApplicationEventMutationResponseSchema,
    ApplicationEventDeleteResponseSchema,
    ApplicationEventSyncResponseSchema,
    ApplicationEventPostSchema,
    ApplicationEventPatchSchema,
    GcalCandidatesResponseSchema,
    ApplicationEventAdoptPostSchema,
} from './schemas/applicationEvents';
import {
    ContactPostSchema,
    ContactPatchSchema,
    ContactsListResponseSchema,
    ContactMutationResponseSchema,
    ContactDeleteResponseSchema,
} from './schemas/contacts';
import {
    ProfileGetResponseSchema,
    ProfilePatchSchema,
    WorkRoleMutationResponseSchema,
    WorkRolePostSchema,
    WorkRolePatchSchema,
    ProjectMutationResponseSchema,
    ProjectPostSchema,
    ProjectPatchSchema,
    EducationMutationResponseSchema,
    EducationPostSchema,
    EducationPatchSchema,
    ProfileDeleteResponseSchema,
    ProfileSnapshotPostSchema,
    ProfileSnapshotsListResponseSchema,
    ProfileSnapshotMutationResponseSchema,
    ProfileSnapshotGetResponseSchema,
    BulletAssistResponseSchema,
} from './schemas/profile';
import {
    WatchlistPostSchema,
    WatchlistPatchSchema,
    WatchlistsListResponseSchema,
    WatchlistMutationResponseSchema,
    WatchlistRunResponseSchema,
    JobPostingPatchSchema,
    PostingsListResponseSchema,
    PostingMutationResponseSchema,
} from './schemas/watchlists';
import {
    NotificationPatchSchema,
    NotificationsListResponseSchema,
    NotificationPatchResponseSchema,
} from './schemas/notifications';

// ─── Internals ─────────────────────────────────────────────────────────────

async function jsonFetch<T extends z.ZodTypeAny>(
    url: string,
    schema: T,
    init?: RequestInit
): Promise<z.infer<T>> {
    const res = await fetch(url, init);

    if (res.headers.get('X-Cache') === 'STALE-FALLBACK') {
        const route = new URL(url, 'http://localhost').pathname;
        toastStore.push({ message: `Stale data: ${route}`, type: 'warning' });
    }

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Fetch failed');
    }

    const data = await res.json();

    // Dev-only contract check. Mismatches log loudly but don't throw — drift
    // surfaces in the in-app log viewer without breaking the UI.
    if (process.env.NODE_ENV !== 'production') {
        const parsed = schema.safeParse(data);
        if (!parsed.success) {
            console.warn(`[api-client] Response shape mismatch for ${url}:`, parsed.error.issues);
        }
    }

    return data as z.infer<T>;
}

function jsonBody(method: string, body: unknown): RequestInit {
    return {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}

// Filter shape shared by the postings query-key factory and the `list()`
// caller — same fields, so React Query's key changes whenever a server-side
// filter param changes and the cache properly partitions per filter set.
export interface PostingsListFilter {
    status?: string;
    watchlistId?: string;
    limit?: number;
    employmentType?: readonly string[];
    includeUnspecified?: boolean;
    companies?: readonly string[];
    excludeCompanies?: readonly string[];
    remoteOnly?: boolean;
    locations?: readonly string[];
    /** MB Phase 4: "career" | "side". Omitted = all tracks. */
    track?: string;
}

// ─── Query keys (TanStack tuples) ──────────────────────────────────────────
// Keep these stable — useServerEvents callbacks invalidate by these keys.
export const queryKeys = {
    tasks: ['tasks'] as const,
    goals: ['goals'] as const,
    applications: ['applications'] as const,
    settings: ['settings'] as const,
    system: ['system'] as const,
    fetcherHealth: ['fetcher-health'] as const,
    calendarEvents: ['calendar-events'] as const,
    applicationEvents: (filter?: { applicationId?: string | null; upcoming?: boolean; kinds?: readonly string[] }) =>
        ['application-events', filter ?? {}] as const,
    savedPapers: (filter?: { topic?: string | null; status?: string | null }) =>
        ['saved-papers', filter ?? {}] as const,
    profile: ['profile'] as const,
    profileSnapshots: ['profile-snapshots'] as const,
    profileSnapshot: (id: string) => ['profile-snapshot', id] as const,
    contacts: (applicationId: string) => ['contacts', applicationId] as const,
    watchlists: ['watchlists'] as const,
    postings: (filter?: PostingsListFilter) =>
        ['postings', filter ?? {}] as const,
    posting: (id: string) => ['posting', id] as const,
    notifications: (filter?: { unread?: boolean }) =>
        ['notifications', filter ?? {}] as const,
    resumes: (filter?: { applicationId?: string }) =>
        ['resumes', filter ?? {}] as const,
    resume: (id: string) => ['resume', id] as const,
    // M8.4.4 — separate from `applications` so listing all apps doesn't
    // invalidate the picker, and vice-versa.
    pipelinePicker: ['applications', 'pipeline-picker'] as const,
    blacklist: ['blacklist'] as const,
    // Canons — keep stable; CanonsCard invalidates by this key on SSE + mutation.
    canons: (filter?: { track?: string }) =>
        ['canons', filter ?? {}] as const,
    // Per-canon retained resume versions — drives the version-history dropdown
    // on each canon row. Invalidated alongside `canons` after a regenerate.
    canonVersions: (canonId: string) => ['canon-versions', canonId] as const,
};

// ─── Canon wire shape ──────────────────────────────────────────────────────
// Mirrors the CanonWire the /api/canons routes return (canonical-resumes
// feature). Kept local to the client (not lib/schemas) since the canon CRUD
// surface is owned by the backend worker; this is the response contract the
// CanonsCard reads.
export const CanonWireSchema = z.object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    slug: z.string(),
    track: z.enum(['career', 'side']),
    description: z.string().nullable(),
    keywords: z.string(),
    onePage: z.boolean(),
    currentResumeId: z.string().nullable(),
    resumeStale: z.boolean(),
    resumeEntityIds: z.array(z.string()),
    versionCount: z.number(),
    active: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type CanonWire = z.infer<typeof CanonWireSchema>;

const CanonsListResponseSchema = z.object({ canons: z.array(CanonWireSchema) });
const CanonMutationResponseSchema = z.object({ canon: CanonWireSchema });
const CanonDeleteResponseSchema = z.object({ ok: z.literal(true) });

// ─── API surface ───────────────────────────────────────────────────────────

export const api = {
    tasks: {
        list: () => jsonFetch('/api/tasks', TasksListResponseSchema),
        update: (input: z.infer<typeof TaskPatchSchema>) =>
            jsonFetch('/api/tasks', TaskMutationResponseSchema, jsonBody('PATCH', input)),
        create: (input: z.infer<typeof TaskPostSchema>) =>
            jsonFetch('/api/tasks', TaskCreateResponseSchema, jsonBody('POST', input)),
        delete: (id: string) =>
            jsonFetch('/api/tasks', TaskDeleteResponseSchema, jsonBody('DELETE', { id })),
    },

    goals: {
        list: () => jsonFetch('/api/goals', GoalsListResponseSchema),
        create: (input: z.infer<typeof GoalPostSchema>) =>
            jsonFetch('/api/goals', GoalMutationResponseSchema, jsonBody('POST', input)),
        update: (input: z.infer<typeof GoalPatchSchema>) =>
            jsonFetch('/api/goals', GoalMutationResponseSchema, jsonBody('PATCH', input)),
        delete: (id: string) =>
            jsonFetch('/api/goals', GoalDeleteResponseSchema, jsonBody('DELETE', { id })),
    },

    applications: {
        list: (filter?: { track?: string }) => {
            const qs = filter?.track ? `?track=${encodeURIComponent(filter.track)}` : '';
            return jsonFetch(`/api/applications${qs}`, ApplicationsListResponseSchema);
        },
        // M8.4.4 — denormalized projection for the Pipeline tab on
        // GenerateResumeCard. Already filters to INTERESTED + posting.sourceUrl
        // server-side (Decision 6.4); client just renders.
        pipelinePicker: () =>
            jsonFetch(
                '/api/applications/pipeline-picker',
                z.object({
                    items: z.array(z.object({
                        id: z.string(),
                        company: z.string(),
                        role: z.string().nullable(),
                        postingUrl: z.string(),
                        postingTitle: z.string(),
                        track: z.string(),
                    })),
                }),
            ),
        create: (input: z.infer<typeof ApplicationPostSchema>) =>
            jsonFetch('/api/applications', ApplicationMutationResponseSchema, jsonBody('POST', input)),
        update: (input: z.infer<typeof ApplicationPatchSchema>) =>
            jsonFetch('/api/applications', ApplicationMutationResponseSchema, jsonBody('PATCH', input)),
        delete: (id: string) =>
            jsonFetch(
                `/api/applications?id=${encodeURIComponent(id)}`,
                ApplicationDeleteResponseSchema,
                { method: 'DELETE' }
            ),
        backfill: (input?: z.infer<typeof BackfillRequestSchema>) =>
            jsonFetch(
                '/api/applications/backfill',
                BackfillResponseSchema,
                jsonBody('POST', input ?? {})
            ),
        // Story S13.8 — bulk move applications between tracks. Returns a
        // discriminated union so the caller can branch on the
        // same-employer-conflicts case (HTTP 409).
        bulkTrack: async (
            input: z.infer<typeof ApplicationBulkTrackSchema>,
        ): Promise<
            | { ok: true; updated: number; ids: string[] }
            | { ok: false; conflicts: z.infer<typeof ApplicationBulkTrackConflictSchema>['conflicts'] }
        > => {
            const res = await fetch('/api/applications/bulk-track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            if (res.status === 409) {
                const body = ApplicationBulkTrackConflictSchema.parse(await res.json());
                return { ok: false, conflicts: body.conflicts };
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: res.statusText }));
                throw new Error(err.error || 'Bulk move failed');
            }
            const body = ApplicationBulkTrackResponseSchema.parse(await res.json());
            return { ok: true, updated: body.updated, ids: body.ids };
        },
        events: {
            list: (filter?: { applicationId?: string; upcoming?: boolean; kinds?: readonly string[] }) => {
                const params = new URLSearchParams();
                if (filter?.applicationId) params.set('applicationId', filter.applicationId);
                if (filter?.upcoming) params.set('upcoming', 'true');
                if (filter?.kinds && filter.kinds.length > 0) params.set('kinds', filter.kinds.join(','));
                const qs = params.toString();
                return jsonFetch(
                    `/api/applications/events${qs ? '?' + qs : ''}`,
                    ApplicationEventsListResponseSchema
                );
            },
            create: (input: z.infer<typeof ApplicationEventPostSchema>) =>
                jsonFetch('/api/applications/events', ApplicationEventMutationResponseSchema, jsonBody('POST', input)),
            update: (input: z.infer<typeof ApplicationEventPatchSchema>) =>
                jsonFetch('/api/applications/events', ApplicationEventMutationResponseSchema, jsonBody('PATCH', input)),
            delete: (id: string) =>
                jsonFetch(
                    `/api/applications/events?id=${encodeURIComponent(id)}`,
                    ApplicationEventDeleteResponseSchema,
                    { method: 'DELETE' }
                ),
            sync: () =>
                jsonFetch(
                    '/api/applications/events/sync',
                    ApplicationEventSyncResponseSchema,
                    jsonBody('POST', {})
                ),
            gcalCandidates: (horizonDays?: number) => {
                const qs = horizonDays ? `?horizonDays=${horizonDays}` : '';
                return jsonFetch(`/api/applications/events/gcal-candidates${qs}`, GcalCandidatesResponseSchema);
            },
            adopt: (input: z.infer<typeof ApplicationEventAdoptPostSchema>) =>
                jsonFetch('/api/applications/events/adopt', ApplicationEventMutationResponseSchema, jsonBody('POST', input)),
        },
        contacts: {
            list: (applicationId: string) =>
                jsonFetch(
                    `/api/applications/contacts?applicationId=${encodeURIComponent(applicationId)}`,
                    ContactsListResponseSchema,
                ),
            create: (input: z.infer<typeof ContactPostSchema>) =>
                jsonFetch('/api/applications/contacts', ContactMutationResponseSchema, jsonBody('POST', input)),
            update: (input: z.infer<typeof ContactPatchSchema>) =>
                jsonFetch('/api/applications/contacts', ContactMutationResponseSchema, jsonBody('PATCH', input)),
            delete: (id: string) =>
                jsonFetch(
                    `/api/applications/contacts?id=${encodeURIComponent(id)}`,
                    ContactDeleteResponseSchema,
                    { method: 'DELETE' },
                ),
        },
    },

    settings: {
        get: () => jsonFetch('/api/settings', SettingsGetResponseSchema),
        // Optimistic-concurrency update. Caller passes the version it last saw;
        // server bumps it on success, returns 409 + currentVersion on mismatch.
        // Returns a discriminated union so the caller can branch on conflict.
        update: async (
            input: z.infer<typeof SettingsPostSchema>,
            expectedVersion: number
        ): Promise<
            | { ok: true; version: number }
            | { ok: false; currentVersion: number }
        > => {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'If-Match': String(expectedVersion),
                },
                body: JSON.stringify(input),
            });
            if (res.status === 409) {
                const body = SettingsPostConflictSchema.parse(await res.json());
                return { ok: false, currentVersion: body.currentVersion };
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: res.statusText }));
                throw new Error(err.error || 'Settings update failed');
            }
            const body = SettingsPostResponseSchema.parse(await res.json());
            return { ok: true, version: body.version };
        },
    },

    system: {
        get: () => jsonFetch('/api/system', SystemTelemetryResponseSchema),
        invalidateCache: (input: z.infer<typeof CacheInvalidatePostSchema>) =>
            jsonFetch('/api/system/cache/invalidate', CacheInvalidateResponseSchema, jsonBody('POST', input)),
        fetcherHealth: () => jsonFetch('/api/system/fetcher-health', FetcherHealthResponseSchema),
    },

    calendarEvents: {
        list: () => jsonFetch('/api/calendar/event', CalendarEventListResponseSchema),
        upsert: (input: z.infer<typeof CalendarEventPostSchema>) =>
            jsonFetch('/api/calendar/event', CalendarEventMutationResponseSchema, jsonBody('POST', input)),
        delete: (eventId: string) =>
            jsonFetch(
                `/api/calendar/event?eventId=${encodeURIComponent(eventId)}`,
                CalendarEventDeleteResponseSchema,
                { method: 'DELETE' }
            ),
    },

    profile: {
        get: () => jsonFetch('/api/profile', ProfileGetResponseSchema),
        update: (input: z.infer<typeof ProfilePatchSchema>) =>
            jsonFetch('/api/profile', ProfileGetResponseSchema, jsonBody('PATCH', input)),
        workRoles: {
            create: (input: z.infer<typeof WorkRolePostSchema>) =>
                jsonFetch('/api/profile/work-roles', WorkRoleMutationResponseSchema, jsonBody('POST', input)),
            update: (input: z.infer<typeof WorkRolePatchSchema>) =>
                jsonFetch('/api/profile/work-roles', WorkRoleMutationResponseSchema, jsonBody('PATCH', input)),
            delete: (id: string) =>
                jsonFetch(
                    `/api/profile/work-roles?id=${encodeURIComponent(id)}`,
                    ProfileDeleteResponseSchema,
                    { method: 'DELETE' }
                ),
        },
        projects: {
            create: (input: z.infer<typeof ProjectPostSchema>) =>
                jsonFetch('/api/profile/projects', ProjectMutationResponseSchema, jsonBody('POST', input)),
            update: (input: z.infer<typeof ProjectPatchSchema>) =>
                jsonFetch('/api/profile/projects', ProjectMutationResponseSchema, jsonBody('PATCH', input)),
            delete: (id: string) =>
                jsonFetch(
                    `/api/profile/projects?id=${encodeURIComponent(id)}`,
                    ProfileDeleteResponseSchema,
                    { method: 'DELETE' }
                ),
        },
        education: {
            create: (input: z.infer<typeof EducationPostSchema>) =>
                jsonFetch('/api/profile/education', EducationMutationResponseSchema, jsonBody('POST', input)),
            update: (input: z.infer<typeof EducationPatchSchema>) =>
                jsonFetch('/api/profile/education', EducationMutationResponseSchema, jsonBody('PATCH', input)),
            delete: (id: string) =>
                jsonFetch(
                    `/api/profile/education?id=${encodeURIComponent(id)}`,
                    ProfileDeleteResponseSchema,
                    { method: 'DELETE' }
                ),
        },
        snapshots: {
            list: () =>
                jsonFetch('/api/profile/snapshots', ProfileSnapshotsListResponseSchema),
            get: (id: string) =>
                jsonFetch(
                    `/api/profile/snapshots/${encodeURIComponent(id)}`,
                    ProfileSnapshotGetResponseSchema,
                ),
            create: (input: z.infer<typeof ProfileSnapshotPostSchema>) =>
                jsonFetch(
                    '/api/profile/snapshots',
                    ProfileSnapshotMutationResponseSchema,
                    jsonBody('POST', input),
                ),
            delete: (id: string) =>
                jsonFetch(
                    `/api/profile/snapshots/${encodeURIComponent(id)}`,
                    ProfileDeleteResponseSchema,
                    { method: 'DELETE' },
                ),
        },
        // M7.6.7 — LLM bullet assist (S7.7 fill empty entries + S7.8 rewrite).
        // Both methods are transient: the response is a draft / proposal the
        // UI surfaces for Accept / Discard. Persistence on Accept goes through
        // the existing entry PATCH on /api/profile/{work-roles|projects|education}
        // with the updated bullets array.
        bullets: {
            assistFill: (parentKind: 'work-role' | 'project' | 'education', parentId: string) =>
                jsonFetch(
                    '/api/profile/bullets/assist',
                    BulletAssistResponseSchema,
                    jsonBody('POST', { mode: 'fill', parentKind, parentId }),
                ),
            assistRewrite: (
                parentKind: 'work-role' | 'project' | 'education',
                parentId: string,
                bulletId: string,
            ) =>
                jsonFetch(
                    '/api/profile/bullets/assist',
                    BulletAssistResponseSchema,
                    jsonBody('POST', { mode: 'rewrite', parentKind, parentId, bulletId }),
                ),
            // M7.7.5 — per-bullet AI tag generator (story S7.10 + S7.11). Server
            // 400s with `tag-limit-reached` when bullet already has >= 7 tags;
            // jsonFetch surfaces non-2xx as an Error whose message includes the
            // error code, so the caller can switch on it for the cap-hint UX.
            assistTags: (
                parentKind: 'work-role' | 'project' | 'education',
                parentId: string,
                bulletId: string,
            ) =>
                jsonFetch(
                    '/api/profile/bullets/assist',
                    BulletAssistResponseSchema,
                    jsonBody('POST', { mode: 'tags', parentKind, parentId, bulletId }),
                ),
        },
        // M7.9.5 — Tagline AI-draft (story S7.14). Returns a proposal +
        // dispatched mode ('draft' on empty current, 'enhance' otherwise).
        // UI surfaces in a diff panel; Accept persists via the existing
        // /api/profile PATCH with `{ tagline: '...' }`.
        tagline: {
            draft: () =>
                jsonFetch(
                    '/api/profile/tagline/draft',
                    z.object({
                        tagline: z.string(),
                        mode: z.enum(['draft', 'enhance']),
                    }),
                    jsonBody('POST', {}),
                ),
        },
    },

    savedPapers: {
        list: (filter?: { topic?: string | null; status?: string | null }) => {
            const params = new URLSearchParams();
            if (filter?.topic) params.set('topic', filter.topic);
            if (filter?.status) params.set('status', filter.status);
            const qs = params.toString();
            return jsonFetch(`/api/research/saved${qs ? '?' + qs : ''}`, SavedPapersListResponseSchema);
        },
        upsert: (input: z.infer<typeof SavedPaperPostSchema>) =>
            jsonFetch('/api/research/saved', SavedPaperMutationResponseSchema, jsonBody('POST', input)),
        delete: (paperId: string) =>
            jsonFetch(
                `/api/research/saved?paperId=${encodeURIComponent(paperId)}`,
                SavedPaperDeleteResponseSchema,
                { method: 'DELETE' }
            ),
    },

    watchlists: {
        list: (filter?: { track?: string }) => {
            const qs = filter?.track ? `?track=${encodeURIComponent(filter.track)}` : '';
            return jsonFetch(`/api/watchlists${qs}`, WatchlistsListResponseSchema);
        },
        create: (input: z.input<typeof WatchlistPostSchema>) =>
            jsonFetch('/api/watchlists', WatchlistMutationResponseSchema, jsonBody('POST', input)),
        update: (id: string, input: z.infer<typeof WatchlistPatchSchema>) =>
            jsonFetch(`/api/watchlists/${encodeURIComponent(id)}`, WatchlistMutationResponseSchema, jsonBody('PATCH', input)),
        delete: (id: string) =>
            jsonFetch(`/api/watchlists/${encodeURIComponent(id)}`,
                z.object({ success: z.literal(true), id: z.string() }),
                { method: 'DELETE' }),
        run: (id: string) =>
            jsonFetch(`/api/watchlists/${encodeURIComponent(id)}/run`, WatchlistRunResponseSchema, { method: 'POST' }),
    },

    postings: {
        list: (filter?: PostingsListFilter) => {
            const params = new URLSearchParams();
            if (filter?.status) params.set('status', filter.status);
            if (filter?.watchlistId) params.set('watchlistId', filter.watchlistId);
            if (filter?.limit) params.set('limit', String(filter.limit));
            if (filter?.employmentType && filter.employmentType.length > 0) {
                params.set('employmentType', filter.employmentType.join(','));
            }
            if (filter?.includeUnspecified) params.set('includeUnspecified', 'true');
            if (filter?.companies && filter.companies.length > 0) {
                params.set('companies', filter.companies.join(','));
            }
            if (filter?.excludeCompanies && filter.excludeCompanies.length > 0) {
                params.set('excludeCompanies', filter.excludeCompanies.join(','));
            }
            if (filter?.remoteOnly) params.set('remoteOnly', 'true');
            if (filter?.locations && filter.locations.length > 0) {
                // CSV is safe here: the chip input commits on comma, so no
                // chip can ever contain one. SQLite LIKE %x% is case-
                // insensitive for ASCII, so we don't need lowercasing.
                params.set('locations', filter.locations.join(','));
            }
            if (filter?.track) params.set('track', filter.track);
            const qs = params.toString();
            return jsonFetch(`/api/postings${qs ? '?' + qs : ''}`, PostingsListResponseSchema);
        },
        get: (id: string) =>
            jsonFetch(`/api/postings/${encodeURIComponent(id)}`, PostingMutationResponseSchema),
        update: (id: string, input: z.infer<typeof JobPostingPatchSchema>) =>
            jsonFetch(`/api/postings/${encodeURIComponent(id)}`, PostingMutationResponseSchema, jsonBody('PATCH', input)),
        trackAsApplication: (id: string) =>
            jsonFetch(
                `/api/postings/${encodeURIComponent(id)}/track-as-application`,
                z.object({
                    application: z.object({ id: z.string(), status: z.string(), company: z.string(), role: z.string().nullable() }).passthrough(),
                    posting: z.object({ id: z.string(), status: z.string() }),
                    created: z.boolean(),
                    merged: z.boolean().optional(),
                }),
                { method: 'POST' },
            ),
    },

    notifications: {
        list: (filter?: { unread?: boolean; limit?: number }) => {
            const params = new URLSearchParams();
            if (filter?.unread) params.set('unread', 'true');
            if (filter?.limit) params.set('limit', String(filter.limit));
            const qs = params.toString();
            return jsonFetch(`/api/notifications${qs ? '?' + qs : ''}`, NotificationsListResponseSchema);
        },
        update: (input: z.infer<typeof NotificationPatchSchema>) =>
            jsonFetch('/api/notifications', NotificationPatchResponseSchema, jsonBody('PATCH', input)),
    },

    resumes: {
        // Lightweight list (no selections / no snapshot). Pass `canonId` to get
        // that canon's canonical VERSIONS (newest version first) — the version
        // dropdown on CanonsCard relies on the `canonVersion` / `isCanonical`
        // fields the server adds in that mode (optional/nullable here since the
        // general list omits them).
        list: (filter?: { applicationId?: string; canonId?: string; limit?: number }) => {
            const params = new URLSearchParams();
            if (filter?.applicationId) params.set('applicationId', filter.applicationId);
            if (filter?.canonId) params.set('canonId', filter.canonId);
            if (filter?.limit) params.set('limit', String(filter.limit));
            const qs = params.toString();
            return jsonFetch(
                `/api/resumes${qs ? '?' + qs : ''}`,
                z.object({
                    resumes: z.array(z.object({
                        id: z.string(),
                        userId: z.string(),
                        applicationId: z.string().nullable(),
                        createdAt: z.string(),
                        templateKey: z.string(),
                        format: z.string(),
                        status: z.string(),
                        hasArtifact: z.boolean(),
                        error: z.string().nullable(),
                        // M8.4.3 — drives the previous-resumes dropdown labels.
                        postingTitle: z.string().nullable(),
                        postingCompany: z.string().nullable(),
                        // Fallback label for legacy rows (pre-M8.4.2 migration)
                        // where postingTitle/Company are null. Hostname for
                        // URL inputs, first 80 chars for pasted text.
                        postingInputSummary: z.string().nullable(),
                        // User's display name extracted from profileSnapshot
                        // (profile.headline at gen time — frozen so it matches
                        // what's printed on the artifact even if the user
                        // later edits their profile).
                        userDisplayName: z.string().nullable(),
                        // Present only in `?canonId=` mode — the canon version
                        // dropdown reads these. Optional/nullable since the
                        // general list omits them.
                        canonVersion: z.number().nullable().optional(),
                        isCanonical: z.boolean().optional(),
                    })),
                }),
            );
        },
        // Full row including selections — drives the "Why these bullets?" UI.
        get: (id: string, includeSnapshot = false) =>
            jsonFetch(
                `/api/resumes/${encodeURIComponent(id)}${includeSnapshot ? '?includeSnapshot=1' : ''}`,
                z.object({
                    resume: z.object({
                        id: z.string(),
                        userId: z.string(),
                        applicationId: z.string().nullable(),
                        createdAt: z.string(),
                        templateKey: z.string(),
                        format: z.string(),
                        status: z.string(),
                        hasArtifact: z.boolean(),
                        error: z.string().nullable(),
                        postingInput: z.unknown(),
                        selections: z.unknown(),
                        skillsGap: z.array(z.string()).default([]),
                        profileSnapshot: z.unknown().optional(),
                    }),
                }),
            ),
        // Returns a direct download URL — UI uses it as href, no fetch needed.
        downloadUrl: (id: string) => `/api/resumes/${encodeURIComponent(id)}/download`,
        // Story S10.2 — side-by-side diff between two GeneratedResume rows
        // (selections deltas, posting-keyword deltas, skills-gap deltas).
        // Returns the diff shape from lib/resumes/diff.ts.
        diff: (a: string, b: string) =>
            jsonFetch(
                `/api/resumes/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
                z.object({
                    diff: z.object({
                        a: z.object({ id: z.string(), createdAt: z.string(), applicationId: z.string().nullable(), company: z.string().nullable(), title: z.string().nullable() }),
                        b: z.object({ id: z.string(), createdAt: z.string(), applicationId: z.string().nullable(), company: z.string().nullable(), title: z.string().nullable() }),
                        keywords: z.object({ onlyA: z.array(z.string()), onlyB: z.array(z.string()), both: z.array(z.string()) }),
                        skillsGap: z.object({ onlyA: z.array(z.string()), onlyB: z.array(z.string()), both: z.array(z.string()) }),
                        selections: z.object({
                            onlyA: z.array(z.unknown()),
                            onlyB: z.array(z.unknown()),
                            shared: z.array(z.object({
                                bulletId: z.string(),
                                a: z.unknown(),
                                b: z.unknown(),
                                rewriteChanged: z.boolean(),
                                originalChanged: z.boolean(),
                                scoreDelta: z.number(),
                                keywordsOnlyA: z.array(z.string()),
                                keywordsOnlyB: z.array(z.string()),
                                tagsOnlyA: z.array(z.string()),
                                tagsOnlyB: z.array(z.string()),
                            })),
                        }),
                        summary: z.object({
                            keywordsChanged: z.number(),
                            selectionsChanged: z.number(),
                            rewritesChanged: z.number(),
                        }),
                    }),
                }),
            ),
    },

    blacklist: {
        // GET/POST/DELETE /api/blacklist — user-curated companies that must
        // never be re-suggested in any picker (directory results, Discover
        // tab, auto-discover sparse-fallback). normalizedName is the dedup
        // key; if the user adds "Anduril" then "Anduril Industries", the
        // second add 409s in the DB and we return the existing row.
        list: () =>
            jsonFetch(
                '/api/blacklist',
                z.object({
                    entries: z.array(z.object({
                        id: z.string(),
                        name: z.string(),
                        normalizedName: z.string(),
                        reason: z.string().nullable(),
                        createdAt: z.string(),
                    })),
                }),
            ),
        add: (input: { name: string; reason?: string | null }) =>
            jsonFetch(
                '/api/blacklist',
                z.object({
                    entry: z.object({
                        id: z.string(),
                        name: z.string(),
                        normalizedName: z.string(),
                        reason: z.string().nullable(),
                        createdAt: z.string(),
                    }),
                }),
                jsonBody('POST', input),
            ),
        remove: (id: string) =>
            jsonFetch(
                `/api/blacklist/${encodeURIComponent(id)}`,
                z.object({ success: z.literal(true), id: z.string() }),
                { method: 'DELETE' },
            ),
    },

    canons: {
        // GET /api/canons — one reusable resume per role-archetype. Optional
        // ?track=career|side filter.
        list: (filter?: { track?: string }) => {
            const qs = filter?.track ? `?track=${encodeURIComponent(filter.track)}` : '';
            return jsonFetch(`/api/canons${qs}`, CanonsListResponseSchema);
        },
        // POST /api/canons — 201; 409 if the (slug) collides with an existing
        // canon. jsonFetch surfaces the 409 body's `error` as the thrown
        // message so the caller can show "name already used".
        create: (input: {
            name: string;
            track: 'career' | 'side';
            keywords?: string;
            description?: string | null;
            onePage?: boolean;
        }) => jsonFetch('/api/canons', CanonMutationResponseSchema, jsonBody('POST', input)),
        // PATCH /api/canons/{id} — editing `keywords` marks the canon stale.
        update: (
            id: string,
            input: {
                name?: string;
                keywords?: string;
                description?: string | null;
                onePage?: boolean;
                active?: boolean;
            },
        ) =>
            jsonFetch(
                `/api/canons/${encodeURIComponent(id)}`,
                CanonMutationResponseSchema,
                jsonBody('PATCH', input),
            ),
        delete: (id: string) =>
            jsonFetch(
                `/api/canons/${encodeURIComponent(id)}`,
                CanonDeleteResponseSchema,
                { method: 'DELETE' },
            ),
    },

    discovery: {
        // POST /api/discovery/suggest — Gemini-suggested companies for a topic,
        // each probed live against Greenhouse/Lever/Ashby. Returns two buckets:
        // `verified` (addable as watchlists) and `unverified` (workday /
        // self-hosted / probe failed — surfaced to the user for manual flagging).
        suggest: (input: { topic: string; additionalExclude?: string[] }) =>
            jsonFetch(
                '/api/discovery/suggest',
                z.object({
                    topic: z.string(),
                    verified: z.array(z.object({
                        name: z.string(),
                        blurb: z.string(),
                        kind: z.enum(['greenhouse', 'lever', 'ashby']),
                        slug: z.string(),
                        companyName: z.string(),
                        jobCount: z.number().int(),
                    })),
                    unverified: z.array(z.object({
                        name: z.string(),
                        blurb: z.string(),
                        careersUrl: z.string(),
                        atsGuess: z.string(),
                        reason: z.string(),
                    })),
                    excludedCount: z.number().int(),
                    totalSuggested: z.number().int(),
                }),
                jsonBody('POST', input),
            ),
    },
};
