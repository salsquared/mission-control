const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
    const tasks = await prisma.task.findMany();
    console.log(tasks.filter(t => t.text.toLowerCase().includes('text') || t.text === ''));
}
main().catch(console.error).finally(() => prisma.$disconnect());
