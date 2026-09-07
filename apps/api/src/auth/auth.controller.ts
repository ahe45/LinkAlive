import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { hashAccountPassword, prisma, verifyAccountPassword } from '@linkalive/database';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../common/config.js';
import { Public } from './public.decorator.js';
import type { AuthenticatedRequest, AuthenticatedUser } from './auth.types.js';
import { createSessionToken } from './session.js';

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
});

@Controller('auth')
export class AuthController {
  @Public()
  @Post('login')
  async login(
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ user: AuthenticatedUser }> {
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

    await prisma.account.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() },
    });

    reply.setCookie(config.authCookieName, createSessionToken(account.id, config.authSecret), {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    return { user: { id: account.id, username: account.username, role: account.role } };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) reply: FastifyReply): { ok: true } {
    const config = getConfig();
    reply.clearCookie(config.authCookieName, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest): { user: AuthenticatedUser } {
    return { user: request.user };
  }
}
