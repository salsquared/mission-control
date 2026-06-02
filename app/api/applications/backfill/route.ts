import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { requireSession } from "@/lib/auth-guards";
import { findUserByEmail } from "@/lib/repositories/users";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { broadcastEvent } from "@/lib/events";
import { ingestGmailMessage } from "@/lib/applications/ingest";
import { buildGmailQuery } from "@/lib/applications/relevance";
import { BackfillRequestSchema } from "@/lib/schemas/applications";

// Pin to Node — googleapis pulls in node:* imports.
export const runtime = "nodejs";

const DEFAULT_DAYS = 180;
const DEFAULT_MAX = 200;

/**
 * One-shot inbox scan. Finds application-likely emails in the last N days
 * (default 180), runs each through the same ingest pipeline as the Gmail
 * webhook, and reports counts. Idempotent — re-running it won't duplicate
 * applications because ingest dedupes by `Application.lastEmailMsgId`.
 *
 * Synchronous on purpose: callers cap `max` so total runtime is bounded.
 * For larger sweeps, the user can re-run with a tighter `days` window or
 * we can later move this to a background job.
 */
export async function POST(req: NextRequest) {
    const started = Date.now();
    try {
        // RAH-24: switched from inline getServerSession to the shared
        // requireSession helper for consistency with the rest of the API surface.
        const guard = await requireSession();
        if ('error' in guard) return guard.error;
        // requireSession guarantees session.user.email is non-null (it returns
        // a 401 otherwise) but TS doesn't carry the narrowing — assert.
        const sessionEmail = guard.session.user!.email!;

        const body = await req.json().catch(() => ({}));
        const parsed = BackfillRequestSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const days = parsed.data.days ?? DEFAULT_DAYS;
        const max = parsed.data.max ?? DEFAULT_MAX;

        const user = await findUserByEmail(sessionEmail);
        if (!user) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        const authClient = await getGoogleAuthClient(user.id);
        const gmail = google.gmail({ version: "v1", auth: authClient });
        const query = buildGmailQuery(days);

        // Page through messages.list until we've collected up to `max` ids
        // or Gmail runs out. messages.list maxes out at 500 per page.
        const ids: string[] = [];
        let pageToken: string | undefined;
        let truncated = false;

        while (ids.length < max) {
            const remaining = max - ids.length;
            const listRes = await gmail.users.messages.list({
                userId: "me",
                q: query,
                maxResults: Math.min(remaining, 500),
                pageToken,
            });
            for (const m of listRes.data.messages ?? []) {
                if (m.id) ids.push(m.id);
                if (ids.length >= max) break;
            }
            pageToken = listRes.data.nextPageToken ?? undefined;
            if (!pageToken) break;
        }

        if (pageToken) truncated = true;

        const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };

        // Sequential on purpose. Gemini Flash + Gmail are both rate-limited;
        // hammering them with 200 parallel calls invites 429s. ~100ms/call ×
        // 200 = ~20s, well inside Next's default route timeout.
        for (const id of ids) {
            // Per-message isolation (2026-06-01): ingestGmailMessage is meant
            // to return {action:"errored"} for per-message failures, but an
            // unforeseen THROW (e.g. a Prisma P2002 from a dedup-heuristic
            // update collision) must not abort the entire sweep and 500 the
            // scan. Mirror the Gmail webhook's per-`messagesAdded` try/catch:
            // one bad email increments `errored` and the loop continues.
            let outcome: Awaited<ReturnType<typeof ingestGmailMessage>>;
            try {
                outcome = await ingestGmailMessage({
                    userId: user.id,
                    gmail,
                    msgId: id,
                    broadcast: false, // single broadcast at the end
                });
            } catch (err: any) {
                outcome = { action: "errored", reason: err?.message ?? String(err) };
            }
            counts[outcome.action] = (counts[outcome.action] ?? 0) + 1;
            if (outcome.action === "errored") {
                console.warn(`[BACKFILL] msg ${id}: ${outcome.reason}`);
            }
        }

        if (counts.created > 0 || counts.updated > 0) {
            broadcastEvent({ model: "Application", action: "invalidate", timestamp: Date.now() });
            broadcastEvent({ model: "CalendarEvent", action: "invalidate", timestamp: Date.now() });
        }

        const result = {
            scanned: ids.length,
            classified: counts.created + counts.updated + counts.skipped,
            created: counts.created,
            updated: counts.updated,
            skipped: counts.skipped,
            errored: counts.errored,
            durationMs: Date.now() - started,
            truncated,
        };
        console.info(`[BACKFILL] ${JSON.stringify(result)}`);
        return NextResponse.json(result, { status: 200 });
    } catch (error: any) {
        console.error("Error in applications backfill:", error);
        return NextResponse.json(
            { error: error?.message ?? "Internal Server Error" },
            { status: 500 }
        );
    }
}
