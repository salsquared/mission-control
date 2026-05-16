import type { ProfileWire } from "@/lib/schemas/profile";

// Story 41 — skills-gap detector.
//
// Given a parsed posting's keyword list + the user's full profile, return the
// keywords that have NO coverage anywhere in the profile. "Coverage" means:
//   - the keyword appears (case-insensitive) as a tag on at least one bullet, OR
//   - the keyword appears (case-insensitive substring) inside any bullet's text
//
// Education / project / work-role bullets all count — coverage is union across
// the whole profile, not per-entity, because the resume can pull from any of
// them. `excluded: true` bullets are skipped: if the user has explicitly hidden
// a bullet from every generated resume, its content shouldn't count toward
// "you have this covered."
//
// Pure / no LLM / unit-testable as scripts/tests/skills-gap-smoke.ts.

function normalize(s: string): string {
    return s.toLowerCase().trim();
}

// Escape regex metacharacters so a keyword like "node.js" or "c++" doesn't
// blow up the RegExp constructor and doesn't match "." as wildcard. Required
// because posting keywords are user-provided / LLM-extracted.
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match a keyword as a whole word in the haystack. Word boundaries handle the
// common case ("AI/ML"-style postings) without false positives like "ai"
// inside "available" or "go" inside "going". `\b` works against [A-Za-z0-9_]
// boundaries, which is right for tech terms. For keywords whose own start/end
// is a non-word char (e.g. "c++"), `\b` would lie about the right edge, so
// fall back to substring match in that case — they're rare and the substring
// risk is much smaller for symbol-heavy tokens.
function matchesWord(keyword: string, haystack: string): boolean {
    const startsAlnum = /\w/.test(keyword.charAt(0));
    const endsAlnum = /\w/.test(keyword.charAt(keyword.length - 1));
    if (startsAlnum && endsAlnum) {
        return new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(haystack);
    }
    return haystack.includes(keyword);
}

interface CoverageBullet {
    text: string;
    tags: string[];
    excluded: boolean;
}

function collectBullets(profile: ProfileWire): CoverageBullet[] {
    const out: CoverageBullet[] = [];
    for (const r of profile.workRoles) for (const b of r.bullets) out.push({ text: b.text, tags: b.tags, excluded: b.excluded });
    for (const p of profile.projects) for (const b of p.bullets) out.push({ text: b.text, tags: b.tags, excluded: b.excluded });
    for (const e of profile.education) for (const b of e.bullets) out.push({ text: b.text, tags: b.tags, excluded: b.excluded });
    return out;
}

export interface SkillsGapResult {
    /** Keywords with no coverage anywhere in the profile. Preserves the order
     *  of the input keywords (which roughly tracks posting emphasis). */
    missing: string[];
    /** Convenience: the keywords that ARE covered, in input order. */
    covered: string[];
}

export function computeSkillsGap(
    profile: ProfileWire,
    postingKeywords: string[],
): SkillsGapResult {
    // Defensive: a bullet whose `excluded` field is missing (legacy JSON
    // shape from before the field existed) should be treated as included.
    const bullets = collectBullets(profile).filter(b => b.excluded !== true);

    // Lowercased tag set + concatenated text haystack, both built once.
    const tagSet = new Set<string>();
    let haystack = "";
    for (const b of bullets) {
        for (const t of b.tags) tagSet.add(normalize(t));
        haystack += "\n" + normalize(b.text);
    }

    const seen = new Set<string>(); // dedup keywords that repeat in the input
    const missing: string[] = [];
    const covered: string[] = [];

    for (const raw of postingKeywords) {
        const kw = normalize(raw);
        if (!kw || kw.length < 2) continue; // skip noise — same threshold the selector uses
        if (seen.has(kw)) continue;
        seen.add(kw);

        // Tag coverage is exact; text coverage uses word boundaries so "ai"
        // doesn't match "available", "go" doesn't match "going", "ml" doesn't
        // match "html". This was a real false-positive source pre-fix.
        if (tagSet.has(kw) || matchesWord(kw, haystack)) {
            covered.push(raw);
        } else {
            missing.push(raw);
        }
    }

    return { missing, covered };
}
