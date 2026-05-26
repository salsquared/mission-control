import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { checkUserRateLimit } from "@/lib/api/user-rate-limit";
import { findOrCreateProfile } from "@/lib/repositories/profile";
import { parsePosting } from "@/lib/resumes/posting";
import { selectBullets, flattenSelections, type BulletSelection } from "@/lib/resumes/select";
import { autoTagBullets } from "@/lib/profile/auto-tag";
import { synthesizeBulletsForEntity, type ScratchpadSynthEntityKind } from "@/lib/profile/scratchpad-synth";
import { broadcastEvent } from "@/lib/events";
import { rewriteBullets } from "@/lib/resumes/rewrite";
import { computeSkillsGap } from "@/lib/resumes/skills-gap";
import { composeResumeProps } from "@/lib/resumes/templates/ats-plain";
import { renderResumePDF } from "@/lib/resumes/render-pdf";
import { renderResumeDOCX } from "@/lib/resumes/render-docx";
import { writeResumeArtifact, deleteResumeArtifact } from "@/lib/resumes/storage";
import { buildResumeDownloadFilename } from "@/lib/resumes/labels";
import { AIError } from "@/lib/ai/gemini";
import type { ProfileWire } from "@/lib/schemas/profile";

export const runtime = "nodejs";
// PDF render is far heavier than the typical 10s API timeout.
export const maxDuration = 60;

// M8.4.5 (story S8.12) — `applicationId` extends the posting input. When set
// the route loads the linked Application + its JobPosting and uses the
// posting.sourceUrl as the canonical url for the parse step, then auto-attaches
// the resulting GeneratedResume to that application (per [[S8.6]]). The
// existing top-level body `applicationId` (M8-2.4) still works for URL / Paste
// flows that want to attach without going through the Pipeline picker.
const PostingInputSchema = z.object({
    url: z.string().url().optional(),
    text: z.string().optional(),
    applicationId: z.string().cuid().optional(),
}).refine(
    p => (p.url && p.url.trim().length > 0) || (p.text && p.text.trim().length > 0) || (p.applicationId && p.applicationId.trim().length > 0),
    { message: "Provide one of: url, text, or applicationId" },
);

const ResumePostBodySchema = z.object({
    posting: PostingInputSchema,
    applicationId: z.string().optional(), // attaches the GeneratedResume to an Application (M8-2.4)
    options: z.object({
        template: z.literal("ats-plain").optional(),
        format: z.enum(["pdf", "docx"]).optional(),
    }).optional(),
});

// GET projection cap. Default 100 per M8.4.3; max 500 above which the dropdown
// becomes paginate-or-search territory (OOS for M8.4 v1).
const ResumeListLimitSchema = z.coerce.number().int().positive().max(500).default(100);

const FORMAT_CONTENT_TYPES = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

/**
 * M8.6.3 — Scratchpad-synth pass. Iterates the entities in this resume's
 * selection and, for each one with a non-empty scratchpad + at least one
 * mentioned-in-scratchpad uncovered keyword, calls `synthesizeBulletsForEntity`
 * and appends the result back into the entity's bullet group in `selection`.
 *
 * Mutates `selection` in place (the bullets[] array on each entity group)
 * and APPENDS to `flat` directly (the caller re-flattens after).
 *
 * Best-effort posture: any per-entity throw is logged + swallowed. One
 * entity's synthesis failure does not block the others. Total failure (every
 * entity throws) also returns cleanly — the resume still generates from the
 * select+rewrite path.
 *
 * Cross-entity isolation: this function only ever passes ONE entity's
 * scratchpad to `synthesizeBulletsForEntity` per call. A sibling entity's
 * notes never leak into another entity's synthesis prompt.
 */
