/**
 * Internal list of companies we want to track but that don't fit any of our
 * supported ATS fetchers (greenhouse / lever / ashby / workday /
 * smartrecruiters / workable / recruitee / personio / linkedin /
 * careers-page). Either they self-host their careers page on a JS SPA we
 * can't scrape with a simple link-pattern regex, or they use an ATS we
 * haven't wired up yet (iCIMS, Taleo, SuccessFactors, Jobvite, etc.).
 *
 * Surface use: forensic record so we don't re-research the same company
 * multiple times, and a candidate pool for the Discover tab's "needs custom
 * integration" panel when no Gemini-suggested verified candidates surface
 * for a given topic.
 *
 * A company belongs HERE — not in `COMPANY_DIRECTORY` — when a manual probe
 * of its careers page does NOT reveal a marker for one of our wired ATSes
 * (boards-api.greenhouse.io, jobs.lever.co, api.ashbyhq.com,
 * *.wd<N>.myworkdayjobs.com, api.smartrecruiters.com, apply.workable.com,
 * *.recruitee.com, *.jobs.personio.com). If you discover a wireable signal
 * during a follow-up investigation, MOVE the entry to `COMPANY_DIRECTORY`.
 */

import type { DirectoryTag } from "./company-directory";

export interface CustomIntegrationCompany {
    name: string;
    /** One-line description. Mirrors the blurb shape used by COMPANY_DIRECTORY. */
    blurb: string;
    /** Tags reuse the directory taxonomy where they overlap. */
    tags: DirectoryTag[];
    /** Public careers page. Null only if we haven't located one yet. */
    careersUrl: string | null;
    /** Best guess at the underlying ATS / careers stack. Common values:
     *  "custom-spa", "iCIMS", "Taleo", "SuccessFactors", "Jobvite",
     *  "Paylocity". Null when we haven't investigated yet. */
    atsGuess: string | null;
    /** Why this is here instead of `COMPANY_DIRECTORY`. Should describe
     *  what blocks a normal fetcher — explicit so a future investigator
     *  doesn't redo the same dead-end probes. */
    reason: string;
}

export const CUSTOM_INTEGRATION_COMPANIES: readonly CustomIntegrationCompany[] = [
    // ─── Graduated to COMPANY_DIRECTORY (kept here as a forensic record so
    //     a future investigator doesn't redo the deep-link probe) ─────────────
    //
    //   - Relativity Space → greenhouse `relativity` (the marketing /careers
    //     SPA hides the ATS; the real listings live at /jobs which embeds
    //     greenhouse-for=relativity).
    //   - Stoke Space → greenhouse `stokespacetechnologies` (real openings
    //     live at /careers/current-openings/, not /careers).
    //   - Axiom Space → workday axiomspace.wd5.myworkdayjobs.com /
    //     External_Career_Site (probed careers page directly).
    //   - LeoLabs → greenhouse `leolabsinc` (embedded on /careers).
    //   - Firefly Aerospace → clearcompany siteId 00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5
    //     (added kind:clearcompany support, fetcher in lib/fetchers/clearcompany-fetcher.ts).
    //
    // ─── Still here ──────────────────────────────────────────────────────────
    {
        name: "Sierra Space",
        blurb: "Dream Chaser spaceplane, LIFE inflatable habitat module.",
        tags: ["space"],
        careersUrl: "https://sierraspace.com/careers",
        atsGuess: null,
        // Tried browser-realistic UA, alt subdomains (careers., jobs.),
        // sierranevadacorp.com, sierraspace.bamboohr.com — all 403 or
        // connection-refused. No reachable ATS marker from headless-curl.
        reason: "Cloudflare 403s every non-browser probe. Likely needs a real headless browser (Playwright) to render the careers page and sniff the live network calls.",
    },
];
