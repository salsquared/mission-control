import { rssAdapter } from './factories';

export default rssAdapter({
    id: 'amd',
    name: 'AMD',
    view: 'ai',
    category: 'Fabless',
    rssUrl: 'https://ir.amd.com/news-events/press-releases/rss',
});
