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
    const bullets = collectBullets(profile).filter(b => !b.excluded);

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

        if (tagSet.has(kw) || haystack.includes(kw)) {
            covered.push(raw);
        } else {
            missing.push(raw);
        }
    }

    return { missing, covered };
}
