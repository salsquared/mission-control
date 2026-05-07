import { rssAdapter } from './factories';

// Separate from DeepMind — this is Google Research blog
export default rssAdapter({
    id: 'google-ai',
    name: 'Google AI',
    view: 'ai',
    category: 'Fabless',
    rssUrl: 'https://research.google/blog/feed/',
});
