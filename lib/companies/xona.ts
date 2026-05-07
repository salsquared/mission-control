import { snapiAdapter } from './factories';
import { TTL_VERY_LOW } from './custom-fetchers';

export default snapiAdapter({
    id: 'xona',
    name: 'Xona Space Systems',
    view: 'space',
    category: 'Space Hardware',
    snapiQuery: 'Xona',
    ttlSeconds: TTL_VERY_LOW,
});
