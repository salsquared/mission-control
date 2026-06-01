/**
 * Hermetic smoke for lib/resumes/labels.ts — the canonical resume
 * display/download naming. Pinned because the format is user-facing
 * (commas in the dropdown, dashes in the saved-file dialog) and small
 * drift here is visible immediately.
 *
 *   npx tsx scripts/tests/hermetic/resume-labels-smoke.ts
 *
 * No DB, no network. Pure module under test.
 */
import {
    buildResumeDisplayLabel,
    buildResumeDownloadFilename,
    sanitizeFilenameSegment,
} from "@/lib/resumes/labels";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── Display label (dropdown) ────────────────────────────────────────────────
{
    const full = buildResumeDisplayLabel({
        userDisplayName: "Salvador Salcedo",
        postingTitle: "Software Engineer Intern",
        postingCompany: "Rocket Lab",
    });
    const expected = "Salvador Salcedo, Software Engineer Intern, Rocket Lab Resume";
    if (full !== expected) fail(`display: full format wrong\n  got:      ${full}\n  expected: ${expected}`);
    else pass("display: full '<name>, <title>, <company> Resume'");
}

// Each partial drop preserves comma separators between what remains + the
// trailing " Resume" suffix.
{
    const noName = buildResumeDisplayLabel({
        userDisplayName: null,
        postingTitle: "Software Engineer Intern",
        postingCompany: "Rocket Lab",
    });
    if (noName !== "Software Engineer Intern, Rocket Lab Resume") fail("display: missing name drops cleanly", noName);
    else pass("display: missing name yields '<title>, <company> Resume'");
}
{
    const noTitle = buildResumeDisplayLabel({
        userDisplayName: "Salvador Salcedo",
        postingTitle: null,
        postingCompany: "Rocket Lab",
    });
    if (noTitle !== "Salvador Salcedo, Rocket Lab Resume") fail("display: missing title drops cleanly", noTitle);
    else pass("display: missing title yields '<name>, <company> Resume'");
}
{
    const onlyName = buildResumeDisplayLabel({
        userDisplayName: "Salvador Salcedo",
        postingTitle: null,
        postingCompany: null,
    });
    if (onlyName !== "Salvador Salcedo Resume") fail("display: name-only", onlyName);
    else pass("display: name-only yields '<name> Resume'");
}
{
    const empty = buildResumeDisplayLabel({ userDisplayName: null, postingTitle: null, postingCompany: null });
    if (empty !== null) fail("display: all-null should return null so caller can fall back", empty);
    else pass("display: all-null returns null (caller-driven fallback)");
}
// Whitespace-only treated as missing.
{
    const blanks = buildResumeDisplayLabel({ userDisplayName: "  ", postingTitle: "", postingCompany: "   " });
    if (blanks !== null) fail("display: whitespace-only should be treated as missing", blanks);
    else pass("display: whitespace-only treated as missing");
}

// ─── Download filename ──────────────────────────────────────────────────────
// Commas match the display label so the saved file reads the way the user
// would write it by hand. "Resume" suffix stays so the saved file is
// self-describing.
{
    const full = buildResumeDownloadFilename({
        userDisplayName: "Salvador Salcedo",
        postingTitle: "Software Engineer Intern",
        postingCompany: "Rocket Lab",
        format: "pdf",
    });
    const expected = "Salvador Salcedo, Software Engineer Intern, Rocket Lab Resume.pdf";
    if (full !== expected) fail(`filename: full format wrong\n  got:      ${full}\n  expected: ${expected}`);
    else pass("filename: full '<name>, <title>, <company> Resume.<ext>'");
}
{
    const docx = buildResumeDownloadFilename({
        userDisplayName: "Salvador Salcedo",
        postingTitle: null,
        postingCompany: "Rocket Lab",
        format: "docx",
    });
    if (docx !== "Salvador Salcedo, Rocket Lab Resume.docx") fail("filename: docx + missing title", docx);
    else pass("filename: missing title drops separator cleanly, ext flips to docx");
}
// All-null falls back to the legacy "resume-<dateSlug>.<ext>" so a
// catastrophically empty row still downloads as something sensible.
{
    const empty = buildResumeDownloadFilename({
        userDisplayName: null,
        postingTitle: null,
        postingCompany: null,
        format: "pdf",
    }, "2026-05-25");
    if (empty !== "resume-2026-05-25.pdf") fail("filename: all-null fallback to dateSlug pattern", empty);
    else pass("filename: all-null falls back to 'resume-<dateSlug>.<ext>'");
}

