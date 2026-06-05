/**
 * Hermetic smoke for the layered-dedup sender-domain fallback (CSULB drift,
 * 2026-05-20). Two halves:
 *
 *   1. Unit tests on extractSenderDomain — display-name parsing, bare
 *      addresses, subdomain rollup, ATS / Common-App blocklist, malformed
 *      inputs.
 *   2. Integration: replay the exact CSULB scenario via the repository
 *      helpers (skipping the LLM — that's tested by its own probe). Three
 *      emails from `*.csulb.edu` with three different LLM-classifier
 *      outputs ("California State University Long Beach" / "Cal State Long
 *      Beach" / "CSULB") MUST converge on a single Application row.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/sender-domain-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { extractSenderDomain } from "@/lib/applications/sender-domain";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";
import {
    createApplication,
    findApplicationByCompany,
    findApplicationBySenderDomain,
    updateApplication,
} from "@/lib/repositories/applications";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function eq(name: string, got: string | null, expected: string | null) {
    check(name, got === expected, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}

async function main() {
    // ─── Unit: extractSenderDomain ──────────────────────────────────────────
    // Display name + angle brackets
    eq(`display "CSULB Admissions" <admissions@apply.csulb.edu>`,
        extractSenderDomain(`"CSULB Admissions" <admissions@apply.csulb.edu>`),
        "csulb.edu");
    // Bare address
    eq(`bare admissions@csulb.edu`,
        extractSenderDomain("admissions@csulb.edu"),
        "csulb.edu");
    // Unquoted display name
    eq(`unquoted CSULB Admissions <decisions@csulb.edu>`,
        extractSenderDomain("CSULB Admissions <decisions@csulb.edu>"),
        "csulb.edu");
    // Deeper subdomain — still rolls up to registrable
    eq(`deep subdomain foo@a.b.c.csulb.edu`,
        extractSenderDomain("foo@a.b.c.csulb.edu"),
        "csulb.edu");
    // .io / .com varieties
    eq(`hello@anthropic.com`,
        extractSenderDomain("hello@anthropic.com"),
        "anthropic.com");
    eq(`notify@boards.anthropic.com → anthropic.com`,
        extractSenderDomain("notify@boards.anthropic.com"),
        "anthropic.com");

    // Multi-tenant ATS blocklist — MUST return null
    eq(`greenhouse blocked notify@boards.greenhouse.io`,
        extractSenderDomain("notify@boards.greenhouse.io"),
        null);
    eq(`lever blocked hire@hire.lever.co`,
        extractSenderDomain("hire@hire.lever.co"),
        null);
    eq(`workday blocked notify@myworkday.com`,
        extractSenderDomain("notify@myworkday.com"),
        null);
    eq(`commonapp blocked notify@commonapp.org`,
        extractSenderDomain("notify@commonapp.org"),
        null);
    // The sub-domain catch-all clause — host = sub.greenhouse.io
    eq(`greenhouse sub.notify@us.greenhouse.io blocked`,
        extractSenderDomain("notify@us.greenhouse.io"),
        null);
    // Greenhouse's actual NOTIFICATION-MAIL domain (2026-06-04 Astranis→Muon
    // Space mis-merge regression). Greenhouse sends from greenhouse-mail.io,
    // NOT greenhouse.io — every employer using Greenhouse shares this root, so
    // it MUST be blocked or unrelated employers funnel onto one card.
    eq(`greenhouse-mail root no-reply@greenhouse-mail.io blocked`,
        extractSenderDomain("no-reply@greenhouse-mail.io"),
        null);
    eq(`greenhouse-mail us.* subdomain no-reply@us.greenhouse-mail.io blocked`,
        extractSenderDomain("no-reply@us.greenhouse-mail.io"),
        null);

    // Consumer free-mail blocklist (2026-06-02 self-notification loop) — MUST
    // return null so the dedup fallback never funnels unrelated senders (or the
    // user's own notification mail, From their gmail.com) onto one app.
    eq(`gmail blocked sal@gmail.com`,        extractSenderDomain("sal@gmail.com"),                  null);
    eq(`gmail blocked w/ display name`,      extractSenderDomain('"Sal" <sal@gmail.com>'),          null);
    eq(`googlemail blocked`,                 extractSenderDomain("x@googlemail.com"),               null);
    eq(`outlook blocked`,                    extractSenderDomain("x@outlook.com"),                  null);
    eq(`yahoo blocked`,                      extractSenderDomain("x@yahoo.com"),                    null);
    eq(`icloud blocked`,                     extractSenderDomain("x@icloud.com"),                   null);
    eq(`proton blocked`,                     extractSenderDomain("x@proton.me"),                    null);
    // A real employer domain that merely HOSTS on a custom root still resolves —
    // the block is scoped to the literal free-mail roots, not all mail.
    eq(`employer domain still resolves`,     extractSenderDomain("careers@stripe.com"),             "stripe.com");

    // Malformed / empty inputs → null
    eq(`empty string`,                extractSenderDomain(""),               null);
    eq(`null`,                        extractSenderDomain(null),             null);
    eq(`undefined`,                   extractSenderDomain(undefined),        null);
    eq(`no @ sign`,                   extractSenderDomain("just a name"),    null);
    eq(`no TLD`,                      extractSenderDomain("foo@localhost"),  null);
    eq(`single-label host`,           extractSenderDomain("foo@bar"),        null);
    // Case normalization
    eq(`uppercase host folded`,
        extractSenderDomain("Admissions@APPLY.CSULB.EDU"),
        "csulb.edu");

    // ─── Integration: 3-CSULB-emails-→-1-Application ────────────────────────
    const tag = randomBytes(4).toString("hex");
    const userId = `senderDomain-smoke-${tag}`;
    const createdIds: string[] = [];

    try {
        await prisma.user.create({
            data: { id: userId, email: `senderDomain-smoke-${tag}@example.invalid` },
        });

        const csulbDomain = "csulb.edu";

        // Email #1: LLM returns "California State University Long Beach".
        // No existing app — create.
        const llmName1 = normalizeCompanyName("California State University Long Beach");
        const existing1 = await findApplicationByCompany(userId, llmName1, "career");
        check("first email: no existing app by company", existing1 === null);
        const existingByDomain1 = await findApplicationBySenderDomain(userId, csulbDomain, "career");
        check("first email: no existing app by domain", existingByDomain1 === null);
        const app1 = await createApplication({
            userId,
            company: llmName1,
            role: "Computer Science BS",
            status: "APPLIED",
            kind: "college",
            track: "career",
            senderDomain: csulbDomain,
        });
        createdIds.push(app1.id);
        check("first email: app created with senderDomain stamped",
            app1.senderDomain === csulbDomain,
            `senderDomain="${app1.senderDomain}"`);

        // Email #2: LLM drifts to "Cal State Long Beach". normalizedCompany
        // for this is "Cal State Long Beach" — different from app1's. By
        // company-name lookup we'd MISS the existing row. The sender-domain
        // fallback should catch it.
        const llmName2 = normalizeCompanyName("Cal State Long Beach");
        check("LLM-drift case: normalized names differ between #1 and #2",
            llmName1 !== llmName2,
            `#1="${llmName1}" #2="${llmName2}"`);
        const byCompany2 = await findApplicationByCompany(userId, llmName2, "career");
        check("second email: company-name lookup misses (the bug)",
            byCompany2 === null);
        const byDomain2 = await findApplicationBySenderDomain(userId, csulbDomain, "career");
        check("second email: sender-domain fallback hits",
            byDomain2?.id === app1.id,
            `got ${byDomain2?.id ?? "null"}`);
        // Simulate the ingest update path (preserve company, refresh status).
        await updateApplication(byDomain2!.id, {
            status: "ASSESSMENT",
            senderDomain: csulbDomain,
        });

        // Email #3: LLM drifts again to "CSULB".
        const llmName3 = normalizeCompanyName("CSULB");
        check("LLM-drift case: #3 distinct from #1 and #2",
            llmName3 !== llmName1 && llmName3 !== llmName2);
        const byCompany3 = await findApplicationByCompany(userId, llmName3, "career");
        check("third email: company-name lookup misses", byCompany3 === null);
        const byDomain3 = await findApplicationBySenderDomain(userId, csulbDomain, "career");
        check("third email: sender-domain fallback hits same row",
            byDomain3?.id === app1.id);
        await updateApplication(byDomain3!.id, {
            status: "INTERVIEW_REQUESTED",
            senderDomain: csulbDomain,
        });

        // Convergence assertion — the whole point of this fix.
        const allRows = await prisma.application.findMany({ where: { userId } });
        check("CSULB scenario: exactly one Application row after 3 emails",
            allRows.length === 1,
            `got ${allRows.length}: ${allRows.map(r => r.company).join(" | ")}`);
        const final = allRows[0];
        check("CSULB scenario: stored company unchanged (no LLM-drift flip-flop)",
            final.company === llmName1,
            `company="${final.company}", expected "${llmName1}"`);
        check("CSULB scenario: latest status persisted",
            final.status === "INTERVIEW_REQUESTED",
            `status="${final.status}"`);
        check("CSULB scenario: senderDomain still stamped",
            final.senderDomain === csulbDomain);

        // Cross-school isolation — different domain must NOT collide.
        const otherApp = await createApplication({
            userId,
            company: normalizeCompanyName("Stanford University"),
            role: "Computer Science MS",
            status: "APPLIED",
            kind: "college",
            track: "career",
            senderDomain: "stanford.edu",
        });
        createdIds.push(otherApp.id);
        const byOtherDomain = await findApplicationBySenderDomain(userId, "stanford.edu", "career");
        check("cross-school: stanford.edu returns Stanford row, not CSULB",
            byOtherDomain?.id === otherApp.id);

        // ATS-blocklisted domain: extractSenderDomain returned null upstream,
        // so we'd never call findApplicationBySenderDomain with it — but be
        // defensive: if some caller did, it should still find any row that
        // happens to be tagged with the literal value (since we trust the
        // ingest-side blocklist gate). Verifying it doesn't crash is enough.
        const sanity = await findApplicationBySenderDomain(userId, "greenhouse.io", "career");
        check("ATS root query: returns null cleanly (no rows tagged that way)",
            sanity === null);
    } finally {
        for (const id of createdIds) {
            await prisma.application.delete({ where: { id } }).catch(() => {});
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.$disconnect();
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
