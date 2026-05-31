// Hermetic smoke for lib/canons/keywords.ts:splitCanonKeywords (pure, no DB).
// A canon's keyword text → flat term array for the resume pipeline (§6 Q3/Q6).
//   npx tsx scripts/tests/hermetic/canon-keyword-split-smoke.ts

import { splitCanonKeywords } from "@/lib/canons/keywords";

let passes = 0;
let fails = 0;
function ok(msg: string, cond: boolean) {
    if (cond) { console.log(`[PASS] ${msg}`); passes++; }
    else { console.error(`[FAIL] ${msg}`); fails++; }
}
function eq(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Boolean OR (uppercase) splits; quotes/parens stripped.
ok(
    'OR-query splits + strips quotes',
    eq(splitCanonKeywords('"math tutor" OR "SAT prep" OR test prep'), ["math tutor", "SAT prep", "test prep"]),
);
// Comma / semicolon / newline list separators.
ok("comma + newline list", eq(splitCanonKeywords("react, typescript\nnext.js; node"), ["react", "typescript", "next.js", "node"]));
// Case-insensitive dedupe (keeps first casing).
ok("dedupes case-insensitively", eq(splitCanonKeywords("Python OR python OR PYTHON"), ["Python"]));
// Lowercase "or" inside a phrase is NOT a split point.
ok("lowercase 'or' in a phrase is preserved", eq(splitCanonKeywords("search or rescue"), ["search or rescue"]));
// Empty / whitespace → [].
ok("empty string → []", eq(splitCanonKeywords(""), []));
ok("whitespace-only → []", eq(splitCanonKeywords("   ,  ; \n "), []));
// Single term passes through trimmed.
ok("single term trimmed", eq(splitCanonKeywords("  Security Officer  "), ["Security Officer"]));

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
