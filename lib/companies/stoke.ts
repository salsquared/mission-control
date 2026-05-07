import { snapiAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default snapiAdapter({
    id: 'stoke',
    name: 'Stoke Space',
    view: 'space',
    category: 'Upstart Launch Providers',
    snapiQuery: 'Stoke Space',
    ttlSeconds: TTL_LOW_VOLUME,
});
