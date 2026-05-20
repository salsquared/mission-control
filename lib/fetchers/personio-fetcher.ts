/**
 * Personio public XML feed fetcher.
 *
 * https://<slug>.jobs.personio.com/xml — Personio's standard career-page XML.
 * No auth, no pagination. Root <workzag-jobs> with <position> children.
 *
 * The XML doesn't carry a per-position URL, but Personio's career page uses
 * the canonical `<slug>.jobs.personio.com/job/<id>` permalink for each
 * position — that's what we surface as sourceUrl.
 *
 * Errors are returned, not thrown.
 */
import * as cheerio from "cheerio";
import type { z } from "zod";
import type { PersonioConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { pickEmploymentType } from "./employment-type";

type PersonioConfig = z.infer<typeof PersonioConfigSchema>;

const FETCH_TIMEOUT_MS = 8_000;
const MAX_POSITIONS = 500; // bound the parse — defends against pathological feeds

// Personio's <schedule> field is the closest signal we have to our
// EmploymentType taxonomy. <employmentType> is "permanent"/"temporary"/etc.
// (contract duration), which we surface in the snippet but don't lean on for
// classification.
function personioEmploymentLabel(schedule: string | null): string | null {
    if (!schedule) return null;
    const s = schedule.toLowerCase().trim();
    if (s === "full-time" || s === "fulltime") return "Full-time";
    if (s === "part-time" || s === "parttime") return "Part-time";
    if (s === "internship") return "Internship";
    return null;
}

export async function fetchPersonio(config: PersonioConfig): Promise<FetcherResult> {
    const url = `https://${encodeURIComponent(config.boardSlug)}.jobs.personio.com/xml`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let xml: string;
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "mission-control-watcher/1.0 (+https://mc.local; personal job-search agent)",
                "Accept": "application/xml, text/xml",
            },
            signal: controller.signal,
            redirect: "manual",
        });
        clearTimeout(timeoutId);
        // Personio redirects unknown slugs to personio.com — treat as not-found.
        if (res.status >= 300 && res.status < 400) {
            return { ok: false, error: `Unknown Personio slug (HTTP ${res.status} redirect from ${url})` };
        }
        if (!res.ok) {
            return { ok: false, error: `HTTP ${res.status} ${res.statusText} from ${url}` };
        }
        xml = await res.text();
    } catch (e) {
        clearTimeout(timeoutId);
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Fetch failed: ${msg}` };
    }

    let $: cheerio.CheerioAPI;
    try {
        $ = cheerio.load(xml, { xml: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `XML parse failed: ${msg}` };
    }

    // Sanity-check the root.
    if ($("workzag-jobs").length === 0) {
        return { ok: false, error: "Unexpected Personio response shape: missing <workzag-jobs> root" };
    }

    const postings: RawPosting[] = [];
    $("workzag-jobs > position").slice(0, MAX_POSITIONS).each((_, el) => {
        const $p = $(el);
        const id = $p.children("id").text().trim();
        const name = $p.children("name").text().trim();
        if (!id || !name) return;
        const office = $p.children("office").text().trim();
        const additional = $p.find("additionalOffices > office").map((_, o) => $(o).text().trim()).get();
        const department = $p.children("department").text().trim() || null;
        const schedule = $p.children("schedule").text().trim() || null;
        const employmentType = $p.children("employmentType").text().trim() || null;
        const seniority = $p.children("seniority").text().trim() || null;
        const locationParts = [office, ...additional].filter(s => s.length > 0);
        const location = locationParts.length > 0 ? locationParts.join(" / ") : null;
        const employmentLabel = personioEmploymentLabel(schedule);
        const snippetParts = [department, employmentLabel ?? schedule, employmentType, seniority]
            .filter((s): s is string => Boolean(s));
        postings.push({
            company: config.companyName,
            title: name,
            sourceUrl: `https://${config.boardSlug}.jobs.personio.com/job/${encodeURIComponent(id)}`,
            location,
            snippet: snippetParts.join(" · ") || null,
            employmentType: pickEmploymentType(employmentLabel, name),
        });
    });

    return { ok: true, postings };
}
