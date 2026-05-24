// M7.6.7 — Bullet-assist API route.
//
// POST /api/profile/bullets/assist
//
// One endpoint, two modes (discriminated by body.mode):
//   * fill    — entry has zero bullets; LLM returns 3–5 starter bullets with
//               fresh ids, locked/excluded both false.
//   * rewrite — user picked one existing bullet; LLM returns a single proposal
//               preserving id / tags / locked / excluded, only `text` flows
//               from the model.
//
// This route does NOT persist. Both fill suggestions and rewrite proposals are
// transient — the client surfaces them in a draft / diff panel and persists on
// Accept via the existing PATCH on /api/profile/{work-roles|projects|education}
// with the updated bullets array. Keeping persistence out of this route keeps
// the LLM call idempotent-from-the-server's-view and lets the UI throw away
// proposals the user doesn't want without leaving DB residue.
//
// Pipeline (see docs/implementation.md §M7.6.7 for the design):
//   1. requireSession — owner check via session.user.id.
//   2. checkUserRateLimit('profile:bullet-assist', userId, ..., 20/10min)
//      BEFORE any Gemini-touching code. Looser than the 5/10min on
//      profile:import / resumes:gen because this is per-bullet — tight enough
//      that a stuck refresh loop can't burn the daily Gemini budget.
//   3. Zod-parse body (discriminated union; rewrite mode requires bulletId).
//   4. Load parent row from WorkRole / Project / Education by parentKind,
//      include the parent profile's userId for the owner check. Cross-user
//      hit → 404 (not 403 — same posture as the rest of /api/profile/*).
//   5. Parse the bullets JSON column via parseBullets() (defensive against
//      malformed payloads — returns [] on parse failure).
//   6. Rewrite mode only: locate the bullet by id (404 if not found); refuse
//      400 'cannot-rewrite-locked' if it's locked (defense-in-depth — the UI
//      hides the wand on locked bullets but a forged request would bypass).
//   7. Build the grounding context for buildBulletAssistPrompt:
//        • AssistParent — spine fields mapped from the Prisma row.
//        • Sibling bullets — every bullet from OTHER work-roles / projects /
//          education entries in the same profile, ranked by tag-overlap with
//          the current parent's "interest set" (fill mode → spine words;
//          rewrite mode → the current bullet's tags), capped to 15 entries.
//          The prompt builder applies its own byte cap on top.
//        • Archive spans — findUploadsMatchingParent() pulls up to 5 prior
//          uploads where rawText mentions the parent identifier, then
//          findArchiveSpansFor() picks the top 3 by recency.
//        • README excerpt — projects only, 2 KB cap.
//        • currentBullet — rewrite mode only, passed by the impure caller for
//          id/tags/locked/excluded preservation.
//   8. callBulletAssist hits Gemini through chatJSON (rate-limited downstream
//      by acquireGeminiSlot). Returns either { mode: 'fill', bullets } or
//      { mode: 'rewrite', proposal }.
//   9. Shape into the BulletAssistResponseSchema discriminated-union response.
//
// Error handling mirrors app/api/resumes/route.ts:
//   * Each stage tracked in a `stage` variable so the 500 carries the failure
//     point ("load" | "build" | "call").
//   * AIError → 502 with { error, stage, aiStage } so the UI can show a
//     "Gemini failed" toast distinct from generic 500s.
//   * Everything else → 500 with the error message.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { checkUserRateLimit } from "@/lib/api/user-rate-limit";
import { findOrCreateProfile } from "@/lib/repositories/profile";
import { findUploadsMatchingParent } from "@/lib/repositories/resume-uploads";
import { parseBullets } from "@/lib/profile/bullets";
import type { Bullet } from "@/lib/profile/types";
import {
    type AssistParent,
    type ParentKind,
    type SiblingInput,
    type ProjectReadmeContext,
    buildBulletAssistPrompt,
    callBulletAssist,
} from "@/lib/profile/bullet-assist";
import {
    findArchiveSpansFor,
    type ArchiveSpan,
} from "@/lib/profile/upload-archive";
import { BulletAssistBodySchema } from "@/lib/schemas/profile";
import { AIError } from "@/lib/ai/gemini";

