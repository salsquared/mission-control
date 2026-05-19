/**
 * Gmail-inbox diagnostic. Hits the real Gmail API as the prod user and
 * reports per-message what would happen in the backfill pipeline:
 *
 *   1. Pull last N days of Gmail (default 7) — no relevance filter, raw inbox.
 *   2. For each: show subject, from, snippet, AND whether looksRelevant() passes.
 *   3. For relevance-passes (or --classify-all): hit the Gemini classifier and
 *      show isApplicationRelated / confidence / company / status.
 *   4. Summary table at the end.
 *
 * Usage:
 *   DATABASE_URL="file:./prisma/prod.db" \
 *   npx tsx scripts/tests/debug/gmail-inbox-debug.ts \
 *     [--days 7] \
 *     [--max 50] \
 *     [--classify-all]    # run Gemini even on relevance-failing messages
 *     [--query "..."]     # custom Gmail q string (overrides the built-in keyword query)
 *     [--raw]             # skip both filters; show every message
 *
 * Reads the user from prod.db (assumes a single User row). No mutation —
 * does NOT create any Application / Notification rows.
 */
import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { looksRelevant, buildGmailQuery } from "@/lib/applications/relevance";
import { parseApplicationEmail } from "@/lib/email-parser";

const prisma = new PrismaClient();

interface Args {
    days: number;
    max: number;
    classifyAll: boolean;
    raw: boolean;
    query?: string;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    const out: Args = { days: 7, max: 50, classifyAll: false, raw: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--days") out.days = parseInt(argv[++i], 10);
        else if (a === "--max") out.max = parseInt(argv[++i], 10);
        else if (a === "--classify-all") out.classifyAll = true;
        else if (a === "--raw") out.raw = true;
        else if (a === "--query") out.query = argv[++i];
    }
    return out;
}

function headerValue(headers: any[] | undefined, name: string): string {
    if (!headers) return "";
    const lower = name.toLowerCase();
    const h = headers.find((x: any) => (x.name ?? "").toLowerCase() === lower);
    return h?.value ?? "";
}

