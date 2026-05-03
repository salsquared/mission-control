import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/prisma';

const TODO_FILE = path.join(process.cwd(), 'docs', 'todo.md');

// Set by this module before every programmatic write so the file watcher
// ignores the echo from our own write.
let _suppressNext = false;

export function suppressNextFileChange() {
    _suppressNext = true;
}

export function consumeSuppressFlag(): boolean {
    const val = _suppressNext;
    _suppressNext = false;
    return val;
}

const STATUS_CHAR: Record<string, string> = {
    IN_PROGRESS: '/',
    DONE: 'x',
    TODO: ' ',
};

const PRIORITY_ICON: Record<string, string> = {
    BLOCKER: '🔴',
    HIGH: '🟡',
    MEDIUM: '🔵',
    LOW: '🟢',
};

function renderTaskLine(task: {
    id: string;
    text: string;
    status: string;
    priority: string | null;
    dueDate: Date | null;
}, existingLine: string): string {
    const statusChar = STATUS_CHAR[task.status] ?? ' ';
    const indentMatch = existingLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    const priority = task.priority ? `${PRIORITY_ICON[task.priority] ?? ''} ` : '';
    const due = task.dueDate ? `@due(${task.dueDate.toISOString().split('T')[0]}) ` : '';

    return `${indent}- [${statusChar}] ${priority}${task.text} ${due}<!-- id: ${task.id} -->`.trimEnd();
}

export async function regenerateMarkdownFromDB(filePath = TODO_FILE): Promise<void> {
    suppressNextFileChange();

    const tasks = await prisma.task.findMany();
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');

    for (const task of tasks) {
        const idx = lines.findIndex(l => l.includes(`<!-- id: ${task.id} -->`));
        if (idx !== -1) {
            lines[idx] = renderTaskLine(task, lines[idx]);
        }
    }

    await fs.writeFile(filePath, lines.join('\n'));
}
