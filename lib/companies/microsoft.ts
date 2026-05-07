import { rssAdapter } from './factories';

// Old feed (blogs.microsoft.com/ai/feed/) was abandoned in 2022.
// This is the active Microsoft Research blog RSS with fresh AI content.
export default rssAdapter({
    id: 'microsoft',
    name: 'Microsoft AI',
    view: 'ai',
    category: 'AI Model Developers',
    rssUrl: 'https://www.microsoft.com/en-us/research/feed/',
});
