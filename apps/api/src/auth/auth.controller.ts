import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { hashAccountPassword, prisma, verifyAccountPassword } from '@linkalive/database';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../common/config.js';
import { Public } from './public.decorator.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { createSessionToken } from './session.js';
import { SessionsService } from './sessions.service.js';

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Public()
  @Post('login')
  async login(
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const config = getConfig();
    const origin = request.headers.origin;
    if (origin && !config.webOrigins.includes(origin.replace(/\/$/, ''))) {
      throw new UnauthorizedException();
    }

    const body = loginSchema.safeParse(rawBody);
    if (!body.success) {
      throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.');
    }

    const account = await prisma.account.findUnique({ where: { username: body.data.username } });
    const passwordMatches = account
      ? await verifyAccountPassword(body.data.password, account.passwordHash)
      : (await hashAccountPassword(body.data.password), false);
    if (!account?.enabled || !passwordMatches) {
      throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.');
    }

    const session = await this.sessions.start(account.id, request);
    const absoluteTtlSeconds = config.sessionAbsoluteTimeoutHours * 60 * 60;

    reply.setCookie(
      config.authCookieName,
      createSessionToken(account.id, session.id, config.authSecret, absoluteTtlSeconds),
      {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'strict',
        path: '/',
        maxAge: absoluteTtlSeconds,
      },
    );
    return {
      user: { id: account.id, username: account.username, role: account.role },
      sessionPolicy: {
        idleTimeoutMinutes: config.sessionIdleTimeoutMinutes,
        absoluteTimeoutHours: config.sessionAbsoluteTimeoutHours,
      },
    };
  }

  @Post('logout')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const config = getConfig();
    await this.sessions.revokeCurrent(request.sessionId);
    reply.clearCookie(config.authCookieName, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    const config = getConfig();
    return {
      user: request.user,
      sessionPolicy: {
        idleTimeoutMinutes: config.sessionIdleTimeoutMinutes,
        absoluteTimeoutHours: config.sessionAbsoluteTimeoutHours,
      },
    };
  }
}
