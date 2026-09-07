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
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly } from '../auth/admin-only.decorator.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { parseInput } from '../common/validation.js';
import {
  accountBulkCreateSchema,
  accountCreateSchema,
  accountPatchSchema,
} from './account.schemas.js';
import { AccountsService } from './accounts.service.js';

const idSchema = z.string().uuid('올바른 계정 ID가 아닙니다.');

@Controller('accounts')
@AdminOnly()
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Get()
  list() {
    return this.accounts.list();
  }

  @Post()
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.accounts.create(parseInput(accountCreateSchema, body), request.user.id);
  }

  @Post('bulk')
  bulkCreate(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.accounts.bulkCreate(parseInput(accountBulkCreateSchema, body), request.user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.accounts.update(
      parseInput(idSchema, id),
      parseInput(accountPatchSchema, body),
      request.user.id,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.accounts.remove(parseInput(idSchema, id), request.user.id);
  }
}
