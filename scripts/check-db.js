const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const count = await prisma.cryptoPrice.count();
  const first = await prisma.cryptoPrice.findFirst({ orderBy: { timestamp: 'asc' } });
  const last = await prisma.cryptoPrice.findFirst({ orderBy: { timestamp: 'desc' } });
  console.log({ count, first, last });
}
main().finally(() => prisma.$disconnect());