export const runtime = "nodejs";
// Gemini call + DB load + sibling collection can run ~5s end-to-end on slow
// days — bump from the default 10s ceiling to match the other LLM routes.
export const maxDuration = 60;

// Pulled from resumes/route.ts — the session callback puts user.id on
// session.user but the type is loose, so we narrow at the call site.
function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

// Stable per-parent-kind delegate name on prisma. The Prisma generator
// camelCases model names, so model WorkRole → prisma.workRole, etc. Keeping
// this as a small lookup so we don't have a five-way if/else inline.
type ParentRow = {
    id: string;
    profileId: string;
    bullets: string;
    profile: { userId: string };
    // Spine fields — only the relevant ones are populated based on kind.
    company?: string | null;
    title?: string | null;
    location?: string | null;
    startDate?: Date | null;
    endDate?: Date | null;
    name?: string | null;
    description?: string | null;
    repoUrl?: string | null;
    liveUrl?: string | null;
    readme?: string | null;
    institution?: string | null;
    degree?: string | null;
    field?: string | null;
};

async function loadParent(kind: ParentKind, parentId: string): Promise<ParentRow | null> {
    // Each delegate has a slightly different field set; we cast through the
    // shared ParentRow shape — missing fields naturally come back undefined,
    // which AssistParent already tolerates.
    if (kind === "work-role") {
        return prisma.workRole.findUnique({
            where: { id: parentId },
            include: { profile: { select: { userId: true } } },
        }) as unknown as Promise<ParentRow | null>;
    }
    if (kind === "project") {
        return prisma.project.findUnique({
            where: { id: parentId },
            include: { profile: { select: { userId: true } } },
        }) as unknown as Promise<ParentRow | null>;
    }
    return prisma.education.findUnique({
        where: { id: parentId },
        include: { profile: { select: { userId: true } } },
    }) as unknown as Promise<ParentRow | null>;
}

// Map a Prisma row to the AssistParent shape the prompt builder expects.
// Date → ISO YYYY-MM-DD (matches the YYYY-MM-DD form the spine renderer
// looks readable with; full timestamps add noise).
function toAssistParent(kind: ParentKind, parentId: string, row: ParentRow): AssistParent {
    const isoDate = (d: Date | null | undefined): string | null => {
        if (!d) return null;
        return d.toISOString().slice(0, 10);
    };
    if (kind === "work-role") {
        return {
            kind,
            id: parentId,
            company: row.company ?? null,
            title: row.title ?? null,
            location: row.location ?? null,
            startDate: isoDate(row.startDate),
            endDate: isoDate(row.endDate),
        };
    }
    if (kind === "project") {
        return {
            kind,
            id: parentId,
            name: row.name ?? null,
            description: row.description ?? null,
            repoUrl: row.repoUrl ?? null,
            liveUrl: row.liveUrl ?? null,
            // Project rows don't carry startDate/endDate in the schema; left
            // null. The spine renderer skips null fields.
            startDate: null,
            endDate: null,
        };
    }
    return {
        kind,
        id: parentId,
        institution: row.institution ?? null,
        degree: row.degree ?? null,
        field: row.field ?? null,
        location: row.location ?? null,
        startDate: isoDate(row.startDate),
        endDate: isoDate(row.endDate),
    };
}