async function runScratchpadSynth(
    selection: import("@/lib/resumes/select").ResumeSelection,
    flat: BulletSelection[],
    postingKeywords: readonly string[],
): Promise<void> {
    const t0 = Date.now();

    // Compute uncovered keywords from the existing selection (pre-synth).
    // A keyword is "covered" when at least one selected bullet's matchedTags
    // or matchedKeywords includes it (case-insensitive).
    const coveredSet = new Set<string>();
    for (const sel of flat) {
        for (const t of sel.matchedTags) coveredSet.add(t.toLowerCase());
        for (const k of sel.matchedKeywords) coveredSet.add(k.toLowerCase());
    }
    const uncovered = postingKeywords.filter(k => !coveredSet.has(k.toLowerCase()));

    if (uncovered.length === 0) {
        // Every posting keyword is already covered by selected bullets —
        // nothing for the LLM to fill.
        return;
    }

    interface Target {
        kind: ScratchpadSynthEntityKind;
        flatKind: "workRole" | "project" | "education";
        entityId: string;
        scratchpad: string;
        spine: import("@/lib/profile/scratchpad-synth").ScratchpadSynthEntitySpine;
        sourceLabel: string;
        relevant: string[]; // uncovered keywords actually mentioned in scratchpad
    }

    const targets: Target[] = [];

    function pushTarget(t: Target): void {
        if (t.relevant.length > 0) targets.push(t);
    }

    for (const wr of selection.workRoles) {
        const sp = (wr.entity as unknown as { scratchpad?: string | null }).scratchpad;
        if (!sp || sp.trim().length === 0) continue;
        const spLower = sp.toLowerCase();
        const relevant = uncovered.filter(k => spLower.includes(k.toLowerCase()));
        pushTarget({
            kind: "work-role",
            flatKind: "workRole",
            entityId: wr.entity.id,
            scratchpad: sp,
            spine: {
                company: wr.entity.company,
                title: wr.entity.title,
                location: wr.entity.location ?? null,
                startDate: typeof wr.entity.startDate === "string" ? wr.entity.startDate : null,
                endDate: typeof wr.entity.endDate === "string" ? wr.entity.endDate : null,
            },
            sourceLabel: `${wr.entity.title} at ${wr.entity.company}`,
            relevant,
        });
    }
    for (const pr of selection.projects) {
        const sp = (pr.entity as unknown as { scratchpad?: string | null }).scratchpad;
        if (!sp || sp.trim().length === 0) continue;
        const spLower = sp.toLowerCase();
        const relevant = uncovered.filter(k => spLower.includes(k.toLowerCase()));
        pushTarget({
            kind: "project",
            flatKind: "project",
            entityId: pr.entity.id,
            scratchpad: sp,
            spine: { name: pr.entity.name },
            sourceLabel: pr.entity.name,
            relevant,
        });
    }
    for (const ed of selection.education) {
        const sp = (ed.entity as unknown as { scratchpad?: string | null }).scratchpad;
        if (!sp || sp.trim().length === 0) continue;
        const spLower = sp.toLowerCase();
        const relevant = uncovered.filter(k => spLower.includes(k.toLowerCase()));
        pushTarget({
            kind: "education",
            flatKind: "education",
            entityId: ed.entity.id,
            scratchpad: sp,
            spine: {
                institution: ed.entity.institution,
                degree: ed.entity.degree ?? null,
                field: ed.entity.field ?? null,
            },
            sourceLabel: `${ed.entity.degree ?? "Education"} at ${ed.entity.institution}`,
            relevant,
        });
    }

    if (targets.length === 0) {
        console.info(`[scratchpad-synth] no targets (uncovered=${uncovered.length}, entities-with-scratchpad=0)`);
        return;
    }

    // Run synthesis in parallel — one entity's call can't depend on another's.
    const results = await Promise.allSettled(targets.map(t =>
        synthesizeBulletsForEntity({
            entityKind: t.kind,
            entityId: t.entityId,
            entitySpine: t.spine,
            scratchpad: t.scratchpad,
            postingKeywords,
            uncoveredKeywords: t.relevant,
        }).then(r => ({ target: t, bullets: r.bullets })),
    ));

    let totalSynth = 0;
    for (const r of results) {
        if (r.status !== "fulfilled") {
            const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
            console.warn(`[scratchpad-synth] entity synthesis failed: ${msg}`);
            continue;
        }
        const { target, bullets } = r.value;
        if (bullets.length === 0) continue;

        // Locate the entity group in `selection` and append synthesized
        // bullets to its bullets[] array. Mutating in place — composeResumeProps
        // iterates the same selection object.
        const group =
            target.flatKind === "workRole"
                ? selection.workRoles.find(g => g.entity.id === target.entityId)
                : target.flatKind === "project"
                    ? selection.projects.find(g => g.entity.id === target.entityId)
                    : selection.education.find(g => g.entity.id === target.entityId);
        if (!group) continue;

        for (const b of bullets) {
            const matchedKeywords = target.relevant.filter(k =>
                b.text.toLowerCase().includes(k.toLowerCase()),
            );
            const sel: BulletSelection = {
                kind: target.flatKind,
                sourceId: target.entityId,
                sourceLabel: target.sourceLabel,
                bulletId: b.id,
                originalText: b.text,
                score: 0, // synthesized rows aren't ranked; appended after select
                matchedTags: b.tags,
                matchedKeywords,
                locked: false,
                synthSource: "scratchpad",
            };
            group.bullets.push(sel);
            flat.push(sel);
            totalSynth += 1;
        }
    }

    const durationMs = Date.now() - t0;
    console.info(`[scratchpad-synth] +${totalSynth} bullets across ${targets.length} entities (uncovered=${uncovered.length}, ${durationMs}ms)`);
}

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

