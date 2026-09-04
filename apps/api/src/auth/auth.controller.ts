import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../common/config.js';
import { Public } from './public.decorator.js';
import { createSessionToken, safeSecretEqual } from './session.js';

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
});

@Controller('auth')
export class AuthController {
  @Public()
  @Post('login')
  login(
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): { user: { username: string } } {
    const config = getConfig();
    const origin = request.headers.origin;
    if (origin && origin.replace(/\/$/, '') !== config.webOrigin) throw new UnauthorizedException();

    const body = loginSchema.safeParse(rawBody);
    if (
      !body.success ||
      !safeSecretEqual(body.data.username, config.adminUsername) ||
      !safeSecretEqual(body.data.password, config.adminPassword)
    ) {
      throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.');
    }

    reply.setCookie(
      config.authCookieName,
      createSessionToken(config.adminUsername, config.authSecret),
      {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'strict',
        path: '/',
        maxAge: 8 * 60 * 60,
      },
    );
    return { user: { username: config.adminUsername } };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) reply: FastifyReply): { ok: true } {
    const config = getConfig();
    reply.clearCookie(config.authCookieName, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(): { user: { username: string } } {
    return { user: { username: getConfig().adminUsername } };
  }
}
