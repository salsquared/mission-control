import { rssAdapter } from './factories';

export default rssAdapter({
    id: 'redwire',
    name: 'Redwire',
    view: 'space',
    category: 'Space Hardware',
    rssUrl: 'https://rdw.com/feed/',
});
