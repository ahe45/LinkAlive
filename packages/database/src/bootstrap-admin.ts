import { AccountRole } from '@prisma/client';
import { prisma } from './client.js';
import { hashAccountPassword } from './account-password.js';

async function main(): Promise<void> {
  const accountCount = await prisma.account.count();
  if (accountCount > 0) {
    process.stdout.write(
      `${JSON.stringify({ event: 'account.bootstrap.skipped', accountCount })}\n`,
    );
    return;
  }

  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'ADMIN_USERNAME and ADMIN_PASSWORD are required to bootstrap the first account.',
    );
  }
  if (password.length < 4) {
    throw new Error('ADMIN_PASSWORD must contain at least 4 characters.');
  }
  if (password === 'change-this-before-running') {
    throw new Error('ADMIN_PASSWORD must be changed from the example value.');
  }

  const account = await prisma.account.create({
    data: {
      username,
      passwordHash: await hashAccountPassword(password),
      role: AccountRole.ADMIN,
      enabled: true,
    },
    select: { id: true, username: true, role: true },
  });
  process.stdout.write(`${JSON.stringify({ event: 'account.bootstrap.created', account })}\n`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
