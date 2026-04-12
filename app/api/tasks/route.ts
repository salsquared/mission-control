import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { syncTasksFromFile } from '@/lib/tasks/parser';

// In-memory mutex for file writing
class Mutex {
    private mutex = Promise.resolve();
    lock(): Promise<() => void> {
        let begin: (unlock: () => void) => void = () => {};
        this.mutex = this.mutex.then(() => new Promise(begin));
        return new Promise(res => { begin = res; });
    }
}
const writeMutex = new Mutex();

let lastSyncedMtime = 0;
const DEFAULT_MD_FILE = path.join(process.cwd(), 'docs', 'todo.md');

export async function GET(req: Request) {
    try {
        const stats = await fs.stat(DEFAULT_MD_FILE).catch(() => null);
        if (stats) {
            if (stats.mtimeMs > lastSyncedMtime) {
                console.log(`[Tasks API] File modification detected. Syncing...`);
                await syncTasksFromFile(DEFAULT_MD_FILE);
                lastSyncedMtime = stats.mtimeMs;
                // Add a small buffer so subsequent reads triggered by our own writes aren't immediately re-synced if they finish in the same ms
                lastSyncedMtime += 100;
            }
        }
        
        const tasks = await prisma.task.findMany({
            orderBy: [{ lineNumber: 'asc' }]
        });
        
        return NextResponse.json({ tasks });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const unlock = await writeMutex.lock();
    try {
        const body = await req.json();
        const { id, status, text, dueDate, priority } = body;
        
        if (!id || (!status && text === undefined && dueDate === undefined && priority === undefined)) {
            return NextResponse.json({ error: "Missing id, status, text, dueDate, or priority" }, { status: 400 });
        }

        const task = await prisma.task.findUnique({ where: { id } });
        if (!task) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }

        // 1. Rewrite in File
        const fileContent = await fs.readFile(task.filePath, 'utf8');
        const lines = fileContent.split('\n');
        
        let targetIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`<!-- id: ${id} -->`)) {
                targetIndex = i;
                break;
            }
        }

        if (targetIndex !== -1) {
            let line = lines[targetIndex];
            
            // Extract old priority and dueDate to preserve them
            let oldPriority = '';
            let oldDueDate = '';
            let oldCleanText = '';
            
            const contentMatch = line.match(/(-\s+\[[ \/xX]\])(.*?)(<!--|$)/);
            if (contentMatch) {
                const prefix = contentMatch[1];
                const innerContent = contentMatch[2];
                const suffix = contentMatch[3] + line.substring(contentMatch[0].length);
                
                const prioMatch = innerContent.match(/(🔴|🟡|🔵|🟢)(\s*\*\*[^*]+\*\*\s*-\s*)?/);
                if (prioMatch) {
                    oldPriority = prioMatch[0].trim() + ' ';
                }
                
                const dueMatch = innerContent.match(/@due\(([^)]+)\)/);
                if (dueMatch) {
                    oldDueDate = `@due(${dueMatch[1]}) `;
                }
                
                oldCleanText = innerContent
                    .replace(/(🔴|🟡|🔵|🟢)(\s*\*\*[^*]+\*\*\s*-\s*)?/, '')
                    .replace(/@due\([^)]+\)/, '')
                    .trim();
                
                // Determine new parts
                let statusChar = contentMatch[1].match(/\[(.)\]/)?.[1] || ' ';
                if (status) {
                    if (status === 'IN_PROGRESS') statusChar = '/';
                    else if (status === 'DONE') statusChar = 'x';
                    else if (status === 'TODO') statusChar = ' ';
                }
                
                if (priority !== undefined) {
                    if (priority !== null) {
                        const iconMap: Record<string, string> = {
                            'BLOCKER': '🔴',
                            'HIGH': '🟡',
                            'MEDIUM': '🔵',
                            'LOW': '🟢'
                        };
                        oldPriority = `${iconMap[priority] || ''} `;
                    } else {
                        oldPriority = '';
                    }
                }
                
                const newPrefix = contentMatch[1].replace(/\[.\]/, `[${statusChar}]`);
                const newText = text !== undefined ? text.trim() : oldCleanText;
                const newDueDate = dueDate !== undefined ? (dueDate ? `@due(${dueDate}) ` : '') : oldDueDate;
                
                lines[targetIndex] = `${newPrefix} ${oldPriority}${newText} ${newDueDate}${suffix}`;
            }
            
            await fs.writeFile(task.filePath, lines.join('\n'));
            
            // Update the local tracker so the GET route doesn't redundantly re-sync from our write
            const updatedStats = await fs.stat(task.filePath);
            lastSyncedMtime = updatedStats.mtimeMs + 100;
        }

        // 2. Update DB manually for faster UI sync
        const updateData: any = {};
        if (status) updateData.status = status;
        if (text !== undefined) updateData.text = text;
        if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
        if (priority !== undefined) updateData.priority = priority;

        const updatedTask = await prisma.task.update({
            where: { id },
            data: updateData
        });

        return NextResponse.json({ task: updatedTask });
    } catch (e: any) {
        console.error("PATCH error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    } finally {
        unlock();
    }
}

export async function POST(req: Request) {
    const unlock = await writeMutex.lock();
    try {
        const body = await req.json();
        const { text, parentId, isGoal } = body;
        
        if (!text) {
            return NextResponse.json({ error: "Missing text" }, { status: 400 });
        }

        const fileContent = await fs.readFile(DEFAULT_MD_FILE, 'utf8');
        const lines = fileContent.split('\n');
        
        let targetLine = lines.length;
        let indent = "";
        
        if (parentId) {
             const parent = await prisma.task.findUnique({ where: { id: parentId } });
             if (parent) {
                 const pIndex = lines.findIndex(l => l.includes(`<!-- id: ${parent.id} -->`));
                 if (pIndex !== -1) {
                     targetLine = pIndex + 1;
                     const match = /^(\s*)/.exec(lines[pIndex]);
                     indent = (match ? match[1] : "") + "  ";
                 }
             }
        }
        
        const newId = crypto.randomUUID();
        const newTaskLine = `${indent}- [ ] ${text} <!-- id: ${newId} -->`;
        lines.splice(targetLine, 0, newTaskLine);
        
        if (isGoal) {
            // Add a default placeholder subtask to instantly classify it as a goal in the tracker
            const subId = crypto.randomUUID();
            lines.splice(targetLine + 1, 0, `  - [ ] Define action items for this goal <!-- id: ${subId} -->`);
        }

        await fs.writeFile(DEFAULT_MD_FILE, lines.join('\n'));
        const updatedStats = await fs.stat(DEFAULT_MD_FILE);
        lastSyncedMtime = updatedStats.mtimeMs + 100;
        
        // Sync the DB passively by triggering our parser or directly making the entry
        await syncTasksFromFile(DEFAULT_MD_FILE);

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("POST error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    } finally {
        unlock();
    }
}
