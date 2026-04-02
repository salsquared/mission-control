import { fetchScrape } from '../../lib/fetchers/scrape-fetcher';
import { COMPANY_REGISTRY } from '../../lib/company-registry';

async function main() {
    const mistral = COMPANY_REGISTRY.find(c => c.id === 'mistral');
    
    // Testing the current config
    console.log("Testing Mistral...");
    
    // override the regex to test extracting all the next_f links
    mistral.scrapeConfig.articleRegex = /"(\/news\/[a-zA-Z0-9-]+)[\\"]/g;
    
    try {
        const results = await fetchScrape(mistral);
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
