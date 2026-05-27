/**
 * Hermetic smoke for the cross-track dedup pass in lib/applications/ingest.ts
 * (2026-05-27).
 *
 * Background — the bug this guards against:
 *   Before this change, ingest hardcoded `ingestTrack = "career"` and passed
 *   it to both `findApplicationByCompany` and `findApplicationBySenderDomain`.
 *   A user who manually placed "Mattel, Inc." on the side track saw the next
 *   Mattel email spawn a *new* career row instead of updating the existing
 *   side row, because the side row was scoped out of the lookup.
 *
 * What we assert:
 *   A. Side-only preexisting row → ingest's dedup lookup finds it across
 *      tracks. (The fix.)
 *   B. Same company exists on BOTH tracks → tie-breaker prefers the row
 *      whose stored senderDomain matches the incoming email.
 *   C. Same company on both tracks but neither has senderDomain → the
 *      most-recently-updated row wins (the helper's orderBy contract).
 *   D. No row exists anywhere → ingest's create branch explicitly uses
 *      track="career". We assert by reading the literal at the source.
 *
 * The smoke replays the ingest decision tree against the repository helpers
 * directly — same pattern as sender-domain-smoke.ts. A full Gmail-API
 * integration belongs in an integration test, not a hermetic smoke.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/ingest-cross-track-dedup-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import { normalizeCompanyName } from "@/lib/applications/normalize-company";
import {
    createApplication,
    findApplicationByCompany,
    findApplicationBySenderDomain,
} from "@/lib/repositories/applications";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `cross-track-smoke-${tag}`;
    const createdIds: string[] = [];

    try {
        await prisma.user.create({
            data: { id: userId, email: `cross-track-smoke-${tag}@example.invalid` },
        });

        // ─── Case A: preexisting SIDE-track row is found by cross-track lookup ─
        //
        // The exact Mattel scenario. User manually tracked "Mattel, Inc." as a
        // side-track application (status=INTERESTED). An email then arrives
        // from mattel.com — ingest must find the side row, not spawn a new
        // career row.
        const matKey = normalizeCompanyName("Mattel, Inc.");
        const matSide = await createApplication({
            userId,
            company: "Mattel, Inc.",
            role: "Toy Designer (side)",
            status: "INTERESTED",
            kind: "job",
            track: "side",
        });
        createdIds.push(matSide.id);
        check(
            "case A: side-track row has normalizedCompany populated",
            matSide.normalizedCompany === matKey,
            `got ${JSON.stringify(matSide.normalizedCompany)}`,
        );

        // Pre-2026-05-27, this would have returned null because the helper was
        // scoped to "career". Post-fix, omitting the track arg returns the
        // side-track row.
        const looked = await findApplicationByCompany(userId, "Mattel");
        check(
            "case A: cross-track lookup finds the side-track row",
            looked?.id === matSide.id,
            `got ${JSON.stringify(looked?.id ?? null)} (track=${looked?.track ?? "n/a"})`,
        );

        // Sanity: scoping to "career" explicitly still returns null (no
        // career-side Mattel row exists). This guards against a regression
        // where someone re-introduces a default track arg.
        const lookedCareer = await findApplicationByCompany(userId, "Mattel", "career");
        check(
            "case A: explicit track=career lookup correctly returns null",
            lookedCareer === null,
        );

        // ─── Case B: both tracks have a row → senderDomain tie-breaker wins ───
        //
        // Pre-create one "Acme" row on each track. The side row has
        // senderDomain="acme.com" stamped (e.g. from a previous email). When
        // an email arrives from someone@acme.com, the tie-breaker must prefer
        // the side row even though the career row is more recently updated.
        const acmeSide = await createApplication({
            userId,
            company: "Acme",
            role: "Side gig",
            status: "INTERESTED",
            kind: "job",
            track: "side",
            senderDomain: "acme.com",
        });
        createdIds.push(acmeSide.id);
        // Make the career row newer so a naïve "most-recent wins" would lose.
        await new Promise((r) => setTimeout(r, 5));
        const acmeCareer = await createApplication({
            userId,
            company: "Acme",
            role: "Career gig",
            status: "APPLIED",
            kind: "job",
            track: "career",
            // No senderDomain — this is the row a prior LLM ingest created
            // without a domain hint (multi-tenant ATS, blocklisted root, etc).
        });
        createdIds.push(acmeCareer.id);

        // Reproduce the ingest decision tree:
        //   1. findApplicationByCompany (cross-track) — returns most-recent
        //      = acmeCareer.
        //   2. tie-breaker: if existing.senderDomain !== incoming, look for
        //      a same-company sibling by senderDomain. Found acmeSide, prefer.
        const incomingDomainB = "acme.com";
        let existingB = await findApplicationByCompany(userId, "Acme");
        check(
            "case B: company lookup returns most-recently-updated (career)",
            existingB?.id === acmeCareer.id,
            `got id=${existingB?.id ?? "null"} track=${existingB?.track ?? "n/a"}`,
        );
        if (existingB && incomingDomainB && existingB.senderDomain !== incomingDomainB) {
            const byDomain = await findApplicationBySenderDomain(userId, incomingDomainB);
            if (
                byDomain
                && byDomain.id !== existingB.id
                && normalizeCompanyName(byDomain.company) === normalizeCompanyName(existingB.company)
            ) {
                existingB = byDomain;
            }
        }
        check(
            "case B: tie-breaker switches to side row (domain match)",
            existingB?.id === acmeSide.id,
            `got id=${existingB?.id ?? "null"} track=${existingB?.track ?? "n/a"}`,
        );

        // ─── Case C: same company both tracks, neither domain-matches ───
        //
        // The career row is newest. Tie-breaker doesn't fire (no domain match
        // on the OTHER track). Result: most-recently-updated wins = career.
        const bizSide = await createApplication({
            userId,
            company: "Biz",
            role: "Side",
            status: "INTERESTED",
            kind: "job",
            track: "side",
            // No senderDomain stamped.
        });
        createdIds.push(bizSide.id);
        await new Promise((r) => setTimeout(r, 5));
        const bizCareer = await createApplication({
            userId,
            company: "Biz",
            role: "Career",
            status: "APPLIED",
            kind: "job",
            track: "career",
            // No senderDomain stamped.
        });
        createdIds.push(bizCareer.id);

        const incomingDomainC = "biz.com";
        let existingC = await findApplicationByCompany(userId, "Biz");
        check(
            "case C: company lookup returns most-recently-updated (career)",
            existingC?.id === bizCareer.id,
        );
        // Run the tie-breaker — should be a no-op because no other-track
        // sibling has matching senderDomain.
        if (existingC && incomingDomainC && existingC.senderDomain !== incomingDomainC) {
            const byDomain = await findApplicationBySenderDomain(userId, incomingDomainC);
            if (
                byDomain
                && byDomain.id !== existingC.id
                && normalizeCompanyName(byDomain.company) === normalizeCompanyName(existingC.company)
            ) {
                existingC = byDomain;
            }
        }
        check(
            "case C: no tie-breaker switch when no domain match anywhere",
            existingC?.id === bizCareer.id,
            `got id=${existingC?.id ?? "null"}`,
        );

        // ─── Case D: brand-new company → ingest creates with track="career" ───
        //
        // Two checks. First, the helper-level invariant: when no row exists,
        // cross-track lookup returns null. Second, the source-level invariant:
        // ingest's create call site uses a literal "career". This guards
        // against a future regression where someone reintroduces a fallback
        // chain like `parsed.track ?? "career"`.
        const nuked = await findApplicationByCompany(userId, "NeverHeardOfThem");
        check("case D: cross-track lookup of unknown company returns null", nuked === null);

        const ingestSrc = readFileSync(
            resolve(__dirname, "../../../lib/applications/ingest.ts"),
            "utf8",
        );
        // Look for the literal `track: "career",` inside the createApplication
        // call. We assert it's present AND we assert there's no `?? "career"`
        // fallback chain anywhere in the file.
        check(
            "case D: ingest source contains explicit `track: \"career\"` literal",
            /track:\s*"career"/.test(ingestSrc),
        );
        check(
            "case D: ingest source has no `?? \"career\"` fallback chain",
            !/\?\?\s*"career"/.test(ingestSrc),
        );

        // ─── Case E: ApplicationCreate.track is required ───
        //
        // Bottom-line guarantee: the TS layer makes every create site fail to
        // compile without an explicit track. We assert by inspecting the
        // ApplicationCreate interface block specifically (the file also has
        // ApplicationUpdate where `track?:` is legitimately optional).
        const repoSrc = readFileSync(
            resolve(__dirname, "../../../lib/repositories/applications.ts"),
            "utf8",
        );
        const createBlock = repoSrc.match(/interface ApplicationCreate \{[\s\S]*?\n\}/);
        check(
            "case E: ApplicationCreate interface block exists",
            createBlock !== null,
        );
        if (createBlock) {
            check(
                "case E: ApplicationCreate.track is required (no `?` modifier)",
                /\btrack:\s*string;/.test(createBlock[0])
                && !/\btrack\?:\s*string;/.test(createBlock[0]),
                createBlock[0].split("\n").filter(l => l.includes("track")).join(" | "),
            );
        }
    } finally {
        for (const id of createdIds) {
            await prisma.application.delete({ where: { id } }).catch(() => {});
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
