import { z } from 'zod';
import { toastStore } from './toast-store';
import {
    TasksListResponseSchema,
    TaskMutationResponseSchema,
    TaskCreateResponseSchema,
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
    savedPapers: (filter?: { topic?: string | null; status?: string | null }) =>
        ['saved-papers', filter ?? {}] as const,
};

// ─── API surface ───────────────────────────────────────────────────────────

export const api = {
    tasks: {
        list: () => jsonFetch('/api/tasks', TasksListResponseSchema),
        update: (input: z.infer<typeof TaskPatchSchema>) =>
            jsonFetch('/api/tasks', TaskMutationResponseSchema, jsonBody('PATCH', input)),
        create: (input: z.infer<typeof TaskPostSchema>) =>
            jsonFetch('/api/tasks', TaskCreateResponseSchema, jsonBody('POST', input)),
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
        backfill: (input?: z.infer<typeof BackfillRequestSchema>) =>
            jsonFetch(
                '/api/applications/backfill',
                BackfillResponseSchema,
                jsonBody('POST', input ?? {})
            ),
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
};
