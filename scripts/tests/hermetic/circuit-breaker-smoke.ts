/**
 * Hermetic smoke for the outbound-email circuit breaker
 * (lib/notifications/circuit-breaker.ts + the gate in lib/notifications/dispatch.ts).
 * Fix A of docs/postmortem-self-notification-mail-loop.html §11.
 *
 * Uses a THROWAWAY user so the global per-user counter is perfectly isolated
 * from any real notifications in dev.db. Never sends real email — EMAIL_ENABLED
 * is muted in the pre-push environment, and the breaker counts email-CHANNEL
 * rows (channels contains "email"), not successful sends, so the assertions hold
 * regardless of whether a send is attempted.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/circuit-breaker-smoke.ts
 *
 * Asserts (matches §13 P1.5):
 *   - 11th global send in-window is suppressed (global ≤ 10 / 60 s),
 *   - 2nd send for one application within 10 min is suppressed (per-app ≤ 1 / 10 min),
 *   - a DIFFERENT application is unaffected,
 *   - the in-app row ALWAYS lands (dispatch returns a row, channels keep in_app).
 */
import { PrismaClient } from "@prisma/client";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { GLOBAL_EMAIL_CAP } from "@/lib/notifications/circuit-breaker";

const prisma = new PrismaClient();
const TEST_EMAIL = "circuit-breaker-smoke@mission-control.test";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function hasEmail(channels: string): boolean {
    return channels.split(",").map(c => c.trim()).includes("email");
}

async function main() {
    // Clean any leftover from a prior failed run (cascade nukes its notifications).
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } }).catch(() => undefined);
    const user = await prisma.user.create({ data: { email: TEST_EMAIL, name: "Breaker Smoke" } });

    function dispatch(appId: string, label: string) {
        return dispatchNotification({
            userId: user.id,
            tier: "critical", // critical → default channels "in_app,email"
            kind: "application",
            title: `[breaker smoke] ${label}`,
            body: "test",
            payload: { applicationId: appId },
        });
    }

    try {
        // ── Per-feature layer: ≤ 1 email / 10 min per applicationId ──────────
        const a1 = await dispatch("SMOKE-A", "A#1");
        if (!a1) { fail("A#1: dispatch returned null"); }
        else {
            if (hasEmail(a1.channels)) pass("A#1: first email for app A allowed (channels keep email)");
            else fail(`A#1: email unexpectedly stripped (channels=${a1.channels})`);
            if (a1.scopeKey === "application:SMOKE-A") pass("A#1: scopeKey written as 'application:SMOKE-A'");
            else fail(`A#1: scopeKey=${a1.scopeKey}, expected 'application:SMOKE-A'`);
            if (!a1.emailError?.startsWith("circuit breaker")) pass("A#1: not breaker-suppressed");
            else fail(`A#1: unexpectedly breaker-suppressed (${a1.emailError})`);
        }

        const a2 = await dispatch("SMOKE-A", "A#2");
        if (!a2) { fail("A#2: dispatch returned null — in-app row didn't land"); }
        else {
            if (!hasEmail(a2.channels)) pass("A#2: 2nd email for app A within 10 min SUPPRESSED (email stripped)");
            else fail(`A#2: email NOT suppressed (channels=${a2.channels})`);
            if (a2.emailError?.startsWith("circuit breaker: application")) pass(`A#2: emailError records per-feature trip (${a2.emailError})`);
            else fail(`A#2: emailError=${a2.emailError}, expected 'circuit breaker: application …'`);
            pass("A#2: in-app row still landed (dispatch returned a row)");
        }

        // ── Different application is unaffected ──────────────────────────────
        const b = await dispatch("SMOKE-B", "B");
        if (b && hasEmail(b.channels)) pass("B: a DIFFERENT application is unaffected (email allowed)");
        else fail(`B: different app was suppressed (channels=${b?.channels})`);

        // ── Global layer: ≤ 10 emails / 60 s across the user ─────────────────
        // Email-channel rows so far: A#1 + B = 2 (A#2 was suppressed → email
        // stripped → not counted). Add 8 distinct apps to reach exactly 10.
        const fillerApps = ["C", "D", "E", "F", "G", "H", "I", "J"]; // 8 → total 10
        let allFillerAllowed = true;
        for (const suffix of fillerApps) {
            const row = await dispatch(`SMOKE-${suffix}`, suffix);
            if (!row || !hasEmail(row.channels)) { allFillerAllowed = false; fail(`${suffix}: filler unexpectedly suppressed (channels=${row?.channels})`); }
        }
        if (allFillerAllowed) pass(`global: ${fillerApps.length} distinct-app emails filled the window to ${GLOBAL_EMAIL_CAP}`);

        // The next distinct app is the 11th email-channel attempt → global trip.
        const k = await dispatch("SMOKE-K", "K(11th)");
        if (!k) { fail("K: dispatch returned null — in-app row didn't land"); }
        else {
            if (!hasEmail(k.channels)) pass("K: 11th global send in-window SUPPRESSED (email stripped)");
            else fail(`K: 11th send NOT suppressed (channels=${k.channels})`);
            if (k.emailError?.startsWith("circuit breaker: global")) pass(`K: emailError records GLOBAL trip (${k.emailError})`);
            else fail(`K: emailError=${k.emailError}, expected 'circuit breaker: global …'`);
            pass("K: in-app row still landed");
        }

        // ── Every dispatch produced an in-app row (none returned null) ───────
        const total = await prisma.notification.count({ where: { userId: user.id } });
        if (total === 12) pass(`in-app rows always land: 12 notifications created (incl. both suppressed)`);
        else fail(`expected 12 notification rows, found ${total}`);
    } finally {
        await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
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