interface GeneratedResumeRow {
    id: string;
    userId: string;
    applicationId: string | null;
    createdAt: Date;
    templateKey: string;
    format: string;
    status: string;
    artifactPath: string | null;
    error: string | null;
    // M8.4.3 — surfaced to the previous-resumes dropdown so the UI shows
    // company + title at a glance. NULL on rows generated before M8.4.2 added
    // these columns; the dropdown falls back to postingInputSummary (below).
    postingTitle: string | null;
    postingCompany: string | null;
    // Raw JSON of the original posting input (url / text / applicationId
    // discriminated union). Used here only to derive `postingInputSummary`
    // for legacy rows — not returned to the client raw.
    postingInput: string;
    // Frozen snapshot of the full profile at gen time. Mined here for the
    // user's headline (their on-resume name) so the dropdown label is the
    // same name printed on the artifact itself, even if the user later
    // edits their profile.
    profileSnapshot: string;
}

// Derive a short user-facing label from the original postingInput JSON.
// Lets the previous-resumes dropdown render *something* for legacy rows
// generated before postingTitle/postingCompany were populated (today's
// M8.4.1 migration). For URL inputs we surface the hostname (more readable
// than the full URL); for pasted text we truncate the first 80 chars.
function summarizePostingInput(rawJson: string): string | null {
    try {
        const p = JSON.parse(rawJson) as { url?: unknown; text?: unknown };
        if (typeof p.url === "string" && p.url.trim()) {
            try { return new URL(p.url).host; }
            catch { return p.url.slice(0, 80); }
        }
        if (typeof p.text === "string" && p.text.trim()) {
            return p.text.trim().slice(0, 80);
        }
        return null;
    } catch {
        return null;
    }
}

// Pull the user's display name out of the snapshotted profile JSON. The
// resume template uses `profile.headline` as the H1, so that's the
// canonical "name as printed on this resume" — frozen at gen time, won't
// drift if the user later edits their profile.
function extractDisplayName(snapshotJson: string): string | null {
    try {
        const p = JSON.parse(snapshotJson) as { headline?: unknown };
        if (typeof p.headline === "string" && p.headline.trim()) return p.headline.trim();
        return null;
    } catch {
        return null;
    }
}

