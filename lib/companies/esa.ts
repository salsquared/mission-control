import { rssAdapter } from './factories';

export default rssAdapter({
    id: 'esa',
    name: 'ESA',
    view: 'space',
    category: 'Government Agencies',
    rssUrl: 'https://www.esa.int/rssfeed/Our_Activities/Space_Science',
});
