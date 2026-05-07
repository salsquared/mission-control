import type { gmail_v1 } from "googleapis";
import { parseApplicationEmail } from "@/lib/email-parser";
import { broadcastEvent } from "@/lib/events";
import { looksRelevant } from "@/lib/applications/relevance";
import {
    findApplicationByCompany,
    createApplication,
    updateApplication,
} from "@/lib/repositories/applications";

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

    let parsed;
    try {
        parsed = await parseApplicationEmail(classifierInput, subject, from);
    } catch (err: any) {
        return { action: "errored", reason: `classifier failed: ${err?.message ?? String(err)}` };
    }

    if (!parsed.isApplicationRelated) {
        return { action: "skipped", reason: "irrelevant" };
    }
    if (parsed.confidence === "low") {
        return { action: "skipped", reason: "low_confidence" };
    }

    const existingApp = await findApplicationByCompany(userId, parsed.company);

    if (existingApp && existingApp.lastEmailMsgId === msgId) {
        return { action: "skipped", reason: "duplicate" };
    }

    let appId: string;
    let action: "created" | "updated";

    if (existingApp) {
        await updateApplication(existingApp.id, {
            status: parsed.status,
            kind: parsed.kind ?? existingApp.kind,
            nextSteps: parsed.nextSteps ?? null,
            role: parsed.role || existingApp.role,
            lastEmailMsgId: msgId,
            lastUpdateAt: new Date(),
        });
        appId = existingApp.id;
        action = "updated";
    } else {
        const newApp = await createApplication({
            userId,
            company: parsed.company,
            role: parsed.role || "Unknown",
            status: parsed.status,
            kind: parsed.kind,
            nextSteps: parsed.nextSteps ?? null,
            dateApplied: messageDate(message) ?? new Date(),
            lastEmailMsgId: msgId,
            lastUpdateAt: new Date(),
        });
        appId = newApp.id;
        action = "created";
    }

    if (broadcast) {
        broadcastEvent({ model: "Application", action: "upsert", id: appId, timestamp: Date.now() });
    }

    return action === "created" ? { action: "created", appId } : { action: "updated", appId };
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