function summarizeResumeRow(r: GeneratedResumeRow) {
    return {
        id: r.id,
        userId: r.userId,
        applicationId: r.applicationId,
        createdAt: r.createdAt.toISOString(),
        templateKey: r.templateKey,
        format: r.format,
        status: r.status,
        hasArtifact: r.artifactPath !== null,
        error: r.error,
        postingTitle: r.postingTitle,
        postingCompany: r.postingCompany,
        postingInputSummary: summarizePostingInput(r.postingInput),
        userDisplayName: extractDisplayName(r.profileSnapshot),
    };
}

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const applicationId = url.searchParams.get("applicationId");
    const limitParam = url.searchParams.get("limit");
    // M8.4.3 — coerce + clamp via zod. Bad input falls back to the default
    // (100) rather than 400'ing the request — the dropdown still needs to
    // render something even if a stale link carries a malformed limit.
    const limitParsed = ResumeListLimitSchema.safeParse(limitParam ?? undefined);
    const limit = limitParsed.success ? limitParsed.data : 100;

    const where: Record<string, unknown> = { userId };
    if (applicationId) where.applicationId = applicationId;

    try {
        const rows = await prisma.generatedResume.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: limit,
        });
        return NextResponse.json({ resumes: rows.map(summarizeResumeRow) }, { status: 200 });
    } catch (e) {
        console.error("[resumes GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    // RAH-12: per-userId rate limit BEFORE any Gemini-touching code runs.
    // Defense-in-depth against an accidental refresh loop or runaway client
    // burning through the daily generation budget (1 generate = 2-3 Gemini
    // calls). 5 per 10 minutes is a generous human cap while still bounding
    // a stuck loop.
    const rl = checkUserRateLimit("resumes:gen", userId, Date.now(), { max: 5, windowMs: 10 * 60 * 1000 });
    if (!rl.ok) {
        return NextResponse.json(
            { error: `Too many resume generations — try again in ${rl.retryAfterSec}s`, stage: "rate-limit" },
            { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
    }

    const parsed = ResumePostBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues, stage: "input" }, { status: 400 });
    }

    let stage: "load" | "parse" | "select" | "rewrite" | "render" = "load";
    try {
        // M8.4.5 (story S8.12) — Pipeline-picker source. When the body carries
        // `posting.applicationId`, resolve that into the canonical posting
        // sourceUrl + auto-link the resulting GeneratedResume to the
        // application. Four guards, all 4xx, all fire before the heavy parse /
        // LLM / render path:
        //   1. Application exists and belongs to the session user → 404 on
        //      cross-user mismatch (don't leak existence).
        //   2. Application.status === 'INTERESTED' → 400 application-not-interested
        //      (defense-in-depth; the picker UI only surfaces INTERESTED).
        //   3. Application.posting?.sourceUrl is non-null → 400
        //      application-missing-url (Decision 6.4: URL-less apps shouldn't
        //      reach this code path via the picker, but a hand-built request
        //      might bypass the picker).
        // Resolution sets posting.url to the application's posting sourceUrl;
        // the parse step downstream treats it as a normal URL input.
        const pickerApplicationId = parsed.data.posting.applicationId?.trim();
        let autoLinkApplicationId: string | null = null;
        if (pickerApplicationId) {
            const application = await prisma.application.findUnique({
                where: { id: pickerApplicationId },
                include: { posting: true },
            });
            if (!application || application.userId !== userId) {
                // Cross-user (or nonexistent) — 404 rather than 403 to avoid
                // leaking the existence of a cuid you don't own.
                return NextResponse.json({ error: "Application not found", stage: "input" }, { status: 404 });
            }
            if (application.status !== 'INTERESTED') {
                return NextResponse.json(
                    { error: "application-not-interested", stage: "input" },
                    { status: 400 },
                );
            }
            const sourceUrl = application.posting?.sourceUrl;
            if (!sourceUrl || sourceUrl.trim().length === 0) {
                return NextResponse.json(
                    { error: "application-missing-url", stage: "input" },
                    { status: 400 },
                );
            }
            // Rewrite the parsed body to feed the parse step a URL it already
            // knows is safe (cuid was validated by zod, sourceUrl is whatever
            // the watchlist fetcher persisted — assertExternalHttpUrl in
            // parsePosting still gates SSRF).
            parsed.data.posting.url = sourceUrl;
            autoLinkApplicationId = application.id;
        }

        // 1. Load profile
        const hydrated = await findOrCreateProfile(userId);
        // Date → ISO string normalization for downstream ProfileWire-typed code.
        const profile = JSON.parse(JSON.stringify(hydrated)) as ProfileWire;

        if (profile.workRoles.length === 0 && profile.projects.length === 0) {
            return NextResponse.json(
                { error: "Profile is empty — add at least one work role or project before generating.", stage: "load" },
                { status: 400 },
            );
        }

        // 2. Parse posting
        stage = "parse";
        const posting = await parsePosting(parsed.data.posting);

        // 2.5. Auto-tag pass (M8.5.4 / story S8.9) — best-effort write-through
        // to the profile before selection. The LLM proposes posting-keyword
        // tags on bullets whose existing text already evidences the work.
        // Errors are logged and swallowed: we still want to generate a resume
        // even when Gemini errors / rate-limits the auto-tag call.
        try {
            const autoTagResult = await autoTagBullets({ userId, postingKeywords: posting.keywords });
            console.info(`[bullet-tags-from-posting] +${autoTagResult.tagsAdded} tags / ${autoTagResult.bulletsAffected} bullets / ${autoTagResult.durationMs}ms`);
            // Re-hydrate the in-memory profile so the selection step below
            // sees the freshly-added tags.
            if (autoTagResult.tagsAdded > 0) {
                const reloaded = await findOrCreateProfile(userId);
                Object.assign(profile, JSON.parse(JSON.stringify(reloaded)) as ProfileWire);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[bullet-tags-from-posting] skipped: ${msg}`);
        }

        // 3. Select bullets
        stage = "select";
        const selection = selectBullets(profile, posting.keywords);
        let flat = flattenSelections(selection);
        if (flat.length === 0) {
            return NextResponse.json(
                { error: "No bullets matched the posting and none are locked/recent — add tags or bullets to your profile.", stage: "select" },
                { status: 400 },
            );
        }
        console.info(`[resume] selected ${flat.length} bullets across ${selection.workRoles.length}+${selection.projects.length}+${selection.education.length} entities`);

        // 3.5. Scratchpad-synth pass (M8.6 / story S7.13 resume-gen half) —
        // for each entity with a non-empty scratchpad AND at least one
        // posting keyword the existing bullets don't cover AND that the
        // scratchpad mentions, synthesize fresh bullet candidates grounded
        // on `scratchpad + posting + entity spine`. Synthesized bullets
        // append to the entity's group in `selection` (so composeResumeProps
        // renders them) and to `flat` (so rewrite + trace see them).
        //
        // Best-effort posture: any per-entity throw is logged + swallowed.
        // Total synthesis failure across all entities still lets the resume
        // generate.
        stage = "select";
        await runScratchpadSynth(selection, flat, posting.keywords);
        // Re-flatten so synthesized rows show up in the post-synth flat list
        // (rewrite + skills-gap + trace surface all consume flat).
        flat = flattenSelections(selection);

        // 4. Rewrite via LLM
        stage = "rewrite";
        // Build per-project README context once before the rewrite call.
        // Only includes READMEs for projects whose bullets are in the
        // selection AND that have a stored README (scheduler-populated for
        // any github.com `repoUrl`). Keeps prompt budget bounded to the
        // projects that actually matter for this specific resume.
        const projectIdsInSelection = new Set(
            flat.filter(s => s.kind === "project").map(s => s.sourceId),
        );
        const readmesBySourceId: Record<string, string> = {};
        for (const project of profile.projects) {
            if (projectIdsInSelection.has(project.id)) {
                const r = (project as unknown as { readme?: string | null }).readme;
                if (typeof r === "string" && r.trim().length > 0) {
                    readmesBySourceId[project.id] = r;
                }
            }
        }
        const rewrites = await rewriteBullets(flat, posting, { readmesBySourceId });

        // 4b. Skills gap (story S8.8) — pure, no LLM. Compute against the
        // FULL profile, not just the selected bullets: even an unselected
        // bullet counts as coverage for the keyword it mentions.
        const rawSkillsGap = computeSkillsGap(profile, posting.keywords);

        // M8.6.4 — scratchpad-synth bullets aren't on the profile (they live
        // only in this resume's selection), so the pure computeSkillsGap
        // won't see them. Post-filter: any posting keyword evidenced by a
        // synthesized bullet's `matchedKeywords` drops out of the gap list.
        const synthCoveredKeywords = new Set<string>();
        for (const s of flat) {
            if (s.synthSource !== "scratchpad") continue;
            for (const kw of s.matchedKeywords) synthCoveredKeywords.add(kw.toLowerCase());
        }
        const skillsGap = synthCoveredKeywords.size === 0
            ? rawSkillsGap
            : {
                  ...rawSkillsGap,
                  missing: rawSkillsGap.missing.filter(k => !synthCoveredKeywords.has(k.toLowerCase())),
                  covered: [
                      ...rawSkillsGap.covered,
                      ...rawSkillsGap.missing.filter(k => synthCoveredKeywords.has(k.toLowerCase())),
                  ],
              };

        // 5. Render
        stage = "render";
        const format = parsed.data.options?.format ?? "pdf";
        const props = composeResumeProps(profile, selection, rewrites);
        const bytes = format === "docx"
            ? await renderResumeDOCX(props)
            : await renderResumePDF(props);

        // Canonical filename — "<headline> - <role> - <company> Resume.<ext>".
        // The user's name comes from profile.headline (what the resume's H1
        // prints). Falls back to the old "resume-<dateSlug>" pattern when no
        // identifying parts are present (defensive — shouldn't happen on the
        // POST path since posting.company always exists, but cheap).
        const dateSlug = new Date().toISOString().slice(0, 10);
        const filename = buildResumeDownloadFilename({
            userDisplayName: profile.headline?.trim() || null,
            postingTitle: posting.title?.trim() || null,
            postingCompany: posting.company?.trim() || null,
            format,
        }, dateSlug);

        // 6. Persist (M8-2.2). Write artifact first; if that fails we never
        // create the row (no orphan rows pointing at missing files). If the row
        // insert fails afterward, we'd have an orphan FILE — manual cleanup,
        // but the user still got their resume in the response.
        //
        // M8.4.5 step 6 — when the body carried `posting.applicationId`, we
        // resolved it to `autoLinkApplicationId` above; that takes precedence
        // over the legacy top-level `applicationId` (M8-2.4) so the Pipeline
        // flow always wins. Both paths still cross-check ownership.
        const topLevelApplicationId = parsed.data.applicationId?.trim() || null;
        const applicationId = autoLinkApplicationId ?? topLevelApplicationId;
        // Defensive: ownership check for the LEGACY top-level applicationId.
        // (The picker path's `autoLinkApplicationId` was already ownership-
        // gated above with cross-user 404 semantics.)
        if (applicationId && applicationId === topLevelApplicationId && autoLinkApplicationId === null) {
            const ownedApp = await prisma.application.findFirst({
                where: { id: applicationId, userId },
                select: { id: true },
            });
            if (!ownedApp) {
                return NextResponse.json(
                    { error: "applicationId references an application that isn't yours", stage: "input" },
                    { status: 400 },
                );
            }
        }
        let resumeId = "";
        try {
            const row = await prisma.generatedResume.create({
                data: {
                    userId,
                    applicationId,
                    // M8.4.2 — persist the parsed title + company alongside the
                    // existing X-Resume-Title / X-Resume-Company response
                    // headers. Drives the previous-resumes dropdown UI (M8.4.6).
                    postingTitle: posting.title,
                    postingCompany: posting.company,
                    postingInput: JSON.stringify({
                        url: parsed.data.posting.url ?? null,
                        text: parsed.data.posting.text ? parsed.data.posting.text.slice(0, 4_000) : null,
                        sourceUrl: posting.sourceUrl,
                        title: posting.title,
                        company: posting.company,
                        parsedKeywords: posting.keywords,
                    }),
                    profileSnapshot: JSON.stringify(profile),
                    selections: JSON.stringify(flat.map(s => ({
                        kind: s.kind,
                        sourceId: s.sourceId,
                        sourceLabel: s.sourceLabel,
                        bulletId: s.bulletId,
                        originalText: s.originalText,
                        rewrittenText: rewrites.find(r => r.id === s.bulletId)?.rewrittenText ?? s.originalText,
                        score: Number.isFinite(s.score) ? s.score : -1, // Infinity serializes as null
                        matchedTags: s.matchedTags,
                        matchedKeywords: s.matchedKeywords,
                        locked: s.locked,
                        // M8.6.4 — preserve synth-source marker so the trace
                        // UI (and any downstream readers) can render
                        // scratchpad-synthesized rows distinctly. Omitted
                        // entirely on regular selected rows so the existing
                        // archives parse unchanged.
                        ...(s.synthSource ? { synthSource: s.synthSource } : {}),
                    }))),
                    skillsGap: JSON.stringify(skillsGap.missing),
                    templateKey: parsed.data.options?.template ?? "ats-plain",
                    format,
                    status: "ready",
                },
                select: { id: true },
            });
            resumeId = row.id;
            // PB-9 (was RAH-14): write the file, then update the row. If the update fails
            // after a successful write, we have to roll back the file write
            // and mark the row errored — otherwise the FS accumulates orphan
            // artifacts and the row sits at status="ready" with no path, so
            // /api/resumes/[id]/download 404s while the row keeps showing up
            // in the list.
            let artifactPath: string | null = null;
            try {
                artifactPath = await writeResumeArtifact(resumeId, format, bytes);
                await prisma.generatedResume.update({
                    where: { id: resumeId },
                    data: { artifactPath },
                });
            } catch (innerErr) {
                if (artifactPath) {
                    await deleteResumeArtifact(artifactPath).catch(cleanupErr =>
                        console.warn(`[resume POST] orphan artifact cleanup failed for ${resumeId}:`, cleanupErr)
                    );
                }
                await prisma.generatedResume.update({
                    where: { id: resumeId },
                    data: {
                        status: "errored",
                        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
                    },
                }).catch(updateErr =>
                    console.warn(`[resume POST] errored-status update failed for ${resumeId}:`, updateErr)
                );
                throw innerErr;
            }
        } catch (e) {
            // Persistence is best-effort: don't fail the user's generation just
            // because we couldn't archive. The bytes go back to them either way.
            console.warn(`[resume POST] persistence failed (id=${resumeId || "<not created>"}):`, e);
        }

        // M8.4.9 (story S8.11) — emit so the global "Previous resumes" dropdown
        // on GenerateResumeCard auto-refreshes after a generate. Skip when
        // persistence failed (no row = nothing to surface).
        if (resumeId) {
            broadcastEvent({
                model: 'GeneratedResume',
                action: 'upsert',
                id: resumeId,
                timestamp: Date.now(),
            });
        }

        // PB-12 (was RAH-22): HTTP header values must be ASCII (undici's Headers throws on
        // non-Latin1 chars). LLM-extracted strings often carry em-dashes,
        // smart quotes, or accented chars that would 500 the whole response.
        const asciiHeader = (s: string | null | undefined) =>
            (s ?? "").replace(/[^\x20-\x7e]/g, "");

        return new NextResponse(new Uint8Array(bytes), {
            status: 200,
            headers: {
                "Content-Type": FORMAT_CONTENT_TYPES[format],
                "Content-Length": String(bytes.length),
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-store",
                "X-Resume-Title": asciiHeader(posting.title),
                "X-Resume-Company": asciiHeader(posting.company),
                "X-Resume-Format": format,
                ...(resumeId ? { "X-Resume-Id": resumeId } : {}),
            },
        });
    } catch (e) {
        console.error(`[resume POST] stage=${stage} error:`, e);
        if (e instanceof AIError) {
            return NextResponse.json({ error: e.message, stage, aiStage: e.stage }, { status: 502 });
        }
        const msg = e instanceof Error ? e.message : "Internal Server Error";
        return NextResponse.json({ error: msg, stage }, { status: 500 });
    }
}
