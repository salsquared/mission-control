import { snapiAdapter } from './factories';
import { TTL_VERY_LOW } from './custom-fetchers';

export default snapiAdapter({
    id: 'apex',
    name: 'Apex Space',
    view: 'space',
    category: 'Space Hardware',
    snapiQuery: 'Apex Space',
    ttlSeconds: TTL_VERY_LOW,
});
