import { snapiAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default snapiAdapter({
    id: 'firefly',
    name: 'Firefly Aerospace',
    view: 'space',
    category: 'Upstart Launch Providers',
    snapiQuery: 'Firefly Aerospace',
    ttlSeconds: TTL_LOW_VOLUME,
});
