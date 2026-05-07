import { snapiAdapter } from './factories';
import { TTL_VERY_LOW } from './custom-fetchers';

export default snapiAdapter({
    id: 'ursa-major',
    name: 'Ursa Major',
    view: 'space',
    category: 'Space Hardware',
    snapiQuery: 'Ursa Major',
    ttlSeconds: TTL_VERY_LOW,
});
