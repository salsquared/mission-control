// One-shot re-parse backfill for Application.location from email (2026-06-01).
//
// Companion to scripts/backfill-application-location.ts: that one fills location
// deterministically from the linked JobPosting. This one handles the remainder
// — Gmail-ingested apps with NO posting linkage — by re-fetching each app's
// source email and running it through the SAME LLM parser the live ingest uses
// (now extended to emit `location`). Only apps still missing a location AND
// carrying a `lastEmailMsgId` are candidates; a parse that yields no location
// (most "thanks for applying" emails don't state one) leaves the row null.
//
// Reuses lib/applications/ingest.ts's exported MIME helpers so the classifier
// input is byte-identical to live ingest. Does NOT re-run the full ingest
// pipeline (no event/notification/gcal side-effects re-fired) — it ONLY reads
// the email and, if a location comes back, writes that single field.
//
// Run (dry-run prints the plan; --write applies). Loads secrets from .env;
// DATABASE_URL picks the tier (CLI value wins over .env per dotenv semantics):
//   DATABASE_URL="file:./dev.db"  npx tsx scripts/backfill-application-location-from-email.ts
//   DATABASE_URL="file:./prod.db" npx tsx scripts/backfill-application-location-from-email.ts --write
//
// Cost: one Gemini flash-lite call per candidate (the schema change invalidated
// the cross-tier LLM cache for this callsite, so old entries miss). Sequential
// + rate-limited via acquireGeminiSlot inside parseApplicationEmail. Idempotent:
// a second run only re-checks rows that are still null.

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { google } from "googleapis";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { parseApplicationEmail } from "@/lib/email-parser";
import { headerValue, extractBody, messageDate } from "@/lib/applications/ingest";

const WRITE = process.argv.includes("--write");

async function main() {
    const candidates = await prisma.application.findMany({
        where: {
            OR: [{ location: null }, { location: "" }],
            NOT: { lastEmailMsgId: null },
        },
        select: { id: true, userId: true, company: true, role: true, lastEmailMsgId: true },
        orderBy: { lastUpdateAt: "desc" },
    });

    console.log(`${WRITE ? "[WRITE]" : "[DRY-RUN]"} re-parse ${candidates.length} Gmail-sourced app(s) missing location\n`);

    // One Gmail client per user (only one real user today, but keep it general).
    const byUser = new Map<string, typeof candidates>();
    for (const c of candidates) {
        const list = byUser.get(c.userId) ?? [];
        list.push(c);
        byUser.set(c.userId, list);
    }

    let set = 0;
    let noLocation = 0;
    let errored = 0;

    for (const [userId, apps] of byUser) {
        let gmail;
        try {
            const auth = await getGoogleAuthClient(userId);
            gmail = google.gmail({ version: "v1", auth });
        } catch (e: any) {
            console.error(`[skip-user] ${userId}: cannot build Gmail client (${e?.message ?? e}) — skipping ${apps.length} app(s)`);
            errored += apps.length;
            continue;
        }

        for (const a of apps) {
            const msgId = a.lastEmailMsgId!;
            try {
                const res = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
                const message = res.data;
                const subject = headerValue(message.payload?.headers, "Subject") ?? "";
                const from = headerValue(message.payload?.headers, "From") ?? "";
                const snippet = message.snippet ?? "";
                const body = extractBody(message.payload);
                const classifierInput = body || `${subject}\n\n${snippet}`;
                const sentAt = messageDate(message) ?? undefined;

                const parsed = await parseApplicationEmail(classifierInput, subject, from, sentAt);
                const loc = (parsed.location ?? "").trim();
                if (loc) {
                    console.log(`  ${a.id}  ${JSON.stringify(a.company)} / ${JSON.stringify(a.role)}  →  ${JSON.stringify(loc)}`);
                    if (WRITE) await prisma.application.update({ where: { id: a.id }, data: { location: loc } });
                    set++;
                } else {
                    noLocation++;
                }
            } catch (e: any) {
                console.warn(`  [err] ${a.id} msg=${msgId}: ${e?.message ?? e}`);
                errored++;
            }
        }
    }

    console.log(
        `\n${WRITE ? "Done" : "Dry-run"}. ${WRITE ? "set" : "would-set"}=${set} ` +
        `no-location-in-email=${noLocation} errored=${errored}`,
    );
    if (!WRITE) console.log("Re-run with --write to apply.");
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
