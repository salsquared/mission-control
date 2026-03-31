/**
 * Integration test: verify the Meta AI custom fetcher from the registry
 */
import { COMPANY_REGISTRY } from '../../lib/company-registry';

async function main() {
    const meta = COMPANY_REGISTRY.find(c => c.id === 'meta');
    if (!meta?.customFetcher) {
        console.error('Meta AI custom fetcher not found in registry');
        process.exit(1);
    }

    console.log(`Strategy: ${meta.strategy}`);
    console.log(`Fetching...`);

    const articles = await meta.customFetcher();
    console.log(`\nTotal: ${articles.length} articles\n`);
    articles.forEach((a, i) => {
        const date = new Date(a.published_at);
        console.log(`${i + 1}. ${date.toLocaleDateString().padEnd(15)} | ${a.title.substring(0, 75)}`);
        console.log(`   ${a.url}`);
        console.log(`   img: ${a.image_url ? 'YES' : 'NO'}`);
    });

    // Validate
    const hasValidDates = articles.every(a => !isNaN(new Date(a.published_at).getTime()));
    const allHaveUrls = articles.every(a => a.url.startsWith('https://'));
    const allHaveTitles = articles.every(a => a.title.length > 5);
    console.log(`\n✅ Valid dates: ${hasValidDates}`);
    console.log(`✅ Valid URLs: ${allHaveUrls}`);
    console.log(`✅ Valid titles: ${allHaveTitles}`);
}

main().catch(console.error);
