import { rssAdapter } from './factories';

// Re-uses Intel's main RSS. Could add keyword filtering later.
export default rssAdapter({
    id: 'intel-foundry',
    name: 'Intel Foundry',
    view: 'ai',
    category: 'Foundries',
    rssUrl: 'https://newsroom.intel.com/feed',
});