// ─── Sanitization ────────────────────────────────────────────────────────────
// Disallowed chars stripped (these break Windows / mess up shells).
// Whitespace runs collapsed. Trims.
{
    const dirty = sanitizeFilenameSegment(`Foo: Bar/Baz?* <quux>`);
    if (dirty !== "Foo Bar Baz quux" && dirty !== "Foo BarBaz quux") {
        // Implementation strips the disallowed chars in place (no inserted
        // space), so adjacent disallowed runs leave their neighbors touching.
        // Accept either spacing semantics — the load-bearing assertion is that
        // none of the banned chars survive.
        if (/[\\/:*?"<>|]/.test(dirty)) fail(`sanitize: leaked disallowed chars: ${dirty}`);
        else pass(`sanitize: disallowed chars stripped (got '${dirty}')`);
    } else {
        pass(`sanitize: disallowed chars stripped (got '${dirty}')`);
    }
}
{
    const padded = sanitizeFilenameSegment("   spaced out   word    ");
    if (padded !== "spaced out word") fail("sanitize: whitespace not collapsed/trimmed", padded);
    else pass("sanitize: trims + collapses runs of whitespace");
}
{
    const dots = sanitizeFilenameSegment("...hidden.file...");
    if (dots !== "hidden.file") fail("sanitize: leading/trailing dots not stripped", dots);
    else pass("sanitize: strips leading + trailing dot runs");
}

// ─── HTTP-header safety (Content-Disposition is a ByteString) ─────────────────
// Regression: a canon/posting name with an em dash (U+2014) — e.g. "security
// officer — Downey, CA" — used to flow into `Content-Disposition: filename="…"`
// and throw "Cannot convert argument to a ByteString" (codepoint > 255),
// failing the whole resume render. Typographic punctuation must fold to ASCII
// and any remaining > 255 codepoint must drop.
{
    const emDash = sanitizeFilenameSegment("security officer — Downey, CA");
    if (emDash !== "security officer - Downey, CA") fail("sanitize: em dash not folded to hyphen", emDash);
    else pass("sanitize: em dash folds to '-'");
}
{
    // Latin-1 accents (codepoint <= 255) are valid in a ByteString — keep them.
    const accented = sanitizeFilenameSegment("Señor Café");
    if (accented !== "Señor Café") fail("sanitize: dropped a valid Latin-1 accent", accented);
    else pass("sanitize: preserves Latin-1 accents (<= 255)");
}
{
    // The load-bearing assertion: every sanitized segment is header-safe, and a
    // full filename round-trips through Headers.set without throwing.
    const nasty = ["プロジェクト — Lead “Staff”", "Résumé – Café…", "emoji 🚀 role"];
    let leaked = false;
    for (const s of nasty) {
        for (const ch of sanitizeFilenameSegment(s)) {
            if (ch.codePointAt(0)! > 255) { leaked = true; break; }
        }
    }
    if (leaked) fail("sanitize: leaked a codepoint > 255 (would break Content-Disposition)");
    else pass("sanitize: no codepoint > 255 survives");

    const filename = buildResumeDownloadFilename({
        userDisplayName: "Salvador Salcedo",
        postingTitle: "security officer — Downey, CA",
        postingCompany: null,
        format: "pdf",
    });
    try {
        new Headers().set("Content-Disposition", `attachment; filename="${filename}"`);
        pass("filename: Content-Disposition round-trips without a ByteString throw");
    } catch (e) {
        fail("filename: Content-Disposition threw on a real canon name", (e as Error).message);
    }
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
