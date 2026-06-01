// Hermetic smoke for lib/watchlists/keyword-query.ts:buildSearchQuery (pure).
// User stores a plain comma list; the fetchers expand it to the LinkedIn/Indeed
// boolean OR query at request time. This is the only place OR/quotes exist.
//   npx tsx scripts/tests/hermetic/keyword-query-smoke.ts

import { buildSearchQuery } from "@/lib/watchlists/keyword-query";

let passes = 0;
let fails = 0;
function ok(msg: string, got: string, want: string) {
    if (got === want) { console.log(`[PASS] ${msg}`); passes++; }
    else { console.error(`[FAIL] ${msg}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fails++; }
}

// Comma list → OR query; multi-word terms quoted, single-word bare.
ok("comma list → quoted OR", buildSearchQuery("AI trainer, data annotator, prompt"), '"AI trainer" OR "data annotator" OR prompt');
// Single multi-word term → quoted, no OR.
ok("single phrase quoted", buildSearchQuery("software engineer"), '"software engineer"');
// Single word → bare, no quotes.
ok("single word bare", buildSearchQuery("recruiter"), "recruiter");
// IDEMPOTENT on a legacy boolean string (the un-migrated case): same query out.
ok("legacy OR-query round-trips", buildSearchQuery('"AI trainer" OR "data annotator" OR prompt'), '"AI trainer" OR "data annotator" OR prompt');
// Mixed separators + dedupe inherited from splitCanonKeywords.
ok("semicolon/newline + dedupe", buildSearchQuery("react; React\nnode"), "react OR node");
// Empty / whitespace → empty query.
ok("empty → empty", buildSearchQuery(""), "");
ok("whitespace/sep-only → empty", buildSearchQuery("  ,  ; \n "), "");

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
