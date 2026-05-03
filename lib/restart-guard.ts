import fs from 'fs';
import path from 'path';

const FLAG_FILE = path.join(process.cwd(), '.restart-flag');

export function isRestartFlagSet(): boolean {
    return fs.existsSync(FLAG_FILE);
}

export function clearRestartFlag(): void {
    try {
        if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE);
    } catch { /* ignore if already gone */ }
}
