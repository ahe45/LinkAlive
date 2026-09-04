import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { prisma } from '@linkalive/database';
import { Public } from '../auth/public.decorator.js';
import { getRedis } from '../common/redis.js';

@Controller('health')
export class HealthController {
  @Public()
  @Get('live')
  live(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<{ status: 'ready'; timestamp: string }> {
    try {
      await Promise.all([prisma.$queryRaw`SELECT 1`, getRedis().ping()]);
      return { status: 'ready', timestamp: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException('데이터베이스 또는 작업 큐에 연결할 수 없습니다.');
    }
  }
}
