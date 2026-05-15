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
} from './schemas/applications';
import {
    SettingsGetResponseSchema,
    SettingsPostResponseSchema,
    SettingsPostConflictSchema,
    SettingsPostSchema,
} from './schemas/settings';
import { SystemTelemetryResponseSchema } from './schemas/system';
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

// ─── Query keys (TanStack tuples) ──────────────────────────────────────────
// Keep these stable — useServerEvents callbacks invalidate by these keys.
export const queryKeys = {
    tasks: ['tasks'] as const,
    goals: ['goals'] as const,
    applications: ['applications'] as const,
    settings: ['settings'] as const,
    system: ['system'] as const,
    calendarEvents: ['calendar-events'] as const,
    applicationEvents: (filter?: { applicationId?: string | null; upcoming?: boolean; kinds?: readonly string[] }) =>
        ['application-events', filter ?? {}] as const,
    savedPapers: (filter?: { topic?: string | null; status?: string | null }) =>
        ['saved-papers', filter ?? {}] as const,
    profile: ['profile'] as const,
    watchlists: ['watchlists'] as const,
    postings: (filter?: { status?: string; watchlistId?: string }) =>
        ['postings', filter ?? {}] as const,
    posting: (id: string) => ['posting', id] as const,
    notifications: (filter?: { unread?: boolean }) =>
        ['notifications', filter ?? {}] as const,
};

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
        list: () => jsonFetch('/api/applications', ApplicationsListResponseSchema),
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
        list: () => jsonFetch('/api/watchlists', WatchlistsListResponseSchema),
        create: (input: z.infer<typeof WatchlistPostSchema>) =>
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
        list: (filter?: { status?: string; watchlistId?: string; limit?: number }) => {
            const params = new URLSearchParams();
            if (filter?.status) params.set('status', filter.status);
            if (filter?.watchlistId) params.set('watchlistId', filter.watchlistId);
            if (filter?.limit) params.set('limit', String(filter.limit));
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
};