// Resolve the parent's primary identifier — what we keyword-match prior
// uploads against. Mirrors the resolution logic inside
// findUploadsMatchingParent + findArchiveSpansFor so both layers agree.
function resolveIdentifier(kind: ParentKind, row: ParentRow): string | null {
    let raw: string | null | undefined;
    if (kind === "work-role") raw = row.company;
    else if (kind === "project") raw = row.name;
    else raw = row.institution;
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

// Fill mode has no current bullet → derive a small set of "interest" tokens
// from the parent spine (title / role / name / institution) so we can still
// rank siblings by something better than recency. Lowercase, dedupe.
function fillInterestTags(kind: ParentKind, row: ParentRow): string[] {
    const sources: Array<string | null | undefined> = [];
    if (kind === "work-role") {
        sources.push(row.title, row.company);
    } else if (kind === "project") {
        sources.push(row.name, row.description);
    } else {
        sources.push(row.field, row.degree, row.institution);
    }
    const words = sources
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .flatMap(s => s.toLowerCase().split(/[^a-z0-9]+/g))
        .filter(w => w.length >= 3);
    return Array.from(new Set(words));
}

// Rank-by-tag-overlap helper. For each sibling bullet, count how many of its
// tags appear in `interest` (set membership). Sort descending by overlap
// count, ties broken by recency-of-source-order (input order preserved by
// stable sort). Cap to 15 — the prompt builder applies a tighter byte cap
// on top, but we cut early so we don't ship hundreds of bullets across the
// wire to a function that'll throw most away.
const SIBLING_RAW_CAP = 15;
function rankSiblingsByOverlap(
    siblings: Array<{ text: string; tags: string[] }>,
    interest: Set<string>,
): SiblingInput[] {
    const scored = siblings.map((b, i) => {
        let overlap = 0;
        for (const t of b.tags) {
            if (interest.has(t.toLowerCase())) overlap += 1;
        }
        return { overlap, index: i, bullet: b };
    });
    scored.sort((a, b) => {
        if (b.overlap !== a.overlap) return b.overlap - a.overlap;
        return a.index - b.index;
    });
    return scored.slice(0, SIBLING_RAW_CAP).map(s => ({
        text: s.bullet.text,
        tags: s.bullet.tags,
    }));
}

// 2 KB cap on the README excerpt (matches docs/implementation.md §M7.6).
const README_EXCERPT_CAP = 2 * 1024;

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    // 20 calls / 10 min per user — see docs/implementation.md §M7.6.7. Per-bullet
    // surface so it's higher than profile:import / resumes:gen (5 / 10 min);
    // still tight enough to bound a runaway client. Must run BEFORE any
    // Gemini-touching code so a tight loop can't burn the daily budget.
    const rl = checkUserRateLimit(
        "profile:bullet-assist",
        userId,
        Date.now(),
        { max: 20, windowMs: 10 * 60 * 1000 },
    );
    if (!rl.ok) {
        return NextResponse.json(
            {
                error: `Too many bullet-assist calls — try again in ${rl.retryAfterSec}s`,
                stage: "rate-limit",
            },
            { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
    }

    const parsed = BulletAssistBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues, stage: "input" }, { status: 400 });
    }

    let stage: "load" | "build" | "call" = "load";
    try {
        // 1. Load parent + owner check. Cross-user hits surface as 404 to
        //    avoid leaking which parent ids exist for other users.
        const parentRow = await loadParent(parsed.data.parentKind, parsed.data.parentId);
        if (!parentRow || parentRow.profile.userId !== userId) {
            return NextResponse.json({ error: "not-found", stage: "load" }, { status: 404 });
        }

        // 2. Parse the bullets JSON column. parseBullets is defensive — it
        //    returns [] on malformed payloads, so we don't 500 on a corrupted
        //    DB row.
        const bullets: Bullet[] = parseBullets(parentRow.bullets);

        // 3. Rewrite mode: find the target bullet + reject locked.
        let currentBullet: Bullet | null = null;
        if (parsed.data.mode === "rewrite") {
            // Alias to a local const so TS preserves the discriminated-union
            // narrowing inside the .find callback (the closure would otherwise
            // re-widen `parsed.data` back to the union).
            const rewriteBody = parsed.data;
            const found = bullets.find(b => b.id === rewriteBody.bulletId);
            if (!found) {
                return NextResponse.json(
                    { error: "bullet-not-found", stage: "load" },
                    { status: 404 },
                );
            }
            if (found.locked) {
                return NextResponse.json(
                    { error: "cannot-rewrite-locked", stage: "load" },
                    { status: 400 },
                );
            }
            currentBullet = found;
        }

        stage = "build";
        // 4. Build the AssistParent shape from the Prisma row.
        const assistParent = toAssistParent(
            parsed.data.parentKind,
            parsed.data.parentId,
            parentRow,
        );

        // 5. Sibling bullets — collect from the hydrated profile, excluding
        //    the current parent's own bullets. Rank by tag-overlap with the
        //    interest set (current-bullet tags for rewrite; spine-derived
        //    tokens for fill).
        const profile = await findOrCreateProfile(userId);
        const siblingsRaw: Array<{ text: string; tags: string[] }> = [];
        for (const wr of profile.workRoles) {
            if (parsed.data.parentKind === "work-role" && wr.id === parsed.data.parentId) continue;
            for (const b of wr.bullets) {
                if (b.excluded) continue; // excluded bullets aren't voice samples
                siblingsRaw.push({ text: b.text, tags: b.tags });
            }
        }
        for (const pj of profile.projects) {
            if (parsed.data.parentKind === "project" && pj.id === parsed.data.parentId) continue;
            for (const b of pj.bullets) {
                if (b.excluded) continue;
                siblingsRaw.push({ text: b.text, tags: b.tags });
            }
        }
        for (const ed of profile.education) {
            if (parsed.data.parentKind === "education" && ed.id === parsed.data.parentId) continue;
            for (const b of ed.bullets) {
                if (b.excluded) continue;
                siblingsRaw.push({ text: b.text, tags: b.tags });
            }
        }
        const interestTags = parsed.data.mode === "rewrite" && currentBullet
            ? currentBullet.tags.map(t => t.toLowerCase())
            : fillInterestTags(parsed.data.parentKind, parentRow);
        const interest = new Set(interestTags);
        const siblingBullets = rankSiblingsByOverlap(siblingsRaw, interest);

        // 6. Archive spans — pull up to 5 matching uploads, then findArchiveSpansFor
        //    picks the top 3 by recency. Both layers short-circuit cleanly on
        //    null / empty identifiers.
        const identifier = resolveIdentifier(parsed.data.parentKind, parentRow);
        const uploads = await findUploadsMatchingParent(
            userId,
            {
                kind: parsed.data.parentKind,
                company: parentRow.company ?? null,
                name: parentRow.name ?? null,
                institution: parentRow.institution ?? null,
            },
            5,
        );
        const archiveSpans: ArchiveSpan[] = findArchiveSpansFor(
            { kind: parsed.data.parentKind, identifier },
            uploads,
        );

        // 7. README excerpt — projects only, 2 KB cap. The prompt builder
        //    re-caps defensively, but trimming here also keeps the body of
        //    the function bounded.
        let readmeContext: ProjectReadmeContext | null = null;
        if (parsed.data.parentKind === "project") {
            const rawReadme = parentRow.readme;
            if (typeof rawReadme === "string" && rawReadme.trim().length > 0) {
                readmeContext = {
                    projectId: parsed.data.parentId,
                    projectName: parentRow.name ?? "Project",
                    excerpt: rawReadme.slice(0, README_EXCERPT_CAP),
                };
            }
        }

        // 8. Build the prompt + call Gemini.
        const prompt = buildBulletAssistPrompt({
            mode: parsed.data.mode,
            parent: assistParent,
            siblingBullets,
            archiveSpans,
            readmeContext,
            currentBullet: parsed.data.mode === "rewrite" && currentBullet
                ? { text: currentBullet.text, tags: currentBullet.tags }
                : null,
        });

        stage = "call";
        const result = await callBulletAssist({
            mode: parsed.data.mode,
            prompt,
            currentBullet: parsed.data.mode === "rewrite" ? currentBullet : null,
            parentKind: parsed.data.parentKind,
            parentId: parsed.data.parentId,
        });

        // 9. Shape into the wire-format discriminated union.
        if (result.mode === "fill") {
            return NextResponse.json(
                { mode: "fill", suggestions: result.bullets },
                { status: 200 },
            );
        }
        return NextResponse.json(
            { mode: "rewrite", proposal: result.proposal },
            { status: 200 },
        );
    } catch (e) {
        console.warn(`[bullet-assist] stage=${stage} error:`, e);
        if (e instanceof AIError) {
            return NextResponse.json(
                { error: "llm-error", detail: e.message, stage, aiStage: e.stage },
                { status: 502 },
            );
        }
        const detail = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: "assist-failed", detail, stage },
            { status: 500 },
        );
    }
}
