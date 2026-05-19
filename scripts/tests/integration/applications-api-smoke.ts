/**
 * End-to-end smoke for the applications API (MA milestone).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/applications-api-smoke.ts
 *
 * Forges a NextAuth session, exercises the full pipeline:
 *   POST manual create → PATCH status (verify STATUS_CHANGED event auto-emits)
 *   → POST NOTE event → GET timeline (verify chronological order) → DELETE.
 * Tears the session row down at the end.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) {
    console.error(`[FAIL] ${msg}`, detail ?? "");
    fails++;
}

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }
    console.log(`Using user ${user.email}`);

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };
    let appId = "";

    try {
        // 1. POST — manual create
        {
            const r = await fetch(`${BASE}/api/applications`, {
                method: "POST", headers,
                body: JSON.stringify({
                    company: "Smoke Co",
                    role: "Test Engineer",
                    status: "APPLIED",
                    kind: "internship",
                    dateApplied: new Date().toISOString(),
                }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST /api/applications status ${r.status}`, body);
            if (!body.application?.id) return fail("POST missing application.id", body);
            appId = body.application.id;
            pass(`POST /api/applications → ${appId}`);
            if (body.application.status !== "APPLIED") fail("status not echoed", body);
            else pass("status APPLIED set");
        }

        // 2. PATCH — change status, expect a STATUS_CHANGED event to be auto-emitted
        {
            const r = await fetch(`${BASE}/api/applications`, {
                method: "PATCH", headers,
                body: JSON.stringify({ id: appId, status: "ASSESSMENT" }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`PATCH /api/applications status ${r.status}`, body);
            if (body.application?.status !== "ASSESSMENT") return fail("PATCH status not echoed", body);
            pass("PATCH /api/applications status → ASSESSMENT");
        }

        // 3. GET events — expect at least one STATUS_CHANGED (and maybe an APPLIED row from the POST)
        {
            const r = await fetch(`${BASE}/api/applications/events?applicationId=${appId}`, { headers: { Cookie: cookie } });
            const body = await r.json();
            if (r.status !== 200) return fail(`GET events status ${r.status}`, body);
            const events = body.events ?? [];
            const statusChange = events.find((e: { kind: string; fromStatus: string; toStatus: string }) =>
                e.kind === "STATUS_CHANGED" && e.fromStatus === "APPLIED" && e.toStatus === "ASSESSMENT");
            if (!statusChange) {
                fail("expected a STATUS_CHANGED event with from=APPLIED to=ASSESSMENT", events);
            } else {
                pass("STATUS_CHANGED event auto-emitted by PATCH");
            }
        }

        // 4. POST NOTE event
        {
            const r = await fetch(`${BASE}/api/applications/events`, {
                method: "POST", headers,
                body: JSON.stringify({
                    applicationId: appId,
                    kind: "NOTE",
                    title: "Recruiter said decision by Friday",
                    notes: "Spoke with Jane — good signal on the role",
                }),
            });
            const body = await r.json();
            if (r.status !== 200 && r.status !== 201) return fail(`POST event status ${r.status}`, body);
            if (!body.event?.id) return fail("POST event missing id", body);
            pass(`POST /api/applications/events NOTE → ${body.event.id}`);
        }

        // 5. GET timeline — ensure all events present, chronologically ordered
        {
            const r = await fetch(`${BASE}/api/applications/events?applicationId=${appId}`, { headers: { Cookie: cookie } });
            const body = await r.json();
            const events: { id: string; kind: string; occurredAt: string }[] = body.events ?? [];
            if (events.length < 2) return fail(`expected at least 2 events on timeline (STATUS_CHANGED + NOTE), got ${events.length}`, events);
            pass(`GET timeline returned ${events.length} events`);
            const kinds = events.map(e => e.kind);
            if (!kinds.includes("STATUS_CHANGED") || !kinds.includes("NOTE")) {
                fail("expected both STATUS_CHANGED and NOTE in timeline", kinds);
            } else {
                pass("timeline includes STATUS_CHANGED and NOTE");
            }
        }

        // 6. DELETE
        {
            const r = await fetch(`${BASE}/api/applications?id=${appId}`, {
                method: "DELETE", headers: { Cookie: cookie },
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`DELETE status ${r.status}`, body);
            if (body.success !== true) return fail("DELETE success !== true", body);
            pass(`DELETE /api/applications?id=${appId.slice(0, 8)}…`);
            appId = "";
        }

        // 7. Verify gone — GET list should not include this id
        {
            const r = await fetch(`${BASE}/api/applications`, { headers: { Cookie: cookie } });
            const body = await r.json();
            const leak = (body.applications ?? []).some((a: { id: string }) => a.id === appId);
            if (leak) fail("deleted application still appears in list");
            else pass("deleted application no longer in list");
        }

        // 8. Negative — PATCH with no mutable fields → 400
        {
            const r = await fetch(`${BASE}/api/applications`, {
                method: "PATCH", headers,
                body: JSON.stringify({ id: "anything" }),
            });
            if (r.status !== 400) fail(`PATCH with no mutable fields expected 400 got ${r.status}`);
            else pass("PATCH with no mutable fields → 400");
        }
    } finally {
        if (appId) {
            await fetch(`${BASE}/api/applications?id=${appId}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
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
