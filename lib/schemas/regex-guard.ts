// ─── Regex-source safety (ReDoS bound) ─────────────────────────────────────
//
// This project accepts REGEX SOURCES from users in three places, all of them
// crew-reachable, and compiles every one with `new RegExp(...)`:
//
//   * `careers-page.linkPattern`  (lib/schemas/watchlists.ts)
//       compiled in lib/fetchers/careers-page-fetcher.ts and `.test()`ed once
//       per <a href> on the fetched page.
//   * `Watchlist.negativeFilters` (lib/schemas/watchlists.ts, up to 20)
//   * `GlobalSetting.globalNegativeFilters` (lib/schemas/settings.ts, up to 40)
//       both compiled in lib/postings/negative-filters.ts and `.test()`ed once
//       per posting row.
//
// A LENGTH cap bounds none of that: `(a+)+$` is six characters and backtracks
// exponentially in the length of the SUBJECT, so a 200-char budget is
// enormously more than enough to hang a match.
//
// WHY THAT IS SERIOUS. V8 regex matching is synchronous and NOT interruptible —
// no timeout, no abort signal, no way to unwind it once started. All three
// surfaces above are reached from BOTH tiers:
//
//   * the SCHEDULER (`scheduler/jobs/job-watcher.ts` on every automatic crawl,
//     `scheduler/jobs/posting-digest.ts` daily), where a wedged match pins the
//     single Node process and stalls every other job on that tier —
//     gmail-watch-renew, the prune jobs, notifications;
//   * the WEB tier — and the negative-filter path is the worse of the two,
//     because `app/api/postings/route.ts` compiles AND matches INSIDE the
//     request path, in a `.filter()` over every posting row. Measured
//     2026-08-02: 20,504 rows in prod, so one pattern is evaluated ~20k times
//     per ApplicationsView load, for every user including the owner.
//
// THE ROW MULTIPLIER IS THE REAL AMPLIFIER, not subject length. Measured on
// both DBs, the negative-filter haystack (`title\nsnippet\nlocation`) tops out
// at 206 chars — comparable to a URL, not the kilobytes one might assume, so
// per-match cost is similar to the linkPattern case. What differs is that it
// runs ~20k times per request against up to 60 patterns (40 global + 20
// per-watchlist). That changes the verdict on POLYNOMIAL shapes: a `.*.*.*x`
// costing ~10ms on a 206-char subject is negligible once but ~3.5 minutes of
// blocked event loop across 20k rows. Exponential shapes are far worse again.
// So on this surface polynomial blowup is NOT dismissible the way it is for a
// single URL match — see `regexShapeRisk`'s residual-risk note.
//
// WHERE THIS LIVES AND WHY. A standalone, ZERO-DEPENDENCY module — not inside
// `watchlists.ts` — for two reasons: `lib/schemas/settings.ts` would otherwise
// have to depend on the whole watchlists schema to validate its own field, and
// `lib/postings/negative-filters.ts` is deliberately dependency-free so client
// components can import it "without dragging the server runtime into the
// browser bundle" (its own words). Importing zod there to reach this scan would
// break that intent; importing this file does not.
//
// WHAT THIS IS AND IS NOT. A conservative STRUCTURAL heuristic, not a proof of
// safety. It rejects the shapes that make backtracking exponential — a repeated
// group whose body itself repeats or alternates — plus backreferences, and caps
// gross complexity. It does NOT certify that an accepted pattern runs in linear
// time. Read `regexShapeRisk`'s residual-risk block before relying on it.

/** Max group nesting depth. Deeper than this is not a user filter. */
const MAX_REGEX_GROUP_DEPTH = 10;

/** Max total quantifiers (`*`, `+`, `?`, `{m,n}`) anywhere in the source. */
const MAX_REGEX_QUANTIFIERS = 20;

interface QuantifierAt {
    /** True when the quantifier can iterate more than once — `*`, `+`, `{2,}`, `{1,5}`. */
    repeatable: boolean;
    /** Index of the quantifier's LAST character (the `}` for a brace form). */
    end: number;
}

