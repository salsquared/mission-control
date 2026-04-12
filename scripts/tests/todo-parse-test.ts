import { syncTasksFromFile } from '../../lib/tasks/parser';
import path from 'path';

async function runTest() {
    // Requires path to be relative to project root since it relies on process.cwd()
    const defaultFile = path.join(process.cwd(), 'docs', 'todo.md');
    try {
        console.log("Starting parse test on: " + defaultFile);
        const tasks = await syncTasksFromFile(defaultFile);
        
        console.log(`Parsed ${tasks.length} tasks successfully.`);
        
        const inProgress = tasks.filter(t => t.status === 'IN_PROGRESS');
        console.log(`In Progress counts: ${inProgress.length}`);
        
        const blockers = tasks.filter(t => t.priority === 'BLOCKER');
        console.log(`Blocker counts: ${blockers.length}`);

        const withParents = tasks.filter(t => t.parentId !== null);
        console.log(`Tasks with parents (indented): ${withParents.length}`);
        
        const withDates = tasks.filter(t => t.dueDate !== null);
        console.log(`Tasks with due dates: ${withDates.length}`);
        
        console.log("Look at docs/todo.md to see if <!-- id: ... --> was injected cleanly!");
    } catch (e) {
        console.error("Test failed:", e);
    }
}

runTest();
