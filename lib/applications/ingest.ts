import type { gmail_v1 } from "googleapis";
import { prisma } from "@/lib/prisma";
import { parseApplicationEmail, type ParsedApplicationEmail } from "@/lib/email-parser";
import { broadcastEvent } from "@/lib/events";
import { looksRelevant } from "@/lib/applications/relevance";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";
import { extractSenderDomain } from "@/lib/applications/sender-domain";
import {
    findApplicationByCompany,
    findApplicationBySenderDomain,
    createApplication,
    updateApplication,
} from "@/lib/repositories/applications";
import {
    createApplicationEvents,
    findLatestStatusAnchor,
    maybeNotifyForApplicationEvent,
    NOTIFY_EVENT_KINDS,
    type ApplicationEventDraft,
} from "@/lib/repositories/applicationEvents";
import { syncEventToGcal } from "@/lib/calendar/sync";

export type IngestOutcome =
    | { action: "created"; appId: string }
    | { action: "updated"; appId: string }
    | { action: "skipped"; reason: "irrelevant" | "low_confidence" | "duplicate" | "already_present" }
    | { action: "errored"; reason: string };

export interface IngestOptions {
    userId: string;
    gmail: gmail_v1.Gmail;
    msgId: string;
    /** When false, suppress SSE broadcast (used by backfill to batch a single invalidation). */
    broadcast?: boolean;
}

/**
 * Pull a single Gmail message, run it through the keyword pre-filter and
 * the LLM classifier, then upsert an Application row.
 *
 * Idempotent across re-runs: if the existing Application row's
 * `lastEmailMsgId` already matches `msgId`, we skip the update. This makes
 * backfill safe to run multiple times.
 */