/**
 * Read a quantifier starting at `i`, or null when `src[i]` does not begin one.
 *
 * `?` and `{0,1}` are quantifiers but NOT `repeatable`: `(a+)?` tries the group
 * at most once, so it cannot blow up. Only a construct that can iterate >= 2
 * times multiplies the ambiguity of whatever it wraps. A `{...}` that does not
 * parse as a counted repetition (e.g. `{abc}`) is a literal brace, not a
 * quantifier — same as the regex engine treats it.
 */
function quantifierAt(src: string, i: number): QuantifierAt | null {
    const c = src[i];
    if (c === "*" || c === "+") return { repeatable: true, end: i };
    if (c === "?") return { repeatable: false, end: i };
    if (c !== "{") return null;
    const close = src.indexOf("}", i + 1);
    if (close < 0) return null;
    const m = /^(\d+)(,(\d*))?$/.exec(src.slice(i + 1, close));
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : (m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3]));
    return { repeatable: max > 1, end: close };
}

/**
 * Advance past a group's opening prefix so `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`
 * and `(?<name>` are not mis-scanned — without this the `?` in `(?:` reads as a
 * quantifier and the letters in `(?<name>` read as pattern content. Returns the
 * index of the prefix's last character (the caller's loop then steps past it).
 */
function skipGroupPrefix(src: string, open: number): number {
    if (src[open + 1] !== "?") return open;
    let j = open + 2;
    if (src[j] === "<" && src[j + 1] !== "=" && src[j + 1] !== "!") {
        const gt = src.indexOf(">", j);
        return gt < 0 ? j : gt;          // malformed; the compile gate rejects it
    }
    if (src[j] === "<") j += 1;          // lookbehind: land on the `=` / `!`
    return j;
}

/**
 * Single-pass structural scan for catastrophic-backtracking shapes. Returns the
 * reason the source is risky, or null when it passes.
 *
 * SHAPE ONLY — it does NOT require the source to compile. That split is
 * deliberate and load-bearing: `lib/postings/negative-filters.ts` documents
 * that an invalid pattern is silently skipped rather than surfaced, so a user
 * typing `C++` as a negative filter must keep getting today's harmless no-op
 * instead of a new 400. Compilability is a separate concern handled by
 * `unsafeRegexSourceReason`, which the fetcher-facing `linkPattern` uses
 * because there a broken pattern is a broken watchlist worth reporting.
 * The scan is defensive about unbalanced input for exactly this reason.
 *
 * The scan tracks one frame per group, recording whether that group's body
 * contains a quantifier or a top-level alternation. When the group CLOSES under
 * a repeatable quantifier, either fact means the engine has more than one way
 * to divide the same input between iterations — which is exactly the ambiguity
 * that turns a failing match into 2^n backtracks:
 *
 *     (a+)+$        body repeats      →  rejected
 *     (\w+\s?)*$    body repeats      →  rejected
 *     (a|ab)*$      body alternates   →  rejected
 *     (?:a+)+       body repeats      →  rejected
 *     (abc)+        body is fixed     →  allowed (deterministic)
 *     (jobs|careers)/\d+   group not repeated  →  allowed
 *
 * Escapes and character classes are honoured so `\(`, `\+` and `[+*]` read as
 * literals rather than as structure.
 *
 * RESIDUAL RISK — read before trusting this. Catching `(a+)+` is a heuristic,
 * not a proof, and an accepted pattern is NOT certified linear-time:
 *
 *   1. It reasons about SHAPE, not about the languages the branches match. It
 *      rejects every repeated group that alternates, including harmless ones
 *      like `(jobs|careers)+` — over-rejection is the deliberate direction —
 *      but it cannot see ambiguity expressed without those shapes.
 *   2. POLYNOMIAL blowup is NOT caught. `.*.*.*x` is cubic in the subject and
 *      passes this scan. On `linkPattern` that is a judged non-issue (one
 *      resolved URL per match). On the NEGATIVE-FILTER surface it is a real
 *      residual gap, because the row multiplier documented at the top of this
 *      file turns a per-match cost of milliseconds into minutes of blocked
 *      event loop. Bounding it properly needs a match budget, not a bigger
 *      scan — the honest statement is that this fix removes the exponential
 *      class from that surface and leaves the polynomial class standing.
 *   3. It is a static check on the STORED source. It does not make the match
 *      itself interruptible — nothing available without a worker thread does —
 *      so a shape neither this scan nor a human anticipated still runs to
 *      completion on the tier that compiled it.
 *
 * The honest summary: this removes the trivially weaponisable shapes from
 * crew-reachable inputs. It does not make `new RegExp(userInput)` safe in
 * general. If a genuinely untrusted regex surface ever appears, the answer is
 * to stop running it on the request/scheduler thread, not to grow this scan.
 */
