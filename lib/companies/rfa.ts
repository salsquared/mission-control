import { snapiAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default snapiAdapter({
    id: 'rfa',
    name: 'Rocket Factory Augsburg',
    view: 'space',
    category: 'Upstart Launch Providers',
    snapiQuery: 'Rocket Factory',
    ttlSeconds: TTL_LOW_VOLUME,
});
