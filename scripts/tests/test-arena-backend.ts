import * as cheerio from 'cheerio';
import fs from 'fs';

function extract() {
    const html = fs.readFileSync('lmarena_dump.txt', 'utf-8');
    const $ = cheerio.load(html);

    // Look for script tags
    let found = false;
    $('script').each((i, script) => {
        const text = $(script).html() || '';
        if (text.includes('window.gradio_config')) {
            console.log("Found window.gradio_config length:", text.length);
            found = true;
            // Let's try to extract it
            try {
                const match = text.match(/window\.gradio_config\s*=\s*(.*);/);
                if (match && match[1]) {
                    const config = JSON.parse(match[1]);
                    console.log("Config keys:", Object.keys(config));
                }
            } catch (e) {
                console.log("Error parsing");
            }
        }
    });

    if (!found) {
        console.log("No window.gradio_config found");
    }
}
extract();
