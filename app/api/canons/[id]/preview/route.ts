import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getCanon, getCanonSelection } from "@/lib/repositories/canons";
import { findOrCreateProfile } from "@/lib/repositories/profile";
import { resolveSelection, resolveExtras } from "@/lib/canons/selection";
import { composeResumeProps } from "@/lib/resumes/templates/ats-plain";
import { renderResumeHTML, decorateResumePreview } from "@/lib/resumes/render-html";
import { renderResumePDF } from "@/lib/resumes/render-pdf";
import { countPdfPages } from "@/lib/resumes/one-page";
import type { SectionKey } from "@/lib/resumes/tagline-tailor";
import type { ProfileWire } from "@/lib/schemas/profile";

export const runtime = "nodejs";

// On-screen HTML preview of a Canon's manual resume selection
// (docs/archive/resume-manual-builder.html). Opened in a new tab by the
// builder's Generate AND the card's Re-render, so links ("Repo" / "Website" /
// contact) open in their own tab — the PDF render can't do that (Chrome's PDF
// viewer ignores target=_blank). Rendered VERBATIM (no AI rewrite/tagline) to
// match the builder's default; the persisted PDF/DOCX artifact is the
// authoritative output. This is a read-only GET — it NEVER persists a resume
// version (Re-render must not count as a generation; only the Generate buttons
// create versions). It shows a page-fit banner from the exact PDF page count,
// taken from `?pages=` when the caller already has it (Generate) or rendered
// here on demand when not (Re-render).

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    try {
        const canon = await getCanon(userId, id);
        if (!canon) return NextResponse.json({ error: "Canon not found" }, { status: 404 });

        const selection = await getCanonSelection(userId, id);
        if (!selection) {
            return NextResponse.json(
                { error: "This canon has no saved selection yet — open the builder and curate it first." },
                { status: 400 },
            );
        }

        // Mirror generateCanonManualResume's verbatim composition (rewrite +
        // tagline off): resolve against the live profile, filter toggled-off
        // sections, intersect extras with the profile.
        const hydrated = await findOrCreateProfile(userId);
        const profile = JSON.parse(JSON.stringify(hydrated)) as ProfileWire;
        const resolved = resolveSelection(profile, selection);
        const off = new Set(selection.sectionsOff);
        const sectionOrder = selection.sectionOrder.filter((s) => !off.has(s)) as SectionKey[];
        const extras = resolveExtras(profile, selection);
        const props = composeResumeProps(profile, resolved, [], profile.tagline ?? null, extras, sectionOrder);

        // Page-fit banner count. `?pages=N` is the exact count the caller already
        // has from a just-rendered PDF (the builder's Generate reads it off the
        // X-Resume-Pages header) — use it and skip a redundant render. Absent
        // (the card's Re-render opens the preview directly, with NO generation
        // so it never creates a version) → render the PDF here just to count
        // pages. Best-effort: a render failure leaves the banner neutral rather
        // than breaking the preview. NOTHING here persists — this is a pure GET.
        const pagesParam = req.nextUrl.searchParams.get("pages");
        let pageCount: number | null = null;
        if (pagesParam && /^\d+$/.test(pagesParam)) {
            pageCount = parseInt(pagesParam, 10);
        } else {
            try {
                pageCount = await countPdfPages(await renderResumePDF(props));
            } catch (e) {
                console.warn(`[canons/${id}/preview] page-count render failed:`, e);
            }
        }
        const html = decorateResumePreview(await renderResumeHTML(props), pageCount);

        return new NextResponse(html, {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "private, no-store, max-age=0",
            },
        });
    } catch (e) {
        console.error(`[canons/${id}/preview GET] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
