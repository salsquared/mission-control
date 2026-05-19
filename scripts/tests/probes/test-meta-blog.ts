/**
 * Integration test: verify the Meta AI adapter resolves and produces valid articles.
 */
import meta from '@/lib/companies/meta';

async function main() {
    console.log(`Fetching from ${meta.name}...`);

    const articles = await meta.fetch();
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
