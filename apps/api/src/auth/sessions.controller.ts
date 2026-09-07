import { Controller, Delete, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../common/config.js';
import { parseInput } from '../common/validation.js';
import { AdminOnly } from './admin-only.decorator.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { SessionsService } from './sessions.service.js';

const idSchema = z.string().uuid('올바른 세션 ID가 아닙니다.');

@Controller('sessions')
@AdminOnly()
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.sessions.listActive(request.sessionId);
  }

  @Delete(':id')
  revoke(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sessions.revokeOne(parseInput(idSchema, id), request.sessionId, request.user.id);
  }

  @Post('revoke-all')
  async revokeAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.sessions.revokeAll(request.user.id);
    reply.clearCookie(getConfig().authCookieName, { path: '/' });
    return result;
  }
}
