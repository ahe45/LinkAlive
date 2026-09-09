import { Body, Controller, Get, Inject, Post, Put, Req } from '@nestjs/common';
import { AdminOnly } from '../auth/admin-only.decorator.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { parseInput } from '../common/validation.js';
import { networkSettingsSchema, networkTestSchema } from './network.schemas.js';
import { NetworkService } from './network.service.js';

@Controller('network-settings')
@AdminOnly()
export class NetworkController {
  constructor(@Inject(NetworkService) private readonly network: NetworkService) {}
  @Get()
  get() {
    return this.network.get();
  }
  @Post('test')
  test(@Body() body: unknown) {
    return this.network.test(parseInput(networkTestSchema, body));
  }
  @Put()
  save(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.network.save(parseInput(networkSettingsSchema, body), request.user.id);
  }
}
