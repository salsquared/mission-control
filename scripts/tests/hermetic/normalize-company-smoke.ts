/**
 * PB-1 hermetic smoke. Verifies the normalization pipeline:
 *   1. Idempotency.
 *   2. Suffix stripping (Inc / Corp / LLC / Co / multi-word variants).
 *   3. Leading "The " stripping.
 *   4. Unicode NFKC + whitespace collapse.
 *   5. Empty / pathological inputs.
 *   6. The Bell Smoke Co incident specifically — `Bell Smoke` and `Bell Smoke Co`
 *      must normalize to the same string.
 */
import { normalizeCompanyName } from "@/lib/applications/normalize-company";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function eq(name: string, got: string, expected: string) {
    check(name, got === expected, `got "${got}", expected "${expected}"`);
}

// ─── Idempotency ────────────────────────────────────────────────────────────
const samples = ["Anthropic", "Acme, Inc.", "  The Boring Company  ", "ﬁnance corp"];
for (const raw of samples) {
    const once = normalizeCompanyName(raw);
    const twice = normalizeCompanyName(once);
    check(`idempotent: ${JSON.stringify(raw)}`, once === twice, `once="${once}" twice="${twice}"`);
}

// ─── Suffix stripping ───────────────────────────────────────────────────────
eq("Anthropic stays Anthropic",            normalizeCompanyName("Anthropic"),            "Anthropic");
eq("Anthropic, Inc. → Anthropic",           normalizeCompanyName("Anthropic, Inc."),       "Anthropic");
eq("Anthropic Inc → Anthropic",             normalizeCompanyName("Anthropic Inc"),         "Anthropic");
eq("Acme Corp → Acme",                      normalizeCompanyName("Acme Corp"),             "Acme");
eq("Acme Corporation → Acme",               normalizeCompanyName("Acme Corporation"),      "Acme");
eq("Foo LLC → Foo",                         normalizeCompanyName("Foo LLC"),               "Foo");
eq("Foo, LLP → Foo",                        normalizeCompanyName("Foo, LLP"),              "Foo");
eq("Bell Smoke Co → Bell Smoke",            normalizeCompanyName("Bell Smoke Co"),         "Bell Smoke");
eq("Bell Smoke → Bell Smoke",               normalizeCompanyName("Bell Smoke"),            "Bell Smoke");
eq("Stripe → Stripe",                       normalizeCompanyName("Stripe"),                "Stripe");

// ─── Multi-suffix chains ────────────────────────────────────────────────────
eq("Boring Co., Ltd. → Boring",             normalizeCompanyName("Boring Co., Ltd."),      "Boring");
eq("X Limited Liability Company → X",       normalizeCompanyName("X Limited Liability Company"), "X");

// ─── Leading "The " ─────────────────────────────────────────────────────────
eq("The Boring Company → Boring",           normalizeCompanyName("The Boring Company"),    "Boring");
eq("The Anthropic Foundation → Anthropic Foundation", normalizeCompanyName("The Anthropic Foundation"), "Anthropic Foundation");
eq("The (alone) → The",                     normalizeCompanyName("The"),                   "The"); // bare token

// ─── Unicode + whitespace ───────────────────────────────────────────────────
eq("NFKC: ﬁnance corp → finance",           normalizeCompanyName("ﬁnance corp"),           "finance");
eq("collapse: Acme   Inc → Acme",           normalizeCompanyName("Acme   Inc"),            "Acme");
eq("trim: '  Acme Inc.  ' → Acme",          normalizeCompanyName("  Acme Inc.  "),         "Acme");
eq("full-width: ＡＣＭＥ → ACME",            normalizeCompanyName("ＡＣＭＥ"),                "ACME");

// ─── Edge cases ─────────────────────────────────────────────────────────────
eq("empty → empty",                         normalizeCompanyName(""),                       "");
eq("whitespace only → empty",               normalizeCompanyName("   "),                    "");
// Bare-suffix degenerate inputs — should never appear in real LLM output.
// The pattern requires a separator before the suffix token, so "Inc" alone
// stays. Trailing punctuation is stripped unconditionally (idempotent).
eq("just 'Inc' (bare token) → Inc",         normalizeCompanyName("Inc"),                    "Inc");
eq("'Inc.' (with period) → Inc",            normalizeCompanyName("Inc."),                   "Inc");

// ─── The Bell Smoke Co incident ─────────────────────────────────────────────
const a = normalizeCompanyName("Bell Smoke");
const b = normalizeCompanyName("Bell Smoke Co");
const c = normalizeCompanyName("Bell Smoke Company");
const d = normalizeCompanyName("Bell Smoke, Inc.");
check(
    "Bell Smoke incident: all four variants converge",
    a === b && b === c && c === d,
    `got [${a}, ${b}, ${c}, ${d}]`,
);

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
console.log("All checks passed.");
