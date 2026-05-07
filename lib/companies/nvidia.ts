import { rssAdapter } from './factories';

export default rssAdapter({
    id: 'nvidia',
    name: 'Nvidia AI',
    view: 'ai',
    category: 'Fabless',
    rssUrl: 'https://blogs.nvidia.com/feed/',
});
