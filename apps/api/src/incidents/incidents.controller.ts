import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { IncidentStatus } from '@linkalive/database';
import { z } from 'zod';
import { parseInput, parseLimit } from '../common/validation.js';
import { IncidentsService } from './incidents.service.js';

const idSchema = z.string().uuid('올바른 장애 ID가 아닙니다.');
const statusSchema = z.enum(['OPEN', 'RESOLVED', 'CANCELED']);

@Controller('incidents')
export class IncidentsController {
  constructor(@Inject(IncidentsService) private readonly incidents: IncidentsService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') rawStatus?: string,
  ) {
    const status = rawStatus ? (parseInput(statusSchema, rawStatus) as IncidentStatus) : undefined;
    return this.incidents.list(cursor, parseLimit(limit), status);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.incidents.get(parseInput(idSchema, id));
  }
}
