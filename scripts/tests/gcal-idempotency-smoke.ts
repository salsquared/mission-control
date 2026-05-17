/**
 * PA-1 hermetic smoke. Verifies the Google-compatible idempotency id mapping:
 *   - Same input → same output (deterministic).
 *   - Output is within Google's base32hex alphabet (0-9a-v) + length 5-1024.
 *   - Different inputs → different outputs.
 *
 * Doesn't exercise the actual Gcal insert path — that needs a real OAuth
 * session and is verified next time the user files a real interview.
 */
import { gcalIdempotencyId } from "@/lib/calendar/sync";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const sampleEventIds = [
    "cmp98bnft0002t0qo8126b95u",
    "cmp9bxz4y0007t9opabcdef00",
    "event-with-different-shape-12345",
];

// Determinism.
for (const id of sampleEventIds) {
    check(`deterministic for ${id.slice(0, 12)}…`, gcalIdempotencyId(id) === gcalIdempotencyId(id));
}

// Different inputs → different outputs.
const ids = sampleEventIds.map(gcalIdempotencyId);
check("different inputs produce different idempotency ids", new Set(ids).size === ids.length);

// Google's allowed alphabet: 0-9 + a-v lowercase. sha1 hex = 0-9 + a-f → strict subset.
const allowed = /^[0-9a-v]+$/;
for (const id of ids) {
    check(`output is base32hex-compatible: ${id.slice(0, 12)}…`, allowed.test(id), `got "${id}"`);
}

// Length: 5-1024 chars per Google's docs. sha1 hex = 40, well within.
for (const id of ids) {
    check(`output length 5-1024: ${id.length}`, id.length >= 5 && id.length <= 1024);
}

// Specific known hash for regression detection.
const known = gcalIdempotencyId("test-event-id");
check(
    "regression: gcalIdempotencyId('test-event-id') is stable across releases",
    known === "d11ac98d0d0dd18d82b5de285a55464c94f0d4ee",
    `got "${known}"`,
);

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
console.log("All checks passed.");
