import cerebras from '@/lib/companies/cerebras';

async function main() {
    const articles = await cerebras.fetch();
    console.log(JSON.stringify(articles.slice(0, 3), null, 2));
    console.log(`Total Articles Fetched: ${articles.length}`);
}
main().catch(console.error);
