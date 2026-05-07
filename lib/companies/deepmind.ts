import { rssAdapter } from './factories';

export default rssAdapter({
    id: 'deepmind',
    name: 'Google DeepMind',
    view: 'ai',
    category: 'AI Model Developers',
    rssUrl: 'https://deepmind.google/blog/rss.xml',
});