export function regexShapeRisk(src: string): string | null {
    interface Frame { hasQuant: boolean; hasAlt: boolean }
    const stack: Frame[] = [{ hasQuant: false, hasAlt: false }];
    let inClass = false;
    let quantifiers = 0;

    for (let i = 0; i < src.length; i++) {
        const c = src[i];

        if (c === "\\") {
            const next = src[i + 1];
            if (!inClass && next >= "1" && next <= "9") {
                return "it uses a backreference (\\1–\\9). A backreference under a " +
                    "quantifier backtracks exponentially and has no use in a filter pattern";
            }
            i++;                                    // consume the escaped character
            continue;
        }
        if (inClass) {
            if (c === "]") inClass = false;
            continue;
        }
        if (c === "[") { inClass = true; continue; }

        const top = stack[stack.length - 1];

        if (c === "(") {
            i = skipGroupPrefix(src, i);
            stack.push({ hasQuant: false, hasAlt: false });
            if (stack.length - 1 > MAX_REGEX_GROUP_DEPTH) {
                return `it nests groups more than ${MAX_REGEX_GROUP_DEPTH} deep`;
            }
            continue;
        }

        if (c === ")") {
            // An unbalanced `)` is possible here: this scan runs on sources that
            // have NOT necessarily compiled (see the shape-only note above), so
            // guard the pop rather than assuming a matching `(`.
            const body = stack.length > 1 ? stack.pop()! : { hasQuant: false, hasAlt: false };
            const q = quantifierAt(src, i + 1);
            if (q) {
                if (++quantifiers > MAX_REGEX_QUANTIFIERS) {
                    return `it uses more than ${MAX_REGEX_QUANTIFIERS} quantifiers`;
                }
                if (q.repeatable && body.hasQuant) {
                    return "it repeats a group that itself contains a quantifier " +
                        "(a nested quantifier such as `(a+)+`), which backtracks exponentially";
                }
                if (q.repeatable && body.hasAlt) {
                    return "it repeats a group containing an alternation " +
                        "(such as `(a|ab)*`), whose branches can match the same input two ways";
                }
                stack[stack.length - 1].hasQuant = true;
                i = q.end;
                if (src[i + 1] === "?") i++;         // lazy suffix, not a second quantifier
            }
            continue;
        }

        if (c === "|") { top.hasAlt = true; continue; }

        const q = quantifierAt(src, i);
        if (q) {
            if (++quantifiers > MAX_REGEX_QUANTIFIERS) {
                return `it uses more than ${MAX_REGEX_QUANTIFIERS} quantifiers`;
            }
            top.hasQuant = true;
            i = q.end;
            if (src[i + 1] === "?") i++;             // lazy suffix
        }
    }

    return null;
}

/**
 * `regexShapeRisk` PLUS a compile gate — why `source` is not safe to accept as
 * a user-supplied regex, or null when it passes.
 *
 * Use this where an uncompilable pattern is itself a defect worth reporting at
 * the boundary (`careers-page.linkPattern`: a watchlist whose pattern does not
 * compile is a broken watchlist, and today that surfaces only as an opaque
 * `lastError` after the fact). Use the bare `regexShapeRisk` where invalid
 * input already has a defined lenient behaviour that must not change.
 */
export function unsafeRegexSourceReason(source: string): string | null {
    try {
        new RegExp(source);
    } catch (e) {
        return `it is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`;
    }
    return regexShapeRisk(source);
}
