import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';

export const revalidate = 3600; // Cache for 1 hour

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

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const category = searchParams.get('category') || 'text';

        const url = `https://lmarena.ai/leaderboard/${category}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = response.data;
        const $ = cheerio.load(html);

        // Find the first table body which contains the main overall leaderboard
        const rows = $('table').first().find('tbody tr');
        let allModels: any[] = [];

        rows.each((i, row) => {
            // Avoid parsing too many, just get the top 80 to return the top 50
            if (i > 80) return;

            const cells = $(row).find('td');
            if (cells.length >= 5) {
                let rankText = $(cells[0]).text().trim();
                let rank = parseInt(rankText, 10);

                // Format is usually: Rank, Trend, ModelName (with org span), Score (Elo), Votes
                // Sometimes the model cell has the organization text in it, so we extract carefully
                let modelNameNode = $(cells[2]).find('a[title]').first();
                let modelName = modelNameNode.attr('title')?.trim();

                // If the title span isn't explicitly there, grab the raw text
                if (!modelName) {
                    modelName = modelNameNode.text().trim();
                }
                if (!modelName) {
                    modelName = $(cells[2]).text().trim();
                }

                // Extract organization name and logo
                const svgNode = $(cells[2]).find('svg').first();
                let orgName = svgNode.find('title').text() || 'Unknown';
                const orgLogo = $.html(svgNode) || '';

                orgName = resolveOrgName(modelName, orgName);

                let scoreText = $(cells[3]).text().trim().replace(/,/g, '');
                let votesText = $(cells[4]).text().trim().replace(/,/g, '');

                let eloScore = parseInt(scoreText, 10);
                let votes = parseInt(votesText, 10);

                if (modelName && !isNaN(eloScore)) {
                    // Extract just organization if we want, but it's hard to split perfectly without title span
                    // We'll just stick to the name. We can fake or leave organization blank if need be.
                    allModels.push({
                        id: modelName,
                        rank: isNaN(rank) ? 999 : rank,
                        name: modelName,
                        orgName: orgName,
                        orgLogo: orgLogo,
                        eloScore: eloScore,
                        votes: votes
                    });
                }
            }
        });

        // Sort descending by ELO Score just to be safe
        allModels.sort((a, b) => b.eloScore - a.eloScore);

        // Take Top 50
        allModels = allModels.slice(0, 50);

        return NextResponse.json(allModels);

    } catch (error) {
        console.error("Failed to fetch LLM leaderboard from Arena:", error);
        return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
    }
}
