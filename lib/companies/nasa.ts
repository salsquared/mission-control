import { rssAdapter } from './factories';

export default rssAdapter({
    id: 'nasa',
    name: 'NASA',
    view: 'space',
    category: 'Government Agencies',
    rssUrl: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',
});
