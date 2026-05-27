/**
 * Hermetic smoke for selectProfileExtras (2026-05-27).
 *
 * Pre-2026-05-27 behavior: all three sections (Skills + Languages + Hobbies)
 * were posting-keyword-filtered. In practice this dropped everything on
 * off-domain postings — a security-guard posting has no keyword overlap with
 * "Spanish" or "Creative Film Writing" — leaving empty sections.
 *
 * Post-fix:
 *   - Skills: still filtered by posting keywords (long lists need tailoring).
 *   - Languages: ALWAYS returned, regardless of posting keywords.
 *   - Hobbies:  ALWAYS returned, regardless of posting keywords.
 *
 * Pure function — no DB, no Prisma.
 *
 *   npx tsx scripts/tests/hermetic/profile-extras-filter-smoke.ts
 */
import { selectProfileExtras } from "@/lib/resumes/select";
import type { ProfileWire } from "@/lib/schemas/profile";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function makeProfile(): ProfileWire {
    return {
        id: "p1",
        headline: "Salvador Salcedo",
        tagline: null,
        contact: null,
        location: null,
        links: [],
        skills: [
            { category: "Programming Languages", items: ["Python", "C++", "JavaScript"] },
            { category: "Cloud", items: ["AWS", "GCP"] },
        ],
        languages: [
            { name: "English", proficiency: "Native" },
            { name: "Spanish", proficiency: "Fluent" },
            { name: "French", proficiency: "Conversational" },
        ],
        hobbies: ["Creative Film Writing", "Hiking"],
        workRoles: [],
        projects: [],
        education: [],
    } as unknown as ProfileWire;
}

// --- Skills: posting-filtered (unchanged behavior) ---
{
    const profile = makeProfile();
    const out = selectProfileExtras(profile, ["python", "aws"]);
    check("skills filtered: only Python + AWS survive",
        out.skills.length === 2
        && out.skills.find(g => g.category === "Programming Languages")?.items.join(",") === "Python"
        && out.skills.find(g => g.category === "Cloud")?.items.join(",") === "AWS",
        JSON.stringify(out.skills));
}

{
    const profile = makeProfile();
    const out = selectProfileExtras(profile, ["security", "patrol", "officer"]);
    check("skills filtered: off-domain posting → empty Skills section",
        out.skills.length === 0,
        JSON.stringify(out.skills));
}

// --- Languages: ALWAYS returned (new behavior) ---
{
    const profile = makeProfile();
    const out = selectProfileExtras(profile, ["security", "patrol", "officer"]);
    check("languages always shown: off-domain posting still returns all 3 languages",
        out.languages.length === 3
        && out.languages.map(l => l.name).join(",") === "English,Spanish,French",
        JSON.stringify(out.languages));
}

{
    const profile = makeProfile();
    const out = selectProfileExtras(profile, []);
    check("languages always shown: empty keyword list still returns all languages",
        out.languages.length === 3);
}

{
    const profile = makeProfile();
    const out = selectProfileExtras(profile, ["spanish"]);
    check("languages NOT narrowed even when posting mentions a specific language",
        out.languages.length === 3,
        "all three should still render, not just Spanish");
}

// --- Hobbies: ALWAYS returned (new behavior) ---
{
    const profile = makeProfile();
    const out = selectProfileExtras(profile, ["security"]);
    check("hobbies always shown: off-domain posting still returns all hobbies",
        out.hobbies.length === 2
        && out.hobbies.join("|") === "Creative Film Writing|Hiking",
        JSON.stringify(out.hobbies));
}

// --- Empty profile sections still produce empty arrays (no crash, no synthesis) ---
{
    const empty: ProfileWire = {
        id: "p1", headline: "X", tagline: null, contact: null, location: null, links: [],
        skills: [], languages: [], hobbies: [],
        workRoles: [], projects: [], education: [],
    } as unknown as ProfileWire;
    const out = selectProfileExtras(empty, ["python"]);
    check("empty profile: skills empty", out.skills.length === 0);
    check("empty profile: languages empty", out.languages.length === 0);
    check("empty profile: hobbies empty", out.hobbies.length === 0);
}

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
