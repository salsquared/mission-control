/**
 * This script tests and logs the relative path generation between two given paths
 * ('app/api/finance/history' and 'lib/prisma.ts') using the built-in Node.js path module.
 */
const path = require('path');
console.log(path.relative('app/api/finance/history', 'lib/prisma.ts'));
