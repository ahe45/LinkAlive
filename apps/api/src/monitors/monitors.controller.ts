import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { parseInput, parseLimit } from '../common/validation.js';
import { monitorInputSchema, monitorPatchSchema } from './monitor.schemas.js';
import { MonitorsService } from './monitors.service.js';

const idSchema = z.string().uuid('올바른 모니터 ID가 아닙니다.');
const listStateSchema = z.enum([
  'UP',
  'SUSPECT',
  'DOWN',
  'RECOVERING',
  'PENDING',
  'PAUSED',
  'STALE',
]);
const listQuerySchema = z.string().trim().max(160, '검색어는 160자 이하여야 합니다.');

@Controller('monitors')
export class MonitorsController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('state') rawState?: string,
    @Query('query') rawQuery?: string,
  ) {
    const state = rawState === undefined ? undefined : parseInput(listStateSchema, rawState);
    const query = rawQuery === undefined ? undefined : parseInput(listQuerySchema, rawQuery);
    return this.monitors.list(cursor, parseLimit(limit), request.user, state, query);
  }

  @Post('test')
  test(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.monitors.test(parseInput(monitorInputSchema, body), request.user);
  }

  @Post()
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.monitors.create(parseInput(monitorInputSchema, body), request.user);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.monitors.get(parseInput(idSchema, id), request.user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.monitors.update(
      parseInput(idSchema, id),
      parseInput(monitorPatchSchema, body),
      request.user,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.monitors.remove(parseInput(idSchema, id), request.user);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.monitors.pause(parseInput(idSchema, id), request.user);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.monitors.resume(parseInput(idSchema, id), request.user);
  }

  @Post(':id/check-now')
  checkNow(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.monitors.checkNow(parseInput(idSchema, id), request.user);
  }

  @Get(':id/checks')
  checks(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.monitors.checks(parseInput(idSchema, id), cursor, parseLimit(limit));
  }

  @Get(':id/incidents')
  incidents(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.monitors.incidents(parseInput(idSchema, id), cursor, parseLimit(limit));
  }
}
