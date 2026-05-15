/**
 * Hermetic unit tests for the pure email-message builders in lib/email/send.ts.
 *
 *   npx tsx scripts/tests/email-message-smoke.ts
 *
 * Doesn't touch the network. Verifies RFC 822 + base64url + MIME-header
 * encoding work for the inputs the real Gmail send path will see.
 */
import {
    encodeMimeHeader,
    base64UrlEncode,
    buildRfc822Message,
    notificationToEmail,
} from "@/lib/email/send";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── encodeMimeHeader ────────────────────────────────────────────────────

if (encodeMimeHeader("Plain ASCII subject") !== "Plain ASCII subject") fail("ASCII header should pass through unchanged");
else pass("encodeMimeHeader: ASCII unchanged");

{
    const encoded = encodeMimeHeader("Café opens today ☕");
    if (!encoded.startsWith("=?UTF-8?B?") || !encoded.endsWith("?=")) fail(`UTF-8 header not RFC 2047 encoded: ${encoded}`);
    else pass("encodeMimeHeader: non-ASCII gets RFC 2047 encoded");
    // Decode round-trip
    const body = encoded.slice("=?UTF-8?B?".length, -2);
    const decoded = Buffer.from(body, "base64").toString("utf8");
    if (decoded !== "Café opens today ☕") fail("encodeMimeHeader: round-trip broken", decoded);
    else pass("encodeMimeHeader: round-trip preserves bytes");
}

// ─── base64UrlEncode ─────────────────────────────────────────────────────

{
    const out = base64UrlEncode("hello world!");
    // Standard base64 would be "aGVsbG8gd29ybGQh" → no +/= chars in this case
    if (out.includes("=") || out.includes("+") || out.includes("/")) fail("base64UrlEncode: should strip padding + url-safe chars");
    else pass("base64UrlEncode: no padding, no + or /");
}

{
    // Input chosen to force + and / in standard base64
    const out = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xff]));
    if (out.includes("+") || out.includes("/") || out.includes("=")) fail(`base64UrlEncode: still has unsafe chars: ${out}`);
    else if (out !== "-___") fail(`base64UrlEncode: expected '-___', got '${out}'`);
    else pass("base64UrlEncode: + → -, / → _, no padding");
}

// ─── buildRfc822Message (plain text) ────────────────────────────────────

{
    const raw = buildRfc822Message({
        from: "Sal <sal@example.com>",
        to: "sal@example.com",
        subject: "Test subject",
        text: "Hello\nWorld",
    });
    if (!raw.includes("From: Sal <sal@example.com>")) fail("RFC822 plain: From missing");
    else pass("RFC822 plain: From header set");
    if (!raw.includes("To: sal@example.com")) fail("RFC822 plain: To missing");
    else pass("RFC822 plain: To header set");
    if (!raw.includes("Subject: Test subject")) fail("RFC822 plain: Subject missing");
    else pass("RFC822 plain: Subject header set");
    if (!raw.includes("MIME-Version: 1.0")) fail("RFC822 plain: MIME-Version missing");
    else pass("RFC822 plain: MIME-Version set");
    if (!raw.includes('Content-Type: text/plain; charset="UTF-8"')) fail("RFC822 plain: Content-Type wrong");
    else pass("RFC822 plain: Content-Type text/plain UTF-8");
    if (!raw.endsWith("Hello\nWorld")) fail("RFC822 plain: body missing");
    else pass("RFC822 plain: body preserved");
    if (!raw.includes("\r\n\r\n")) fail("RFC822 plain: missing header/body separator");
    else pass("RFC822 plain: CRLF separator between headers + body");
}

// ─── buildRfc822Message (multipart with HTML) ───────────────────────────

{
    const raw = buildRfc822Message({
        from: "Sal <sal@example.com>",
        to: "sal@example.com",
        subject: "Multipart test",
        text: "plain version",
        html: "<p>html version</p>",
    });
    if (!raw.includes("multipart/alternative")) fail("RFC822 multipart: wrong content-type");
    else pass("RFC822 multipart: content-type multipart/alternative");
    const boundaryMatch = raw.match(/boundary="([^"]+)"/);
    if (!boundaryMatch) { fail("RFC822 multipart: boundary missing"); }
    const boundary = boundaryMatch ? boundaryMatch[1] : "";
    if (!raw.includes(`--${boundary}`)) fail("RFC822 multipart: opening boundary missing");
    else pass("RFC822 multipart: opening boundary present");
    if (!raw.includes(`--${boundary}--`)) fail("RFC822 multipart: closing boundary missing");
    else pass("RFC822 multipart: closing boundary present");
    if (!raw.includes("plain version")) fail("RFC822 multipart: text part missing");
    else pass("RFC822 multipart: text part included");
    if (!raw.includes("<p>html version</p>")) fail("RFC822 multipart: html part missing");
    else pass("RFC822 multipart: html part included");
}

// ─── buildRfc822Message (non-ASCII subject + display name) ──────────────

{
    const raw = buildRfc822Message({
        from: "Café Sal <sal@example.com>",
        to: "sal@example.com",
        subject: "Café opens today ☕",
        text: "body",
    });
    if (!/From: =\?UTF-8\?B\?/i.test(raw)) fail("RFC822: From with non-ASCII not encoded");
    else pass("RFC822: From with non-ASCII display name encoded RFC 2047");
    if (!/Subject: =\?UTF-8\?B\?/i.test(raw)) fail("RFC822: Subject with non-ASCII not encoded");
    else pass("RFC822: Subject with non-ASCII encoded RFC 2047");
}

// ─── notificationToEmail ─────────────────────────────────────────────────

{
    const email = notificationToEmail(
        { id: "n1", kind: "application", title: "Acme Inc — Interview scheduled", body: "Tuesday at 2pm — Zoom link in calendar", payload: "{}" },
        { id: "u1", email: "sal@gmail.com", name: "Sal Salcedo" },
    );
    if (!email) {
        fail("notificationToEmail: returned null with valid user.email");
    } else {
        if (email.from !== "Sal Salcedo <sal@gmail.com>") fail(`from wrong: ${email.from}`);
        else pass("notificationToEmail: from = 'Name <email>'");
        if (email.to !== "sal@gmail.com") fail(`to wrong: ${email.to}`);
        else pass("notificationToEmail: to = user's gmail");
        if (!email.subject.includes("Acme Inc — Interview scheduled")) fail("subject missing title");
        else pass("notificationToEmail: subject contains the title");
        if (!email.text.includes("Tuesday at 2pm")) fail("text missing body");
        else pass("notificationToEmail: text body included");
        if (!email.html || !email.html.includes("Tuesday at 2pm")) fail("html missing body");
        else pass("notificationToEmail: html body included");
    }
    // Verify HTML escaping
    const xss = notificationToEmail(
        { id: "n2", kind: "application", title: "<script>alert(1)</script>", body: null, payload: "{}" },
        { id: "u1", email: "sal@gmail.com", name: "Sal" },
    );
    if (!xss?.html || xss.html.includes("<script>")) fail("notificationToEmail: HTML not escaped — XSS risk");
    else pass("notificationToEmail: html escapes script tags");
}

{
    // User with no email
    const email = notificationToEmail(
        { id: "n3", kind: "application", title: "x", body: null, payload: "{}" },
        { id: "u1", email: null, name: "Sal" },
    );
    if (email !== null) fail("notificationToEmail: user with null email should yield null");
    else pass("notificationToEmail: null email → null result");
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
