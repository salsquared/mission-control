/**
 * Gmail-OAuth-backed email sender (OQ1 decision, 2026-05-15).
 *
 * Uses the OAuth token NextAuth already collected with `gmail.send` scope —
 * no separate API key, no separate provider account. From-address is the
 * authenticated user's own Gmail.
 *
 * The pure RFC 822 + base64url builder is exported separately so it can be
 * unit-tested without touching the network.
 */
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { getGoogleAuthClient } from "@/lib/googleapis";

export interface EmailMessage {
    from: string;       // "Display Name <addr@gmail.com>" or just "addr@gmail.com"
    to: string;
    subject: string;
    /** Plain-text body. Always sent — clients without HTML support fall back. */
    text: string;
    /** Optional HTML body. If provided, the message is multipart/alternative. */
    html?: string;
}

/**
 * RFC 2047 base64-encoded header (UTF-8) — preserves accents/emoji in
 * Subject and From display names. Skips encoding for pure-ASCII inputs.
 */
export function encodeMimeHeader(value: string): string {
    // eslint-disable-next-line no-control-regex
    if (!/[^\x20-\x7e]/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Base64url-encode a string (Gmail API expects URL-safe base64 with no
 * padding for the `raw` field).
 */
export function base64UrlEncode(s: string | Buffer): string {
    const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
    return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a complete RFC 822 message string from an EmailMessage. Returns the
 * raw text — caller base64url-encodes before passing to the Gmail API.
 */
export function buildRfc822Message(msg: EmailMessage): string {
    const headers: string[] = [];
    headers.push(`From: ${encodeMimeHeader(msg.from)}`);
    headers.push(`To: ${encodeMimeHeader(msg.to)}`);
    headers.push(`Subject: ${encodeMimeHeader(msg.subject)}`);
    headers.push("MIME-Version: 1.0");

    if (msg.html) {
        // 32-char hex boundary — Gmail accepts longer but this is plenty.
        const boundary = `=_mc_${Buffer.from(`${Date.now()}-${Math.random()}`).toString("hex").slice(0, 24)}`;
        headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        const parts = [
            "",
            `--${boundary}`,
            'Content-Type: text/plain; charset="UTF-8"',
            "Content-Transfer-Encoding: 7bit",
            "",
            msg.text,
            `--${boundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            "Content-Transfer-Encoding: 7bit",
            "",
            msg.html,
            `--${boundary}--`,
            "",
        ];
        return headers.join("\r\n") + "\r\n" + parts.join("\r\n");
    }
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: 7bit");
    return headers.join("\r\n") + "\r\n\r\n" + msg.text;
}

export interface SendResult {
    ok: boolean;
    messageId?: string;
    error?: string;
}

/**
 * Send an email from the user's own Gmail. Requires gmail.send scope on the
 * OAuth grant (already requested in lib/auth.ts).
 */
export async function sendEmailViaGmail(userId: string, msg: EmailMessage): Promise<SendResult> {
    try {
        const auth = await getGoogleAuthClient(userId);
        const gmail = google.gmail({ version: "v1", auth });
        const raw = base64UrlEncode(buildRfc822Message(msg));
        const res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw },
        });
        return { ok: true, messageId: res.data.id ?? undefined };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: message };
    }
}

// ─── Notification → email mapping ────────────────────────────────────────

interface NotificationLike {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    payload: string;
}

interface UserLike {
    id: string;
    email: string | null;
    name: string | null;
}

/**
 * Map a Notification row to an outgoing EmailMessage. Pure / hermetic-
 * testable — no DB, no network.
 */
export function notificationToEmail(notification: NotificationLike, user: UserLike): EmailMessage | null {
    if (!user.email) return null;
    const fromName = user.name || "Mission Control";
    const subject = `[mission-control] ${notification.title}`;
    const body = notification.body ?? "";
    const text = body
        ? `${notification.title}\n\n${body}\n\n— mission-control`
        : `${notification.title}\n\n— mission-control`;
    const html = `<div style="font-family:-apple-system,sans-serif;max-width:540px">
        <div style="font-size:15px;font-weight:600;color:#111;margin-bottom:8px">${escapeHtml(notification.title)}</div>
        ${body ? `<div style="font-size:14px;color:#333;white-space:pre-wrap">${escapeHtml(body)}</div>` : ""}
        <div style="margin-top:16px;font-size:11px;color:#888">— mission-control</div>
    </div>`;
    return {
        from: `${fromName} <${user.email}>`,
        to: user.email,
        subject,
        text,
        html,
    };
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Dispatch a Notification through the email channel. Updates `emailSentAt`
 * or `emailError` on the row. Best-effort: never throws.
 */
export async function dispatchNotificationEmail(notificationId: string): Promise<void> {
    const notification = await prisma.notification.findUnique({
        where: { id: notificationId },
        include: { user: { select: { id: true, email: true, name: true } } },
    });
    if (!notification) return;
    if (notification.emailSentAt) return; // already sent
    if (!notification.channels.includes("email")) return; // not configured for email

    const msg = notificationToEmail(notification, notification.user);
    if (!msg) {
        await prisma.notification.update({
            where: { id: notificationId },
            data: { emailError: "user has no email address" },
        }).catch(() => undefined);
        return;
    }

    const result = await sendEmailViaGmail(notification.userId, msg);
    if (result.ok) {
        await prisma.notification.update({
            where: { id: notificationId },
            data: { emailSentAt: new Date(), emailError: null },
        }).catch(() => undefined);
    } else {
        await prisma.notification.update({
            where: { id: notificationId },
            data: { emailError: result.error ?? "unknown error" },
        }).catch(() => undefined);
    }
}
