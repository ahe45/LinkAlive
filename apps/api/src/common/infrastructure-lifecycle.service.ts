import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { prisma } from '@linkalive/database';
import { closeRedis } from './redis.js';

@Injectable()
export class InfrastructureLifecycleService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    closeRedis();
    await prisma.$disconnect();
  }
}
