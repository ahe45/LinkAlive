import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  linkAlivePrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

/**
 * Process-wide client. The global cache prevents connection-pool multiplication
 * during development hot reloads; production still gets exactly one instance.
 */
export const prisma = globalForPrisma.linkAlivePrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.linkAlivePrisma = prisma;
}
