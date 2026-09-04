import { Module } from '@nestjs/common';
import { MonitorsController } from './monitors.controller.js';
import { MonitorsService } from './monitors.service.js';

@Module({ controllers: [MonitorsController], providers: [MonitorsService] })
export class MonitorsModule {}
