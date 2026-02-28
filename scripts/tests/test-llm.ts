/* eslint-disable */
import axios from 'axios';
import * as cheerio from 'cheerio';

async function testCategory(category: string) {
    try {
        const url = `https://lmarena.ai/leaderboard/${category}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = response.data;
        const $ = cheerio.load(html);

        const rows = $('table').first().find('tbody tr');
        const allModels: any[] = [];

        rows.each((i, row) => {
            if (i > 1) return; // just test the first 2

            const cells = $(row).find('td');
            if (cells.length >= 5) {
                const rank = parseInt($(cells[0]).text().trim(), 10);
                const modelNameNode = $(cells[2]).find('a[title]').first();
                const modelName = modelNameNode.attr('title')?.trim() || modelNameNode.text().trim() || $(cells[2]).text().trim();
                const eloScore = parseInt($(cells[3]).text().trim().replace(/,/g, ''), 10);
                const votes = parseInt($(cells[4]).text().trim().replace(/,/g, ''), 10);

                allModels.push({ rank, modelName, eloScore, votes });
            }
        });
        console.log(`Parsed ${category}:`, JSON.stringify(allModels, null, 2));

    } catch (error) {
        console.error(`Error for ${category}`, error);
    }
}

async function run() {
    await testCategory('text');
    await testCategory('code');
    await testCategory('vision');
}
run();
