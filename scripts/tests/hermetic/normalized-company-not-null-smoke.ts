/**
 * Hermetic smoke for Fix B (2026-06-01) — Application.normalizedCompany is
 * NOT NULL (migration require_application_normalized_company).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx \
 *     scripts/tests/hermetic/normalized-company-not-null-smoke.ts
 *
 * The Rocket Lab duplicate's root cause was a row written with a NULL
 * normalizedCompany (a create path that bypassed normalizeCompanyName): the
 * indexed dedup lookup could never match it, so ingest + track-as-application
 * both spawned a second kanban card. Fix B makes that state unrepresentable so
 * the bypass fails loudly at the offending insert instead of silently
 * producing a dedup-defeating row. This asserts the guard actually bites:
 *
 *   1. prisma.create with normalizedCompany: null  → throws (client rejects)
 *   2. prisma.create omitting normalizedCompany     → throws (required field)
 *   3. prisma.create with a real normalizedCompany  → succeeds + persists it
 *   4. raw INSERT with a real normalizedCompany      → succeeds (column list ok)
 *   5. raw INSERT with NULL normalizedCompany        → throws (DB NOT NULL)
 *
 * Steps 4+5 are paired so the step-5 throw can only be the NULL (step 4 proves
 * the same INSERT shape is otherwise valid). No HTTP / no session.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { randomBytes } from "crypto";

const prisma = new PrismaClient();
let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function expectThrow(label: string, fn: () => Promise<unknown>): Promise<unknown> {
    try {
        const r = await fn();
        fail(`${label} — expected a throw but the write succeeded`);
        return r;
    } catch (e) {
        pass(`${label} — rejected (${(e as Error).constructor?.name ?? "error"})`);
        return null;
    }
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `nc-notnull-smoke-${tag}`;
    const createdIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `nc-notnull-smoke-${tag}@example.invalid` } });

        // 1. Explicit null via the Prisma client — `null as any` slips past the
        //    compile-time type; the runtime client must still reject it.
        await expectThrow("client create: normalizedCompany = null", () =>
            prisma.application.create({
                data: {
                    userId, company: "NullCo",
                    normalizedCompany: null as unknown as string,
                    role: "Eng", status: "APPLIED", kind: "job", track: "career",
                },
            }),
        );

        // 2. Omitting it entirely — required field, no schema default. Cast
        //    through `unknown` so the deliberately-incomplete literal compiles;
        //    the Prisma client must reject the missing field at runtime.
        const omitData = { userId, company: "OmitCo", role: "Eng", status: "APPLIED", kind: "job", track: "career" };
        await expectThrow("client create: normalizedCompany omitted", () =>
            prisma.application.create({ data: omitData as unknown as Prisma.ApplicationUncheckedCreateInput }),
        );

        // 3. Positive control — a real normalizedCompany persists.
        const ok = await prisma.application.create({
            data: {
                userId, company: "Real Co",
                normalizedCompany: "Real Co",
                role: "Eng", status: "APPLIED", kind: "job", track: "career",
            },
        });
        createdIds.push(ok.id);
        if (ok.normalizedCompany === "Real Co") pass("client create: valid normalizedCompany persists");
        else fail(`expected normalizedCompany="Real Co", got ${JSON.stringify(ok.normalizedCompany)}`);

        // 4. Raw INSERT positive control — proves the column list + epoch-ms
        //    DateTime binding is valid, so the step-5 failure can only be the NULL.
        const okRawId = `nc-raw-ok-${tag}`;
        const now = Date.now();
        await prisma.$executeRaw`
            INSERT INTO "Application"
                ("id","userId","company","normalizedCompany","status","track","lastUpdateAt","createdAt","updatedAt")
            VALUES (${okRawId}, ${userId}, 'Raw Ok', 'Raw Ok', 'APPLIED', 'career', ${now}, ${now}, ${now})
        `;
        createdIds.push(okRawId);
        const rawOk = await prisma.application.findUnique({ where: { id: okRawId } });
        if (rawOk) pass("raw insert: valid normalizedCompany row created");
        else fail("raw insert positive control did not create a row");

        // 5. Raw INSERT with NULL normalizedCompany — the DB column itself must
        //    reject it (independent of the Prisma client type layer).
        const nullRawId = `nc-raw-null-${tag}`;
        await expectThrow("raw insert: NULL normalizedCompany hits DB NOT NULL", () =>
            prisma.$executeRaw`
                INSERT INTO "Application"
                    ("id","userId","company","normalizedCompany","status","track","lastUpdateAt","createdAt","updatedAt")
                VALUES (${nullRawId}, ${userId}, 'Raw Null', ${null}, 'APPLIED', 'career', ${now}, ${now}, ${now})
            `,
        );
        // Defensive: ensure the rejected row really didn't land.
        const leaked = await prisma.application.findUnique({ where: { id: nullRawId } });
        if (leaked) { createdIds.push(nullRawId); fail("NULL row leaked into the table despite the throw"); }
        else pass("raw insert: NULL row absent after rejection");
    } finally {
        for (const id of createdIds) await prisma.application.delete({ where: { id } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
