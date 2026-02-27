import { prisma } from '../../lib/prisma';
async function run() {
  try {
    const res = await prisma.selectedHistoricalPaper.findMany();
    console.log(res);
  } catch (e) {
    console.error(e);
  }
}
run();
