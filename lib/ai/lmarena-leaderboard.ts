import * as cheerio from 'cheerio';

/**
 * Parser for the lmarena.ai (LMSYS Chatbot Arena) leaderboard pages.
 *
 * Lives outside the route so the pre-push hermetic smoke
 * (scripts/tests/hermetic/llm-leaderboard-parse-smoke.ts) can exercise it
 * against fixture HTML — route files can't export helpers (Next.js
 * validates route-module exports).
 *
 * Table layout as of the 2026-07 redesign:
 *   td[0] Rank · td[1] Rank Spread · td[2] Model · td[3] Score · td[4] Votes
 *   (· td[5] Price · td[6] Context on some categories)
 * The Model cell holds an org logo <svg><title>Org</title> (title absent on
 * some categories), the model name in a <span title="..."> — or an
 * <a title="..."> when the row links out (image categories) — and a
 * "Org · License" subtitle span. Score reads "1509±9"; parseInt stops at ±.
 */

export interface LeaderboardModel {
    id: string;
    rank: number;
    name: string;
    orgName: string;
    license?: string;
    eloScore: number;
    votes: number;
}

const orgMapping: Record<string, string> = {
    'gemini': 'Google',
    'grok': 'xAI',
    'gpt': 'OpenAI',
    'claude': 'Anthropic',
    'llama': 'Meta',
    'qwen': 'Alibaba',
    'mistral': 'Mistral AI',
    'dola': 'Bytedance',
    'deepseek': 'DeepSeek',
    'command': 'Cohere'
};

function resolveOrgName(modelName: string, parsedOrg: string): string {
    if (parsedOrg && parsedOrg !== 'Unknown') return parsedOrg;
    const lowerName = modelName.toLowerCase();
    for (const [key, org] of Object.entries(orgMapping)) {
        if (lowerName.includes(key)) {
            return org;
        }
    }
    return '';
}

export function parseLmarenaLeaderboard(html: string, sourceUrl?: string): LeaderboardModel[] {
    const $ = cheerio.load(html);

    // Find the first table body which contains the main overall leaderboard
    const rows = $('table').first().find('tbody tr');
    let allModels: LeaderboardModel[] = [];

    rows.each((i, row) => {
        // Avoid parsing too many, just get the top 80 to return the top 50
        if (i > 80) return;

        const cells = $(row).find('td');
        if (cells.length < 5) return;

        const rankText = $(cells[0]).text().trim();
        const rank = parseInt(rankText, 10);

        const modelCell = $(cells[2]);

        // Model name: <a title> (linked rows) or <span title> (linkless rows).
        const modelNameNode = modelCell.find('a[title], span[title]').first();
        let modelName = modelNameNode.attr('title')?.trim() || modelNameNode.text().trim();

        // "Org · License" subtitle span. The license is the part after the
        // separator; the org half doubles as a fallback when the logo svg
        // carries no <title> (image categories).
        let subtitleOrg = '';
        let license = '';
        modelCell.find('span').each((_, el) => {
            if (license) return;
            const node = $(el);
            if (node.attr('title') || node.find('span').length > 0) return; // leaf, non-name spans only
            const text = node.text().trim();
            const sep = text.indexOf('·');
            if (sep === -1) return;
            subtitleOrg = text.slice(0, sep).trim();
            license = text.slice(sep + 1).trim();
        });

        // Fallback: first leaf span that isn't the subtitle. The raw cell
        // text is no longer usable — it mashes org + name + subtitle.
        if (!modelName) {
            modelCell.find('span').each((_, el) => {
                if (modelName) return;
                const node = $(el);
                if (node.find('span').length > 0) return;
                const text = node.text().trim();
                if (text && !text.includes('·')) modelName = text;
            });
        }

        // Extract organization name. NOTE (P1.3/OQ3b): we deliberately
        // do NOT ship the scraped <svg> markup — raw HTML from a
        // third-party page injected via dangerouslySetInnerHTML was an
        // XSS vector. The card renders a local-logo/initials badge
        // from orgName instead.
        const svgNode = modelCell.find('svg').first();
        let orgName = svgNode.find('title').text() || subtitleOrg || 'Unknown';

        orgName = resolveOrgName(modelName, orgName);

        const scoreText = $(cells[3]).text().trim().replace(/,/g, '');
        const votesText = $(cells[4]).text().trim().replace(/,/g, '');

        const eloScore = parseInt(scoreText, 10);
        const votes = parseInt(votesText, 10);

        if (modelName && !isNaN(eloScore)) {
            allModels.push({
                id: modelName,
                rank: isNaN(rank) ? 999 : rank,
                name: modelName,
                orgName: orgName,
                license: license || undefined,
                eloScore: eloScore,
                votes: votes
            });
        }
    });

    // Dedupe by id. lmarena.ai's leaderboard page sometimes lists the
    // same model in multiple stacked sub-leaderboards (overall +
    // filtered views) inside the same <tbody> we scrape, which would
    // otherwise produce duplicate React keys downstream. Keep the
    // highest-Elo occurrence per id so the result is deterministic
    // regardless of source ordering. Logs once per crawl when the
    // page yields duplicates so future structural changes upstream
    // are visible in the in-app log viewer.
    const beforeDedupe = allModels.length;
    const byId = new Map<string, LeaderboardModel>();
    for (const m of allModels) {
        const prev = byId.get(m.id);
        if (!prev || m.eloScore > prev.eloScore) byId.set(m.id, m);
    }
    allModels = Array.from(byId.values());
    if (allModels.length < beforeDedupe) {
        console.warn(`[LLM LEADERBOARD] deduped ${beforeDedupe - allModels.length} duplicate rows from ${sourceUrl ?? 'lmarena.ai'}`);
    }

    // Sort descending by ELO Score just to be safe
    allModels.sort((a, b) => b.eloScore - a.eloScore);

    // Take Top 50
    return allModels.slice(0, 50);
}
