/**
 * Hermetic smoke for the self-notification mail-loop guard (2026-06-02).
 *
 * Background — the loop this prevents:
 *   mission-control sends application notifications FROM → TO the user's own
 *   Gmail (notificationToEmail: from and to are both user.email). Those land
 *   back in the INBOX the Gmail webhook watches, so the webhook re-ingests our
 *   OWN outbound mail, the LLM classifies it as a fresh interview/offer, fires
 *   another notification → another email → re-ingest → … On 2026-06-02 a single
 *   CalSAWS interview notification looped 552× in ~20 min (each iteration a
 *   distinct Gmail msgId, so the per-message @@unique dedup couldn't stop it;
 *   critical tier bypasses quiet hours), halted only by Gmail's send throttle.
 *
 * What we assert:
 *   A. isSelfNotificationEmail matrix — header signal, subject-prefix signal,
 *      neither, case/whitespace tolerance.
 *   B. Closed loop — what notificationToEmail produces (subject prefix + the
 *      X-Mission-Control header) is EXACTLY what isSelfNotificationEmail flags,
 *      and the header survives buildRfc822Message into the raw RFC 822 bytes.
 *   C. Free-mail is dedup-blocked but NOT a positive relevance signal:
 *      extractSenderDomain("…@gmail.com") === null, yet looksRelevant on a bare
 *      gmail.com sender with no keywords stays false (we did NOT widen the
 *      classifier's intake to all personal mail).
 *   D. Source guards: ingest.ts imports the guard, calls it, and returns
 *      reason "self_notification" BEFORE the looksRelevant/classifier steps.
 *
 * Pure — no DB, no network.
 *
 *   npx tsx scripts/tests/hermetic/self-notification-loop-guard-smoke.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import {
    isSelfNotificationEmail,
    MC_NOTIFICATION_HEADER,
    MC_NOTIFICATION_HEADER_VALUE,
    MC_SUBJECT_PREFIX,
} from "@/lib/applications/self-notification";
import { notificationToEmail, buildRfc822Message } from "@/lib/email/send";
import { extractSenderDomain } from "@/lib/applications/sender-domain";
import { looksRelevant, SENDER_DOMAINS, FREE_MAIL_DOMAINS } from "@/lib/applications/relevance";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// ─── Case A: isSelfNotificationEmail matrix ─────────────────────────────────
check("A: header signal flags self-notification",
    isSelfNotificationEmail({ subject: "anything", mcHeader: MC_NOTIFICATION_HEADER_VALUE }));
check("A: subject-prefix signal flags self-notification (no header)",
    isSelfNotificationEmail({ subject: `${MC_SUBJECT_PREFIX}Acme — Offer`, mcHeader: null }));
check("A: header value is case/whitespace tolerant",
    isSelfNotificationEmail({ subject: "x", mcHeader: "  NOTIFICATION " }));
check("A: a genuine inbound email is NOT flagged",
    !isSelfNotificationEmail({ subject: "Thank you for applying to Acme", mcHeader: null }));
check("A: prefix only matches at the START (substring elsewhere is not enough)",
    !isSelfNotificationEmail({ subject: `Re: ${MC_SUBJECT_PREFIX}forwarded`, mcHeader: undefined }));

// ─── Case B: closed loop — what we send is what we skip ─────────────────────
const email = notificationToEmail(
    { id: "n1", kind: "application", title: "California Statewide — Interview", body: "tmrw 2pm", payload: "{}" },
    { id: "u1", email: "sal@gmail.com", name: "Sal" },
);
check("B: notificationToEmail returned a message", email !== null);
if (email) {
    check("B: subject carries the [mission-control] prefix",
        email.subject.startsWith(MC_SUBJECT_PREFIX), `subject=${JSON.stringify(email.subject)}`);
    check("B: the X-Mission-Control header is stamped",
        email.headers?.[MC_NOTIFICATION_HEADER] === MC_NOTIFICATION_HEADER_VALUE,
        `headers=${JSON.stringify(email.headers)}`);
    check("B: ingest WOULD flag this exact outbound message (loop closed)",
        isSelfNotificationEmail({
            subject: email.subject,
            mcHeader: email.headers?.[MC_NOTIFICATION_HEADER],
        }));

    // The header must survive into the raw RFC 822 bytes Gmail will round-trip.
    const raw = buildRfc822Message(email);
    const headerLine = raw.split("\r\n").find(l => l.toLowerCase().startsWith(`${MC_NOTIFICATION_HEADER.toLowerCase()}:`));
    check("B: header line present in built RFC 822 message",
        headerLine !== undefined, `raw head=${JSON.stringify(raw.slice(0, 200))}`);
    // Parse the value back out the way headerValue would and re-flag it.
    const parsedValue = headerLine?.slice(headerLine.indexOf(":") + 1).trim() ?? null;
    check("B: round-tripped header value still flags as self-notification",
        isSelfNotificationEmail({ subject: "stripped-by-mail-client", mcHeader: parsedValue }),
        `parsedValue=${JSON.stringify(parsedValue)}`);
}

// ─── Case C: free-mail blocked for dedup, NOT a positive relevance signal ───
check("C: extractSenderDomain('…@gmail.com') === null (dedup-blocked)",
    extractSenderDomain("sal@gmail.com") === null);
check("C: a real employer domain still resolves",
    extractSenderDomain("careers@stripe.com") === "stripe.com");
check("C: FREE_MAIL_DOMAINS is disjoint from the positive SENDER_DOMAINS list",
    !FREE_MAIL_DOMAINS.some(d => SENDER_DOMAINS.includes(d)),
    `overlap=${FREE_MAIL_DOMAINS.filter(d => SENDER_DOMAINS.includes(d)).join(",")}`);
check("C: a bare gmail.com sender with no keywords is NOT relevant (intake not widened)",
    !looksRelevant({ subject: "lunch?", from: "friend@gmail.com", snippet: "wanna grab food" }));
check("C: a real keyworded email is still relevant regardless of sender",
    looksRelevant({ subject: "Interview with Acme", from: "friend@gmail.com", snippet: "" }));

// ─── Case D: source-level regression guards ─────────────────────────────────
const ingestSrc = readFileSync(resolve(__dirname, "../../../lib/applications/ingest.ts"), "utf8");
check("D: ingest imports the self-notification guard",
    /isSelfNotificationEmail/.test(ingestSrc) && /from "@\/lib\/applications\/self-notification"/.test(ingestSrc));
check("D: ingest returns reason \"self_notification\"",
    /reason:\s*"self_notification"/.test(ingestSrc));
// The guard must run BEFORE the looksRelevant gate (so it short-circuits the
// classifier). Assert the self-notification return appears earlier in source.
check("D: self-notification guard precedes the looksRelevant gate",
    ingestSrc.indexOf('reason: "self_notification"') < ingestSrc.indexOf("if (!looksRelevant("),
    "the guard must short-circuit before classification");

const sendSrc = readFileSync(resolve(__dirname, "../../../lib/email/send.ts"), "utf8");
check("D: send.ts stamps the X-Mission-Control header on notifications",
    /\[MC_NOTIFICATION_HEADER\]:\s*MC_NOTIFICATION_HEADER_VALUE/.test(sendSrc));

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
console.log("All checks passed.");
