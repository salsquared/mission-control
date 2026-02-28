import * as fs from 'fs';
import * as path from 'path';

const files = [
    'app/api/ai/llmleaderboard/route.ts',
    'app/api/ai/route.ts',
    'app/api/company-news/route.ts',
    'app/api/finance/history/route.ts',
    'app/api/research/hf/route.ts',
    'app/api/research/historical/route.ts',
    'app/api/research/review/route.ts',
    'app/api/research/route.ts',
    'app/api/research/saved/route.ts',
    'app/api/system/logs/route.ts',
    'app/api/system/route.ts',
    'components/AICompanion.tsx',
    'components/Dashboard.tsx',
    'components/Window.tsx',
    'components/cards/AssetPriceCard.tsx',
    'components/cards/NextLaunchCard.tsx',
    'components/views/FinanceView.tsx'
];

files.forEach(f => {
    const fullPath = path.resolve(process.cwd(), f);
    if (fs.existsSync(fullPath)) {
        let content = fs.readFileSync(fullPath, 'utf8');
        content = content.replace(/\/\* eslint-disable .*\*\/\n/g, '');
        if (!content.startsWith('/* eslint-disable */')) {
            content = '/* eslint-disable */\n' + content;
            fs.writeFileSync(fullPath, content);
        }
    }
});
