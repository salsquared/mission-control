import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  try {
    await prisma.task.upsert({
      where: { id: "test" },
      create: {
        id: "test", text: "text", status: "TODO", filePath: "path", lineNumber: 1, parentId: null
      },
      update: { parentId: null }
    });
    console.log("Success upsert");
  } catch (e) {
    console.error(e);
  }
}
run();
