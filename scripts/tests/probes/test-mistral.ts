/**
 * Integration test: verify the Mistral adapter is reachable and parses articles.
 * Uses the adapter as-is — to experiment with regex variants, edit
 * lib/companies/mistral.ts and re-run.
 */
import mistral from '@/lib/companies/mistral';

async function main() {
    console.log(`Fetching from ${mistral.name}...`);
    try {
        const results = await mistral.fetch();
        console.log(`Found ${results.length} articles!`);
        for (const item of results) {
            console.log(`- [${item.published_at}] ${item.title}`);
            console.log(`  Url: ${item.url}`);
            console.log(`  Img: ${item.image_url || 'N/A'}`);
        }
    } catch (e) {
        console.error(e);
    }
}

main();
