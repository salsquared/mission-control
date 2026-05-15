import * as cheerio from "cheerio";
import { z } from "zod";
import { chatJSON } from "@/lib/ai/gemini";
import { assertExternalHttpUrl, assertSafeResponseUrl } from "@/lib/security/url-guard";

export interface PostingInput {
    url?: string;
    text?: string;
}

export interface ParsedPosting {
    title: string | null;
    company: string | null;
    location: string | null;
    seniority: string | null;
    rawText: string;
    sourceUrl: string | null;
    keywords: string[];
}

const PostingExtractSchema = z.object({
    title: z.string().nullable(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    seniority: z.string().nullable(),
    keywords: z.array(z.string()).min(1).max(40),
});

const MAX_INPUT_CHARS = 12_000;

function clean(s: string): string {
    return s.replace(/[ \s]+/g, " ").trim();
}

async function fetchVisibleText(url: string): Promise<string> {
    assertExternalHttpUrl(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8_000);
    let res: Response;
    try {
        res = await fetch(url, {
            headers: {
                "User-Agent": "mission-control-resume-bot/1.0 (+https://mc.local)",
                "Accept": "text/html,application/xhtml+xml",
            },
            redirect: "follow",
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    // Re-check in case the redirect chain landed on an internal target.
    assertSafeResponseUrl(res);
    const html = await res.text();
    const $ = cheerio.load(html);
    // Drop noise
    $("script, style, nav, footer, header, noscript, svg").remove();
    const body = $("main, [role=main], article, body").first();
    const text = clean(body.length ? body.text() : $.root().text());
    return text.slice(0, MAX_INPUT_CHARS);
}

export async function parsePosting(input: PostingInput): Promise<ParsedPosting> {
    let rawText = "";
    let sourceUrl: string | null = null;

    if (input.url && input.url.trim().length > 0) {
        sourceUrl = input.url.trim();
        rawText = await fetchVisibleText(sourceUrl);
    }
    if (input.text && input.text.trim().length > 0) {
        rawText = clean(input.text).slice(0, MAX_INPUT_CHARS);
    }
    if (rawText.length < 30) {
        throw new Error("Posting input is empty or too short — provide a URL or paste the listing text.");
    }

    const extracted = await chatJSON({
        system:
            "You extract structured signals from job postings to drive resume tailoring. " +
            "Be conservative — if a field is not clearly stated, return null. " +
            "Keywords should be the 10–25 most load-bearing terms a hiring manager would scan for: " +
            "specific technologies, methodologies, seniority markers, and domain words. " +
            "Prefer short, canonical forms (e.g. 'TypeScript' not 'TypeScript 5'). " +
            "Return only JSON matching the requested shape.",
        user: [
            "Job posting text:",
            "",
            rawText,
            "",
            "Return JSON with these fields:",
            "- title: the role title, or null",
            "- company: the hiring company, or null",
            "- location: the role's location (city/remote), or null",
            "- seniority: the seniority indicator (e.g. 'Intern', 'Junior', 'Senior', 'Staff'), or null",
            "- keywords: array of 10–25 short keyword strings",
        ].join("\n"),
        schema: PostingExtractSchema,
        temperature: 0.2,
    });

    return {
        title: extracted.title,
        company: extracted.company,
        location: extracted.location,
        seniority: extracted.seniority,
        rawText,
        sourceUrl,
        keywords: extracted.keywords,
    };
}
