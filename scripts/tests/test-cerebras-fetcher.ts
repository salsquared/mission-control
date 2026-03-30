import { COMPANY_REGISTRY } from '../../lib/company-registry';

async function main() {
  const cerebras = COMPANY_REGISTRY.find(c => c.id === 'cerebras');
  if (cerebras?.customFetcher) {
    const articles = await cerebras.customFetcher();
    console.log(JSON.stringify(articles.slice(0, 3), null, 2));
    console.log(`Total Articles Fetched: ${articles.length}`);
  } else {
    console.error('Cerebras custom fetcher not found');
  }
}
main().catch(console.error);