function fmtDate(internalDate: string | null | undefined): string {
    if (!internalDate) return "?";
    return new Date(Number(internalDate)).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
    const args = parseArgs();

    // 1. Resolve user.
    const users = await prisma.user.findMany({ select: { id: true, email: true } });
    if (users.length === 0) {
        console.error("[ERR] No User rows in DB. Are you pointed at prod.db?");
        process.exit(1);
    }
    if (users.length > 1) {
        console.warn(`[WARN] Multiple users found (${users.length}); using first: ${users[0].email}`);
    }
    const user = users[0];
    console.log(`User: ${user.email} (${user.id})`);

    // 2. Build query + list.
    const query = args.raw
        ? `newer_than:${args.days}d`
        : (args.query ?? buildGmailQuery(args.days));
    console.log(`\nGmail query (${args.raw ? "RAW" : "filtered"}):`);
    console.log(`  ${query}\n`);

    let authClient;
    try {
        authClient = await getGoogleAuthClient(user.id);
    } catch (e: any) {
        console.error(`[ERR] Could not build OAuth client for ${user.email}: ${e.message}`);
        console.error("  → User likely hasn't completed Google OAuth, or the refresh_token is missing on the Account row.");
        process.exit(1);
    }
    const gmail = google.gmail({ version: "v1", auth: authClient });

    let listRes;
    try {
        listRes = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: args.max,
        });
    } catch (e: any) {
        console.error(`[ERR] gmail.users.messages.list failed: ${e.message}`);
        process.exit(1);
    }

    const ids = (listRes.data.messages ?? []).map(m => m.id).filter((s): s is string => !!s);
    console.log(`Found ${ids.length} message id(s)${ids.length === args.max ? " (capped at --max)" : ""}\n`);

    if (ids.length === 0) {
        console.log("No matches. Try --raw or --days 30 to widen the scope.");
        await prisma.$disconnect();
        return;
    }

    // 3. Walk each, report.
    let relevant = 0;
    let irrelevant = 0;
    let classifiedApp = 0;
    let classifiedNotApp = 0;
    let classifierErrors = 0;

    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        let msg;
        try {
            const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
            msg = r.data;
        } catch (e: any) {
            console.log(`  [${i + 1}/${ids.length}] ${id}: gmail.get failed — ${e.message}`);
            continue;
        }
        const subject = headerValue(msg.payload?.headers ?? undefined, "Subject");
        const from = headerValue(msg.payload?.headers ?? undefined, "From");
        const snippet = msg.snippet ?? "";
        const when = fmtDate(msg.internalDate);

        const rel = looksRelevant({ subject, from, snippet });
        const relTag = rel ? "✓ RELEVANT  " : "✗ filtered  ";
        if (rel) relevant++; else irrelevant++;

        console.log(`[${String(i + 1).padStart(2)}/${ids.length}] ${when}  ${relTag}`);
        console.log(`     from: ${from.slice(0, 80)}`);
        console.log(`     subj: ${subject.slice(0, 100)}`);
        console.log(`     snip: ${snippet.slice(0, 120)}`);

        if (rel || args.classifyAll) {
            // Reconstruct the same classifier input the ingest pipeline uses.
            // We don't have an easy `extractBody` outside ingest; passing
            // subject+snippet is sufficient for "would the classifier accept this".
            const classifierInput = `${subject}\n\n${snippet}`;
            try {
                const parsed = await parseApplicationEmail(
                    classifierInput,
                    subject,
                    from,
                    msg.internalDate ? new Date(Number(msg.internalDate)) : undefined,
                );
                if (parsed.isApplicationRelated) classifiedApp++;
                else classifiedNotApp++;
                const verdict = parsed.isApplicationRelated ? "✓ APP" : "✗ not-app";
                console.log(`     LLM: ${verdict} · conf=${parsed.confidence} · kind=${parsed.kind} · status=${parsed.status} · company="${parsed.company}"${parsed.role ? ` · role="${parsed.role}"` : ""}`);
            } catch (e: any) {
                classifierErrors++;
                console.log(`     LLM: [ERR] ${e.message?.slice(0, 200)}`);
            }
        }
        console.log("");
    }

    console.log("─".repeat(64));
    console.log("Summary:");
    console.log(`  scanned:        ${ids.length}`);
    console.log(`  relevance pass: ${relevant}`);
    console.log(`  relevance fail: ${irrelevant}`);
    if (relevant > 0 || args.classifyAll) {
        console.log(`  LLM said APP:   ${classifiedApp}`);
        console.log(`  LLM said NOT:   ${classifiedNotApp}`);
        if (classifierErrors > 0) console.log(`  LLM errors:     ${classifierErrors}`);
    }
    console.log("");
    console.log("Interpretation:");
    if (ids.length === 0) {
        console.log("  → Inbox-empty (within query). Widen --days or use --raw.");
    } else if (relevant === 0) {
        console.log("  → All messages failed the relevance keyword filter.");
        console.log("    Either (a) the test emails don't contain any of the configured phrases /");
        console.log("    sender domains, or (b) the messages aren't application-related at all.");
        console.log("    Re-run with --classify-all to see what the LLM thinks.");
    } else if (classifiedApp === 0 && (relevant > 0 || args.classifyAll)) {
        console.log("  → Relevance passed but classifier said NOT application-related.");
        console.log("    Likely cause: the test-email body looks too generic / marketing-shaped.");
    } else {
        console.log("  → Pipeline should be ingesting these. If they're not in the kanban:");
        console.log("    1. Click 'Scan inbox' in the Applications dash UI.");
        console.log("    2. Or POST /api/applications/backfill from a logged-in browser tab.");
        console.log("    There is NO real-time push wired up — gmail.users.watch() is never called");
        console.log("    in this codebase. Real-time arrival → kanban requires backfill.");
    }

    await prisma.$disconnect();
}

main().catch(e => {
    console.error("Unhandled:", e);
    process.exit(2);
});
