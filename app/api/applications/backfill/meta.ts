import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "One-shot maintenance sweep that scans the user's inbox for application-likely emails over the last N days and runs each through the same ingest pipeline as the Gmail webhook, reporting created/updated/skipped counts.",
    external: ["Gmail API v1", "Gemini"],
    notes: "Idempotent (ingest dedupes); broadcasts Application/CalendarEvent invalidate SSE events when any rows change.",
};
