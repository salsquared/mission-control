import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { computeResumeDiff, type ResumeForDiff, type StoredSelection } from "@/lib/resumes/diff";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function safeJSON(s: string | null): unknown {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

function asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
}

// Per-row tolerant parse — we don't want a single bad legacy column to 500
// the whole diff. Missing fields default to empty arrays / null.
function asStoredSelections(v: unknown): StoredSelection[] {
    if (!Array.isArray(v)) return [];
    const out: StoredSelection[] = [];
    for (const raw of v) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const kind = r.kind === "workRole" || r.kind === "project" || r.kind === "education" ? r.kind : null;
        if (!kind) continue;
        if (typeof r.bulletId !== "string" || r.bulletId.length === 0) continue;
        out.push({
            kind,
            sourceId: typeof r.sourceId === "string" ? r.sourceId : "",
            sourceLabel: typeof r.sourceLabel === "string" ? r.sourceLabel : "",
            bulletId: r.bulletId,
            originalText: typeof r.originalText === "string" ? r.originalText : "",
            rewrittenText: typeof r.rewrittenText === "string" ? r.rewrittenText : "",
            score: typeof r.score === "number" ? r.score : -1,
            matchedTags: asStringArray(r.matchedTags),
            matchedKeywords: asStringArray(r.matchedKeywords),
            locked: r.locked === true,
        });
    }
    return out;
}

interface RawRow {
    id: string;
    createdAt: Date;
    applicationId: string | null;
    postingInput: string;
    selections: string;
    skillsGap: string | null;
    userId: string;
}

function hydrate(row: RawRow): ResumeForDiff {
    const posting = safeJSON(row.postingInput) as Record<string, unknown> | null;
    return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        applicationId: row.applicationId,
        company: posting && typeof posting.company === "string" ? posting.company : null,
        title: posting && typeof posting.title === "string" ? posting.title : null,
        parsedKeywords: asStringArray(posting?.parsedKeywords),
        skillsGap: asStringArray(safeJSON(row.skillsGap)),
        selections: asStoredSelections(safeJSON(row.selections)),
    };
}

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const idA = url.searchParams.get('a');
    const idB = url.searchParams.get('b');
    if (!idA || !idB) {
        return NextResponse.json({ error: "Both 'a' and 'b' query params required" }, { status: 400 });
    }
    if (idA === idB) {
        return NextResponse.json({ error: "'a' and 'b' must reference different resumes" }, { status: 400 });
    }

    try {
        // Single query for both rows, with userId in the where so cross-user
        // access can't slip through.
        const rows = await prisma.generatedResume.findMany({
            where: { id: { in: [idA, idB] }, userId },
            select: {
                id: true,
                createdAt: true,
                applicationId: true,
                postingInput: true,
                selections: true,
                skillsGap: true,
                userId: true,
            },
        });
        if (rows.length !== 2) {
            // Either one or both missing, or one owned by another user. Don't
            // leak which — single 404.
            return NextResponse.json({ error: "Resume not found" }, { status: 404 });
        }
        const rowA = rows.find(r => r.id === idA);
        const rowB = rows.find(r => r.id === idB);
        if (!rowA || !rowB) {
            return NextResponse.json({ error: "Resume not found" }, { status: 404 });
        }

        const diff = computeResumeDiff(hydrate(rowA), hydrate(rowB));
        return NextResponse.json({ diff }, { status: 200 });
    } catch (e) {
        console.error("[resumes/diff GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
