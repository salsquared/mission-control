import { customAdapter } from './factories';
import { fetchOpenAI } from './custom-fetchers';

export default customAdapter({
    id: 'openai',
    name: 'OpenAI',
    view: 'ai',
    category: 'AI Model Developers',
    fetcher: fetchOpenAI,
    upstreamHost: 'openai.com',
});
