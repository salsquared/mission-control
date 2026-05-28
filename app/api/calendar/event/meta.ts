import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: "Read upcoming events, create/update an event, or delete an event on the user's primary Google Calendar; user id is derived from the session.",
  external: ["Google Calendar API v3"],
  notes: "Mutations broadcast { model: 'CalendarEvent', action: 'upsert'|'delete' }. All times treated as UTC. When POST has an eventId the event is updated, otherwise inserted.",
};
