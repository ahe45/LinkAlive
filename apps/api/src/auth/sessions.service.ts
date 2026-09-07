import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@linkalive/database';
import type { FastifyRequest } from 'fastify';
import { getConfig } from '../common/config.js';
import type { AuthenticatedUser } from './auth.types.js';
import type { SessionPayload } from './session.js';

const MAX_USER_AGENT_LENGTH = 512;

function sessionCutoff(now: Date): Date {
  return new Date(now.getTime() - getConfig().sessionIdleTimeoutMinutes * 60_000);
}

function requestMetadata(request: FastifyRequest): { ipAddress: string; userAgent: string | null } {
  const rawUserAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip.slice(0, 45),
    userAgent:
      typeof rawUserAgent === 'string' ? rawUserAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}

@Injectable()
export class SessionsService {
  async start(accountId: string, request: FastifyRequest) {
    const config = getConfig();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionAbsoluteTimeoutHours * 60 * 60_000);
    const metadata = requestMetadata(request);

    return prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: accountId }, data: { lastLoginAt: now } });
      return tx.loginSession.create({
        data: { accountId, expiresAt, lastSeenAt: now, ...metadata },
      });
    });
  }

  async authenticate(payload: SessionPayload): Promise<AuthenticatedUser | null> {
    const now = new Date();
    const session = await prisma.loginSession.findFirst({
      where: {
        id: payload.sid,
        accountId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: sessionCutoff(now) },
      },
      include: {
        account: { select: { id: true, username: true, role: true, enabled: true } },
      },
    });
    if (!session?.account.enabled) return null;

    await prisma.loginSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    return {
      id: session.account.id,
      username: session.account.username,
      role: session.account.role,
    };
  }

  async revokeCurrent(sessionId: string): Promise<void> {
    await prisma.loginSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listActive(currentSessionId: string) {
    const now = new Date();
    const idleTimeoutMs = getConfig().sessionIdleTimeoutMinutes * 60_000;
    const sessions = await prisma.loginSession.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: sessionCutoff(now) },
      },
      include: { account: { select: { id: true, username: true } } },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    });

    return {
      items: sessions.map((session) => ({
        id: session.id,
        accountId: session.account.id,
        username: session.account.username,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        idleExpiresAt: new Date(
          Math.min(session.expiresAt.getTime(), session.lastSeenAt.getTime() + idleTimeoutMs),
        ),
        current: session.id === currentSessionId,
      })),
    };
  }

  async revokeOne(sessionId: string, currentSessionId: string, actorId: string) {
    if (sessionId === currentSessionId) {
      throw new BadRequestException('현재 세션은 로그아웃 버튼으로 종료해 주세요.');
    }
    const session = await prisma.loginSession.findUnique({
      where: { id: sessionId },
      select: { id: true, accountId: true, revokedAt: true },
    });
    if (!session) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (session.revokedAt) return { revoked: 0 };

    await prisma.$transaction(async (tx) => {
      await tx.loginSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'LOGIN_SESSION_REVOKED',
          targetType: 'LoginSession',
          targetId: sessionId,
          metadataSafe: { accountId: session.accountId },
        },
      });
    });
    return { revoked: 1 };
  }

  async revokeAll(actorId: string) {
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const revoked = await tx.loginSession.updateMany({
        where: { revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'LOGIN_SESSIONS_REVOKED',
          targetType: 'LoginSession',
          targetId: 'all',
          metadataSafe: { count: revoked.count },
        },
      });
      return revoked;
    });
    return { revoked: result.count };
  }
}
