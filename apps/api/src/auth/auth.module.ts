import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [AuthController, SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class AuthModule {}
