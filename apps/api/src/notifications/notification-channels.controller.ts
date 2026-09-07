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
} from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly } from '../auth/admin-only.decorator.js';
import { parseInput, parseLimit } from '../common/validation.js';
import {
  notificationChannelInputSchema,
  notificationChannelPatchSchema,
} from './notification.schemas.js';
import { NotificationChannelsService } from './notification-channels.service.js';

const idSchema = z.string().uuid('올바른 알림 채널 ID가 아닙니다.');

@Controller('notification-channels')
@AdminOnly()
export class NotificationChannelsController {
  constructor(
    @Inject(NotificationChannelsService) private readonly channels: NotificationChannelsService,
  ) {}

  @Get()
  list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.channels.list(cursor, parseLimit(limit));
  }

  @Post()
  create(@Body() body: unknown) {
    return this.channels.create(parseInput(notificationChannelInputSchema, body));
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.channels.update(
      parseInput(idSchema, id),
      parseInput(notificationChannelPatchSchema, body),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.channels.remove(parseInput(idSchema, id));
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.channels.test(parseInput(idSchema, id));
  }
}
