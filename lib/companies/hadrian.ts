import { googleNewsAdapter } from './factories';
import { TTL_VERY_LOW } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'hadrian',
    name: 'Hadrian',
    view: 'space',
    category: 'Space Hardware',
    googleNewsQuery: 'Hadrian aerospace manufacturing',
    ttlSeconds: TTL_VERY_LOW,
});
