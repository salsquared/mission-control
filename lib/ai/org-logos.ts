import * as fs from 'fs';
import * as path from 'path';
import { extractOrgLogoSvgs } from '@/lib/ai/lmarena-leaderboard';
import { orgSlug } from '@/lib/ai/org-slug';

/**
 * Automatic org-logo harvesting for the LLM leaderboard card.
 *
 * P1.3/OQ3b banned shipping scraped <svg> markup into the DOM
 * (dangerouslySetInnerHTML XSS). The replacement — a hand-curated set in
 * public/logos/ — couldn't keep up with new orgs appearing on lmarena
 * (they fell back to an initials badge forever). This module closes that
 * gap while keeping the invariant "scraped markup never renders inline":
 * on each leaderboard scrape, any org WITHOUT a logo file yet gets its
 * icon sanitized and written to public/logos/auto/ (gitignored), served
 * statically and rendered via <img> — an execution-free context — with a
 * scoped CSP in next.config.ts as the final backstop for direct
 * navigation. Curated files in public/logos/ always win over harvested
 * ones (the card checks its ORG_LOGOS map first).
 *
 * Best-effort throughout: any failure is logged and swallowed — logos are
 * cosmetic and must never break the leaderboard route.
 */

const CURATED_DIR = path.join(process.cwd(), 'public', 'logos');
const AUTO_DIR = path.join(CURATED_DIR, 'auto');

// An org icon is a small inline path drawing; anything bigger is suspect.
const MAX_SVG_BYTES = 100 * 1024;

// Disk bounds: a hostile/compromised upstream page could mint one file per
// fake org name per harvest tick. Real pages carry a few dozen orgs, so cap
// writes per harvest AND refuse to grow the auto dir past a hard ceiling —
// the pipeline is cosmetic and must never become a disk-fill primitive.
const MAX_FILES_PER_HARVEST = 25;
const MAX_AUTO_DIR_FILES = 300;

