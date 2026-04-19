import fs from 'fs/promises';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';

interface ParsedTask {
    id: string;
    text: string;
    rawText: string;
    status: "TODO" | "IN_PROGRESS" | "DONE";
    priority: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW" | null;
    dueDate: Date | null;
    filePath: string;
    lineNumber: number;
    parentId: string | null;
    indentLevel: number;
    notes: string;
}

const taskRegex = /^(\s*)-\s+\[([ \/xX])\]\s+(.*)$/;
const idRegex = /<!--\s*id:\s*([a-zA-Z0-9-]+)\s*-->$/;
const priorityRegex = /(🔴|🟡|🔵|🟢)/;
const dueDateRegex = /@due\(([^)]+)\)/;

const priorityMap: Record<string, "BLOCKER" | "HIGH" | "MEDIUM" | "LOW"> = {
    '🔴': 'BLOCKER',
    '🟡': 'HIGH',
    '🔵': 'MEDIUM',
    '🟢': 'LOW'
};

const defaultPriorityTextRegex = /(🔴|🟡|🔵|🟢)(\s*\*\*[^*]+\*\*\s*-\s*)?/;

export async function syncTasksFromFile(filePath: string) {
    try {
        const fileData = await fs.readFile(filePath, 'utf8');
        const lines = fileData.split('\n');
        
        const tasks: ParsedTask[] = [];
        let fileModified = false;
        
        const indentStack: { id: string, indent: number }[] = [];
        const taskMap: Record<string, ParsedTask> = {};

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = taskRegex.exec(line);
            
            if (match) {
                const indentStr = match[1];
                const statusChar = match[2];
                const rawContent = match[3];
                
                const indentLevel = indentStr.length;
                
                // Determine Status
                let status: "TODO" | "IN_PROGRESS" | "DONE" = "TODO";
                if (statusChar === '/') status = "IN_PROGRESS";
                else if (statusChar.toLowerCase() === 'x') status = "DONE";
                
                // Determine ID
                let taskId = '';
                const idMatch = idRegex.exec(rawContent);
                let contentWithoutId = rawContent;
                if (idMatch) {
                    taskId = idMatch[1];
                    contentWithoutId = rawContent.replace(idRegex, '').trim();
                } else {
                    // Inject an ID
                    taskId = crypto.randomUUID();
                    lines[i] = `${line} <!-- id: ${taskId} -->`;
                    fileModified = true;
                    contentWithoutId = rawContent.trim();
                }
                
                // Determine Parent ID based on indentation stack
                while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= indentLevel) {
                    indentStack.pop();
                }
                const parentId = indentStack.length > 0 ? indentStack[indentStack.length - 1].id : null;
                
                // Push to stack
                indentStack.push({ id: taskId, indent: indentLevel });

                // Determine Priority
                let priority: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW" | null = null;
                const prioMatch = priorityRegex.exec(contentWithoutId);
                if (prioMatch && prioMatch[1] in priorityMap) {
                    priority = priorityMap[prioMatch[1]];
                } else if (parentId) {
                    priority = 'MEDIUM';
                    const checkboxMatch = /^(\s*-\s+\[[ \/xX]\]\s+)/.exec(lines[i]);
                    if (checkboxMatch) {
                        const prefix = checkboxMatch[1];
                        const remainder = lines[i].substring(prefix.length);
                        lines[i] = `${prefix}🔵 ${remainder}`;
                        fileModified = true;
                        contentWithoutId = `🔵 ${contentWithoutId}`;
                    }
                }
                
                // Determine Due Date
                let dueDate: Date | null = null;
                const dueMatch = dueDateRegex.exec(contentWithoutId);
                if (dueMatch) {
                    const parsedDate = new Date(dueMatch[1]);
                    if (!isNaN(parsedDate.getTime())) {
                        dueDate = parsedDate;
                    }
                }
                
                // Clean Text
                let cleanText = contentWithoutId;
                cleanText = cleanText.replace(defaultPriorityTextRegex, '');
                cleanText = cleanText.replace(dueDateRegex, '');
                cleanText = cleanText.replace(/<!--.*?-->/g, '').trim();
                
                const newTask: ParsedTask = {
                    id: taskId,
                    text: cleanText,
                    rawText: line,
                    status,
                    priority,
                    dueDate,
                    filePath,
                    lineNumber: i + 1, // 1-indexed
                    parentId,
                    indentLevel,
                    notes: ""
                };
                tasks.push(newTask);
                taskMap[taskId] = newTask;
            } else {
                const contentStr = line.trim();
                // ignore explicit standard hash headers, or completely empty spacing
                if (!contentStr || contentStr.startsWith('#')) continue;

                const indentMatch = /^(\s*)/.exec(line);
                const currentIndent = indentMatch ? indentMatch[1].length : 0;

                // Bind note to the deepest active task scope it overlaps with
                for (let j = indentStack.length - 1; j >= 0; j--) {
                    if (indentStack[j].indent < currentIndent) {
                        const targetId = indentStack[j].id;
                        if (taskMap[targetId]) {
                            taskMap[targetId].notes += (taskMap[targetId].notes ? '\n' : '') + contentStr;
                        }
                        break;
                    }
                }
            }
        }
        
        // If IDs were generated, flush back to file
        if (fileModified) {
            await fs.writeFile(filePath, lines.join('\n'));
        }
        
        const taskIds = tasks.map(t => t.id);
        
        // Batch database update
        await prisma.$transaction([
            // 1. Delete tasks that no longer exist in this file
            prisma.task.deleteMany({
                where: {
                    filePath,
                    id: { notIn: taskIds }
                }
            }),
            // 2. Upsert each parsed task
            ...tasks.map(t => prisma.task.upsert({
                where: { id: t.id },
                create: {
                    id: t.id,
                    text: t.text,
                    status: t.status,
                    priority: t.priority,
                    dueDate: t.dueDate,
                    filePath: t.filePath,
                    lineNumber: t.lineNumber,
                    parentId: t.parentId,
                    notes: t.notes || null
                },
                update: {
                    text: t.text,
                    status: t.status,
                    priority: t.priority,
                    dueDate: t.dueDate,
                    lineNumber: t.lineNumber,
                    parentId: t.parentId,
                    notes: t.notes || null
                }
            }))
        ]);
        
        return tasks;
        
    } catch (e) {
        console.error(`Error parsing tasks in ${filePath}:`, e);
        throw e;
    }
}
