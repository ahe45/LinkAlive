import { Module } from '@nestjs/common';
import { NotificationChannelsController } from './notification-channels.controller.js';
import { NotificationChannelsService } from './notification-channels.service.js';

@Module({
  controllers: [NotificationChannelsController],
  providers: [NotificationChannelsService],
})
export class NotificationChannelsModule {}