export async function ingestGmailMessage(opts: IngestOptions): Promise<IngestOutcome> {
    const { userId, gmail, msgId, broadcast = true } = opts;

    // Fast-path idempotency (2026-05-20). If we've already produced events
    // for this Gmail msgId AND every side-effect has been checkpointed,
    // skip the entire pipeline — no Gmail fetch, no Gemini call, no
    // upsert. Previously the early-skip lived AFTER the Gemini call, so a
    // rescan of a 200-email inbox would burn ~20 minutes re-classifying
    // emails we'd already classified (Gemini free-tier rate limit caps
    // throughput at ~12 req/min).
    //
    // Scoped by user via the Application → User relation: Gmail msgIds are
    // unique within an account, but two accounts on this server would
    // conflict without the scope (defensive).
    const priorEvents = await prisma.applicationEvent.findMany({
        where: {
            emailMsgId: msgId,
            application: { userId },
        },
    });
    if (priorEvents.length > 0 && priorEvents.every(eventFullyCommitted)) {
        return { action: "skipped", reason: "already_present" };
    }

    let message: gmail_v1.Schema$Message;
    try {
        const res = await gmail.users.messages.get({
            userId: "me",
            id: msgId,
            format: "full",
        });
        message = res.data;
    } catch (err: any) {
        return { action: "errored", reason: `gmail.get failed: ${err?.message ?? String(err)}` };
    }

    const subject = headerValue(message.payload?.headers, "Subject") ?? "";
    const from = headerValue(message.payload?.headers, "From") ?? "";
    const snippet = message.snippet ?? "";

    if (!looksRelevant({ subject, from, snippet })) {
        return { action: "skipped", reason: "irrelevant" };
    }

    const body = extractBody(message.payload);
    if (!body) {
        // Genuine empty body — pass subject + snippet so the classifier still
        // has something to work with. Better than dropping the message.
    }
    const classifierInput = body || `${subject}\n\n${snippet}`;

    const sentAt = messageDate(message) ?? new Date();
    let parsed;
    try {
        parsed = await parseApplicationEmail(classifierInput, subject, from, sentAt);
    } catch (err: any) {
        return { action: "errored", reason: `classifier failed: ${err?.message ?? String(err)}` };
    }

    if (!parsed.isApplicationRelated) {
        return { action: "skipped", reason: "irrelevant" };
    }
    if (parsed.confidence === "low") {
        return { action: "skipped", reason: "low_confidence" };
    }

    // PB-1: normalize before the lookup AND before the persist so both halves
    // of the dedup comparison are on the same footing. Drops "Inc"/"Corp"/etc
    // suffixes, leading "The ", NFKC-normalizes, collapses whitespace.
    parsed.company = normalizeCompanyName(parsed.company);
    if (!parsed.company) {
        return { action: "skipped", reason: "low_confidence" };
    }

    // Layered dedup (CSULB drift, 2026-05-20). Try the LLM's company name
    // first; if that misses, fall back to the sender's registrable domain.
    // `extractSenderDomain` returns null for multi-tenant ATS / admissions
    // platforms — those can't identify a single employer, so we don't fall
    // back to them.
    const senderDomain = extractSenderDomain(from);
    let existingApp = await findApplicationByCompany(userId, parsed.company);
    if (!existingApp && senderDomain) {
        const byDomain = await findApplicationBySenderDomain(userId, senderDomain);
        if (byDomain) {
            existingApp = byDomain;
            console.info(
                `[ingest] sender-domain fallback matched msg=${msgId} ` +
                `domain=${senderDomain} → app=${byDomain.id} ` +
                `(LLM=${JSON.stringify(parsed.company)} vs stored=${JSON.stringify(byDomain.company)})`,
            );
        }
    }

    // Note: PB-5's secondary early-skip (existingApp.lastEmailMsgId === msgId
    // + fully-committed check) used to live here. It's dead code now — the
    // fast-path at the top of this function strictly dominates it. The
    // retry-recovery fall-through (priorEvents exist but aren't all
    // committed) is preserved by the fast-path NOT firing in that case,
    // so we still reach the pipeline below and rerun the side-effects.

    let appId: string;
    let action: "created" | "updated";
    const previousStatus = existingApp?.status ?? null;

    // "Stale-email" guard (2026-05-20): when a user clicks ACCEPTED in the
    // kanban (or any newer status change happens), re-ingesting an OLDER
    // email about the same application must NOT downgrade their status. The
    // application's timeline already records every status anchor — both
    // user-driven (PATCH route emits STATUS_CHANGED at `new Date()`) and
    // ingest-driven (occurredAt = email.sentAt). If the latest anchor is
    // newer than this email's sentAt, the email is historically older than
    // the current truth — skip the status/role/nextSteps update and the
    // STATUS_CHANGED emission, but still record the factual events
    // (EMAIL_RECEIVED, plus OFFER/REJECTION/INTERVIEW_SCHEDULED/etc. — those
    // events DID happen at the email's date even if they no longer represent
    // the live status).
    //
    // Also fixes a latent same-scan bug: backfill iterates Gmail's
    // newest-first list, so without this guard the OLDEST email processed
    // would always win on status.
    let staleStatusUpdate = false;
    if (existingApp) {
        const anchor = await findLatestStatusAnchor(existingApp.id);
        if (anchor && anchor.occurredAt.getTime() > sentAt.getTime()) {
            staleStatusUpdate = true;
            console.info(
                `[ingest] skipping stale status update msg=${msgId} ` +
                `app=${existingApp.id} email.sentAt=${sentAt.toISOString()} ` +
                `< anchor.occurredAt=${anchor.occurredAt.toISOString()} ` +
                `(kind=${anchor.kind}, stored.status=${existingApp.status}, llm=${parsed.status})`,
            );
        }
    }

    if (existingApp) {
        // Don't rewrite `company` here. When the match came via senderDomain,
        // the LLM's name disagrees with the stored one (that's why we fell
        // through to the domain fallback) — preserving the stored name keeps
        // the display stable across LLM drift on subsequent emails.
        // Only stamp senderDomain when extraction yielded something — null
        // means "ATS-routed / unparseable", which shouldn't blow away a
        // previously captured good domain.
        // When staleStatusUpdate is set, status/role/nextSteps are skipped
        // and lastUpdateAt is left alone (no user-visible change happened);
        // we still bump lastEmailMsgId (idempotency marker) and senderDomain
        // (so future emails from that root can still match).
        await updateApplication(existingApp.id, {
            kind: parsed.kind ?? existingApp.kind,
            lastEmailMsgId: msgId,
            ...(staleStatusUpdate ? {} : {
                status: parsed.status,
                nextSteps: parsed.nextSteps ?? null,
                role: parsed.role || existingApp.role,
                lastUpdateAt: new Date(),
            }),
            ...(senderDomain ? { senderDomain } : {}),
        });
        appId = existingApp.id;
        action = "updated";
    } else {
        // PA-3: concurrent webhook + manual scan can both find no existing
        // row and both try createApplication. The @@unique([userId,
        // normalizedCompany]) makes one of them throw P2002 — catch and
        // recover by re-reading + updating, just as if `existingApp` had
        // been found on the first pass.
        try {
            const newApp = await createApplication({
                userId,
                company: parsed.company,
                role: parsed.role || "Unknown",
                status: parsed.status,
                kind: parsed.kind,
                nextSteps: parsed.nextSteps ?? null,
                dateApplied: sentAt,
                lastEmailMsgId: msgId,
                lastUpdateAt: new Date(),
                senderDomain: senderDomain ?? null,
            });
            appId = newApp.id;
            action = "created";
        } catch (err: any) {
            if (err?.code !== "P2002") throw err;
            const raced = await findApplicationByCompany(userId, parsed.company);
            if (!raced) {
                // The conflict came from somewhere else (different unique
                // constraint, transient state). Surface so we don't silently
                // lose the email.
                return { action: "errored", reason: `P2002 on createApplication but follow-up find returned null` };
            }
            // Race-loser stale check: the race-winner just inserted an APPLIED
            // event at its own sentAt; if we're processing an OLDER email we
            // shouldn't downgrade their status. Same rule as the existingApp
            // branch above.
            const racedAnchor = await findLatestStatusAnchor(raced.id);
            if (racedAnchor && racedAnchor.occurredAt.getTime() > sentAt.getTime()) {
                staleStatusUpdate = true;
            }
            await updateApplication(raced.id, {
                kind: parsed.kind ?? raced.kind,
                lastEmailMsgId: msgId,
                ...(staleStatusUpdate ? {} : {
                    status: parsed.status,
                    nextSteps: parsed.nextSteps ?? null,
                    role: parsed.role || raced.role,
                    lastUpdateAt: new Date(),
                }),
                ...(senderDomain ? { senderDomain } : {}),
            });
            appId = raced.id;
            action = "updated";
        }
    }

    const eventDrafts = buildEventDrafts({
        appId,
        msgId,
        subject,
        sentAt,
        parsed,
        action,
        previousStatus,
        staleStatusUpdate,
    });
    await createApplicationEvents(eventDrafts);

    // PB-5: re-fetch ALL events for this (appId, msgId) — not just the rows
    // newly inserted by this run. Side-effects need to fire for any event
    // whose checkpoint is still null, regardless of whether THIS run created
    // it or a previous (crashed) run did.
    const allEventsForMsg = await prisma.applicationEvent.findMany({
        where: { applicationId: appId, emailMsgId: msgId },
    });

    // Fire in-app notifications for attention-worthy kinds (MB-3.1, story 27).
    // Best-effort — failure leaves notifiedAt null so the next ingest of this
    // msg picks it back up.
    for (const ev of allEventsForMsg) {
        if (!NOTIFY_EVENT_KINDS.has(ev.kind)) continue;
        if (ev.notifiedAt) continue; // already stamped on a prior run
        try {
            await maybeNotifyForApplicationEvent(ev, userId, parsed.company);
            await prisma.applicationEvent.update({
                where: { id: ev.id },
                data: { notifiedAt: new Date() },
            });
        } catch (e) {
            console.warn(`[ingest] notify side-effect failed for event ${ev.id} — will retry next ingest:`, e);
        }
    }

    // Mirror future-dated events to Gcal. We skip past events because backfill
    // commonly walks 6 months of history — no point creating yesterday's
    // interview on the user's calendar.
    const now = Date.now();
    for (const ev of allEventsForMsg) {
        if (!ev.scheduledAt) continue;
        if (ev.scheduledAt.getTime() < now) continue;
        if (ev.gcalSyncedAt) continue; // already mirrored
        try {
            await syncEventToGcal(userId, ev, { company: parsed.company, role: parsed.role ?? null });
            await prisma.applicationEvent.update({
                where: { id: ev.id },
                data: { gcalSyncedAt: new Date() },
            });
        } catch (e) {
            console.warn(`[ingest] gcal sync failed for event ${ev.id} — will retry next ingest:`, e);
        }
    }

    if (broadcast) {
        broadcastEvent({ model: "Application", action: "upsert", id: appId, timestamp: Date.now() });
        if (allEventsForMsg.length > 0) {
            broadcastEvent({ model: "CalendarEvent", action: "invalidate", timestamp: Date.now() });
        }
    }

    return action === "created" ? { action: "created", appId } : { action: "updated", appId };
}