// Real threats for markup that will be served from our origin: scripts,
// event handlers, foreignObject, nested documents, styles, SMIL animation
// (a <set>/<animate> targeting attributeName="href" can assemble a
// javascript: URL out of whitespace-split pieces — org icons never
// animate, so reject the whole element class), and EXTERNAL references.
// Local fragment refs (gradients/clipPaths: url(#...), href="#...") are
// safe and common in brand icons.
const FORBIDDEN = /<script|\bon[a-z]+\s*=|foreignObject|javascript:|<image|<style|<animate|<set\b|url\((?!['"]?#)|href\s*=\s*"(?!#)/i;

// Browsers strip ASCII control chars/whitespace from URL schemes, so
// "java\nscript:" dispatches as javascript: — test a stripped copy too.
function hasSplitJavascriptScheme(svg: string): boolean {
    return /javascript:/i.test(svg.replace(/[\x00-\x20]/g, ''));
}

/**
 * Turn a scraped inline <svg> into a safe standalone file. Returns null
 * when the markup contains anything from FORBIDDEN — reject, never repair.
 * The site themes its icons with CSS classes (`fill-black dark:fill-white`)
 * and currentColor, neither of which works in a standalone file, so color
 * is normalized to white (the card always sits on a dark background).
 */
export function sanitizeOrgSvg(svg: string): string | null {
    if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) return null;
    let out = svg;
    out = out.replace(/\sclass="[^"]*"/g, '');
    out = out.replace(/<title>[\s\S]*?<\/title>/g, '');
    if (FORBIDDEN.test(out) || hasSplitJavascriptScheme(out)) return null;
    out = out.replace(/currentColor/g, '#FFFFFF');
    out = out.replace(/(fill|stroke)="(black|#000|#000000)"/gi, '$1="#FFFFFF"');
    // Icons that relied on a CSS class for color (class now stripped) have
    // no usable paint left: no non-none fill and no stroke anywhere. Force
    // white, REPLACING a root fill="none" — a second fill attribute would
    // make the file invalid XML and <img> parses svg strictly.
    if (!/fill="(?!none)/.test(out) && !/stroke="/.test(out)) {
        out = /<svg[^>]*fill="none"/.test(out)
            ? out.replace(/(<svg[^>]*?)fill="none"/, '$1fill="#FFFFFF"')
            : out.replace(/<svg/, '<svg fill="#FFFFFF"');
    }
    // Standalone svg files need the namespace; inline markup often omits it.
    if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(out)) {
        out = out.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return out;
}

export interface HarvestOptions {
    /** Debounce key (the leaderboard category). */
    category?: string;
    /** Min ms between harvests per category. Default 1h; tests pass 0. */
    minIntervalMs?: number;
    /** Override output dir (tests). Default public/logos/auto. */
    autoDir?: string;
    /** Override curated dir (tests). Default public/logos. */
    curatedDir?: string;
}

const lastHarvestAt = new Map<string, number>();

/**
 * Fire-and-forget from the leaderboard route: write a sanitized logo file
 * for every org on the page that doesn't have one yet (curated or
 * previously harvested). Returns the slugs written (for tests/logging).
 */
export async function harvestOrgLogos(html: string, opts: HarvestOptions = {}): Promise<string[]> {
    const written: string[] = [];
    try {
        const category = opts.category ?? 'default';
        const minInterval = opts.minIntervalMs ?? 60 * 60 * 1000;
        const last = lastHarvestAt.get(category) ?? 0;
        if (Date.now() - last < minInterval) return written;
        lastHarvestAt.set(category, Date.now());

        // Yield before the (second) cheerio parse of a ~2MB page so the
        // route's response isn't delayed by fire-and-forget work.
        await new Promise((resolve) => setImmediate(resolve));

        const autoDir = opts.autoDir ?? AUTO_DIR;
        const curatedDir = opts.curatedDir ?? CURATED_DIR;
        const orgSvgs = extractOrgLogoSvgs(html);
        if (orgSvgs.size === 0) return written;
        await fs.promises.mkdir(autoDir, { recursive: true });

        const existingCount = (await fs.promises.readdir(autoDir)).length;
        if (existingCount >= MAX_AUTO_DIR_FILES) {
            console.warn(`[LLM LEADERBOARD] auto-logo dir at cap (${existingCount} files) — harvesting disabled until pruned`);
            return written;
        }

        for (const [org, rawSvg] of orgSvgs) {
            if (written.length >= MAX_FILES_PER_HARVEST || existingCount + written.length >= MAX_AUTO_DIR_FILES) {
                console.warn(`[LLM LEADERBOARD] logo harvest cap hit (${written.length} written) — remaining orgs deferred to a later tick`);
                break;
            }
            try {
                const slugName = orgSlug(org);
                if (!slugName) continue;
                const file = `${slugName}.svg`;
                if (fs.existsSync(path.join(curatedDir, file)) || fs.existsSync(path.join(autoDir, file))) continue;
                const clean = sanitizeOrgSvg(rawSvg);
                if (!clean) {
                    console.warn(`[LLM LEADERBOARD] logo for new org "${org}" failed sanitization — initials fallback stays`);
                    continue;
                }
                // Atomic write: dev + prod tiers share this checkout and can
                // harvest concurrently; rename never exposes a partial file.
                const tmp = path.join(autoDir, `.${file}.tmp-${process.pid}`);
                await fs.promises.writeFile(tmp, clean + '\n', 'utf8');
                await fs.promises.rename(tmp, path.join(autoDir, file));
                written.push(slugName);
            } catch (err) {
                console.warn(`[LLM LEADERBOARD] failed to harvest logo for "${org}":`, err);
            }
        }
        if (written.length > 0) {
            console.info(`[LLM LEADERBOARD] harvested ${written.length} new org logo(s): ${written.join(', ')}`);
        }
    } catch (err) {
        console.warn('[LLM LEADERBOARD] logo harvest failed:', err);
    }
    return written;
}
