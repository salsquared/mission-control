import { snapiAdapter } from './factories';
import { TTL_VERY_LOW } from './custom-fetchers';

export default snapiAdapter({
    id: 'blue-canyon',
    name: 'Blue Canyon Technologies',
    view: 'space',
    category: 'Space Hardware',
    snapiQuery: 'Blue Canyon',
    ttlSeconds: TTL_VERY_LOW,
});
