import * as fs from 'fs';
import * as path from 'path';

function removeEslint(dir: string) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory()) {
            if (!fullPath.includes('node_modules') && !fullPath.includes('.next') && !fullPath.includes('.git')) {
                removeEslint(fullPath);
            }
        } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            const originalContent = content;
            content = content.replace(/\/\* eslint-disable.*?\*\/\n?/g, '');
            if (content !== originalContent) {
                fs.writeFileSync(fullPath, content);
            }
        }
    }
}

removeEslint(process.cwd());