/**
 * PB-5: an event is "fully committed" when every applicable side-effect has
 * its checkpoint stamped. Used by the early-skip in the main pipeline.
 */
function eventFullyCommitted(ev: {
    kind: string;
    scheduledAt: Date | null;
    notifiedAt: Date | null;
    gcalSyncedAt: Date | null;
}): boolean {
    const notifyOk = !NOTIFY_EVENT_KINDS.has(ev.kind) || ev.notifiedAt !== null;
    const needsGcal = ev.scheduledAt !== null && ev.scheduledAt.getTime() >= Date.now();
    const gcalOk = !needsGcal || ev.gcalSyncedAt !== null;
    return notifyOk && gcalOk;
}

/**
 * Translate a parsed email + the resulting Application action into the
 * timeline rows we want to write. The unique constraint on
 * (applicationId, emailMsgId, kind) makes re-runs idempotent: createMany
 * skips duplicates rather than failing.
 *
 * Note: we emit at most one INTERVIEW_SCHEDULED / ASSESSMENT_REQUESTED per
 * email. Most rescheduling emails carry one date, and the unique constraint
 * couldn't represent multiple per-email rows of the same kind anyway.
 */
function buildEventDrafts(input: {
    appId: string;
    msgId: string;
    subject: string;
    sentAt: Date;
    parsed: ParsedApplicationEmail;
    action: "created" | "updated";
    previousStatus: string | null;
    /** Set when ingest skipped the Application.status update because a
     *  newer status anchor exists. Suppresses STATUS_CHANGED emission so
     *  the timeline doesn't claim a transition that didn't happen. */
    staleStatusUpdate: boolean;
}): ApplicationEventDraft[] {
    const { appId, msgId, subject, sentAt, parsed, action, previousStatus, staleStatusUpdate } = input;
    const drafts: ApplicationEventDraft[] = [];

    drafts.push({
        applicationId: appId,
        kind: "EMAIL_RECEIVED",
        title: subject || `Email about ${parsed.company}`,
        occurredAt: sentAt,
        emailMsgId: msgId,
        notes: parsed.nextSteps ?? null,
        syncSource: "ms",
    });

    if (action === "created") {
        drafts.push({
            applicationId: appId,
            kind: "APPLIED",
            title: `Applied to ${parsed.company}${parsed.role ? ` for ${parsed.role}` : ""}`,
            occurredAt: sentAt,
            emailMsgId: msgId,
            toStatus: parsed.status,
            syncSource: "ms",
        });
    } else if (previousStatus && previousStatus !== parsed.status && !staleStatusUpdate) {
        // staleStatusUpdate gate: we didn't actually change Application.status,
        // so emitting a STATUS_CHANGED row in the timeline would lie about a
        // transition that never happened.
        drafts.push({
            applicationId: appId,
            kind: "STATUS_CHANGED",
            title: `${parsed.company}: ${previousStatus} → ${parsed.status}`,
            occurredAt: sentAt,
            emailMsgId: msgId,
            fromStatus: previousStatus,
            toStatus: parsed.status,
            syncSource: "ms",
        });
    }

    if (parsed.status === "OFFER") {
        drafts.push({
            applicationId: appId,
            kind: "OFFER",
            title: `Offer from ${parsed.company}`,
            occurredAt: sentAt,
            emailMsgId: msgId,
            syncSource: "ms",
        });
    } else if (parsed.status === "REJECTED") {
        drafts.push({
            applicationId: appId,
            kind: "REJECTION",
            title: `Rejected by ${parsed.company}`,
            occurredAt: sentAt,
            emailMsgId: msgId,
            syncSource: "ms",
        });
    }

    let interviewEmitted = false;
    let assessmentEmitted = false;
    for (const dateEntry of parsed.extractedDates ?? []) {
        if (!dateEntry.startsAt) continue;
        const startsAt = new Date(dateEntry.startsAt);
        if (Number.isNaN(startsAt.getTime())) continue;
        const endsAt = dateEntry.endsAt ? new Date(dateEntry.endsAt) : null;
        const validEnd = endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null;

        if (dateEntry.kind === "INTERVIEW" && !interviewEmitted) {
            drafts.push({
                applicationId: appId,
                kind: "INTERVIEW_SCHEDULED",
                title: `Interview with ${parsed.company}`,
                occurredAt: sentAt,
                scheduledAt: startsAt,
                endsAt: validEnd ?? new Date(startsAt.getTime() + 60 * 60 * 1000),
                emailMsgId: msgId,
                notes: dateEntry.rawText,
                syncSource: "ms",
            });
            interviewEmitted = true;
        } else if (dateEntry.kind === "ASSESSMENT" && !assessmentEmitted) {
            drafts.push({
                applicationId: appId,
                kind: "ASSESSMENT_REQUESTED",
                title: `Assessment for ${parsed.company}`,
                occurredAt: sentAt,
                scheduledAt: startsAt,
                endsAt: validEnd,
                emailMsgId: msgId,
                notes: dateEntry.rawText,
                syncSource: "ms",
            });
            assessmentEmitted = true;
        }
    }

    return drafts;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function headerValue(
    headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
    name: string
): string | undefined {
    if (!headers) return undefined;
    const lower = name.toLowerCase();
    const h = headers.find((x) => (x.name ?? "").toLowerCase() === lower);
    return h?.value ?? undefined;
}

/**
 * Walk the MIME tree and return the first text/plain body. Falls back to
 * text/html (with tags stripped) and finally to the root body.data.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return "";

    const plain = findFirstByMime(payload, "text/plain");
    if (plain) return plain;

    const html = findFirstByMime(payload, "text/html");
    if (html) return stripHtml(html);

    if (payload.body?.data) return decode(payload.body.data);
    return "";
}

function findFirstByMime(part: gmail_v1.Schema$MessagePart, mime: string): string {
    if (part.mimeType === mime && part.body?.data) {
        return decode(part.body.data);
    }
    for (const child of part.parts ?? []) {
        const found = findFirstByMime(child, mime);
        if (found) return found;
    }
    return "";
}

function decode(data: string): string {
    // Gmail uses URL-safe base64 (sometimes without padding). Buffer in Node 24
    // handles both encodings, but normalize to be safe.
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf-8");
}

function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function messageDate(message: gmail_v1.Schema$Message): Date | null {
    if (message.internalDate) {
        const ms = Number(message.internalDate);
        if (Number.isFinite(ms)) return new Date(ms);
    }
    return null;
}
